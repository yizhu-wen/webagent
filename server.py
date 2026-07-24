from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime
from email.parser import BytesParser
from email.policy import default as email_default_policy
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import struct
import sys
import time
import uuid
from urllib.parse import urlparse


AUDIO_FILE_NAME = "tx_dual_triangle_chirp_19_205_215_23.wav"
WEBAGENT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = WEBAGENT_DIR.parent
AUDIO_FILE_PATH = WEBAGENT_DIR / AUDIO_FILE_NAME
UPLOAD_DIR = WEBAGENT_DIR / "uploads"
ANALYSIS_SCRIPT_NAME = "analyze_webagent_recording.py"
ANALYSIS_SCRIPT_CANDIDATES = (
    WEBAGENT_DIR / ANALYSIS_SCRIPT_NAME,
    PROJECT_DIR / ANALYSIS_SCRIPT_NAME,
)
MAX_ANALYSIS_UPLOAD_BYTES = 120 * 1024 * 1024
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def websocket_accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def read_exact(reader, n_bytes: int) -> bytes:
    data = reader.read(n_bytes)
    if len(data) != n_bytes:
        raise ConnectionError("Unexpected WebSocket EOF")
    return data


def read_ws_frame(reader) -> tuple[bool, int, bytes]:
    first, second = read_exact(reader, 2)
    fin = bool(first & 0x80)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", read_exact(reader, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", read_exact(reader, 8))[0]
    mask = read_exact(reader, 4) if masked else b""
    payload = read_exact(reader, length) if length else b""
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return fin, opcode, payload


class WebSocketMessageReader:
    def __init__(self, reader) -> None:
        self.reader = reader
        self.pending_opcode: int | None = None
        self.pending_chunks: list[bytes] = []

    def read_message(self) -> tuple[int, bytes]:
        while True:
            fin, opcode, payload = read_ws_frame(self.reader)
            if opcode in {0x8, 0x9, 0xA}:
                return opcode, payload
            if opcode in {0x1, 0x2}:
                if self.pending_opcode is not None:
                    raise ConnectionError("Unexpected new WebSocket message before continuation completed")
                self.pending_opcode = opcode
                self.pending_chunks = [payload]
            elif opcode == 0x0:
                if self.pending_opcode is None:
                    raise ConnectionError("Unexpected WebSocket continuation frame")
                self.pending_chunks.append(payload)
            else:
                raise ConnectionError(f"Unsupported WebSocket opcode: {opcode}")

            if fin:
                complete_opcode = self.pending_opcode
                complete_payload = b"".join(self.pending_chunks)
                self.pending_opcode = None
                self.pending_chunks = []
                if complete_opcode is None:
                    raise ConnectionError("Missing WebSocket message opcode")
                return complete_opcode, complete_payload


def encode_ws_frame(payload: bytes, opcode: int = 1) -> bytes:
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.extend([126, *struct.pack("!H", length)])
    else:
        header.extend([127, *struct.pack("!Q", length)])
    return bytes(header) + payload


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEBAGENT_DIR), **kwargs)

    def end_headers(self) -> None:
        # Force revalidation so edited HTML/JS/CSS is picked up on reload
        # instead of being served stale from the browser cache.
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def _send_json(self, status_code: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(data)

    def _send_health(self, include_body: bool = True) -> None:
        data = b'{"ok":true}\n'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if include_body:
            self.wfile.write(data)

    def do_GET(self) -> None:
        parsed_path = urlparse(self.path).path
        if parsed_path == "/healthz":
            self._send_health()
            return
        if parsed_path == "/realtime":
            self._handle_realtime_websocket()
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        if urlparse(self.path).path == "/healthz":
            self._send_health(include_body=False)
            return
        super().do_HEAD()

    def do_OPTIONS(self) -> None:
        parsed_path = urlparse(self.path).path
        if parsed_path not in {"/api/send-wav", "/api/upload-recording", "/api/analyze-recording"}:
            self.send_error(404, "Not Found")
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self) -> None:
        parsed_path = urlparse(self.path).path
        if parsed_path == "/api/send-wav":
            self._handle_send_wav()
            return
        if parsed_path == "/api/upload-recording":
            self._handle_upload_recording()
            return
        if parsed_path == "/api/analyze-recording":
            self._handle_analyze_recording()
            return

        self.send_error(404, "Not Found")

    def _handle_send_wav(self) -> None:
        if not AUDIO_FILE_PATH.exists():
            self.send_error(404, f"Missing audio file: {AUDIO_FILE_NAME}")
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(AUDIO_FILE_PATH.stat().st_size))
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{AUDIO_FILE_NAME}"',
        )
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        with AUDIO_FILE_PATH.open("rb") as audio_file:
            self.wfile.write(audio_file.read())

    def _handle_upload_recording(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            self._send_json(400, {"ok": False, "error": "Empty request body"})
            return

        content_type = self.headers.get("Content-Type", "").lower()
        extension = ".webm"
        if "audio/wav" in content_type or "audio/wave" in content_type:
            extension = ".wav"
        elif "audio/ogg" in content_type:
            extension = ".ogg"
        elif "audio/mp4" in content_type:
            extension = ".m4a"

        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        file_name = f"recording_{datetime.utcnow().strftime('%Y%m%d_%H%M%S_%f')}{extension}"
        file_path = UPLOAD_DIR / file_name
        file_bytes = self.rfile.read(content_length)
        file_path.write_bytes(file_bytes)

        self._send_json(
            200,
            {"ok": True, "saved_as": file_name, "bytes": len(file_bytes)},
        )

    def _safe_slug(self, value: str, fallback: str) -> str:
        slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value or "").strip(".-")
        return slug[:80] or fallback

    def _parse_multipart_fields(self, body: bytes, content_type: str) -> dict:
        message = BytesParser(policy=email_default_policy).parsebytes(
            (
                f"Content-Type: {content_type}\r\n"
                "MIME-Version: 1.0\r\n\r\n"
            ).encode("utf-8") + body
        )
        fields = {}
        if not message.is_multipart():
            return fields
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if not name:
                continue
            fields[name] = {
                "filename": part.get_filename() or "",
                "content_type": part.get_content_type(),
                "data": part.get_payload(decode=True) or b"",
            }
        return fields

    def _field_text(self, fields: dict, name: str, default: str = "") -> str:
        if name not in fields:
            return default
        return fields[name]["data"].decode("utf-8", errors="replace")

    def _field_bytes(self, fields: dict, name: str) -> bytes:
        return fields.get(name, {}).get("data", b"")

    def _static_url_for(self, path: Path) -> str:
        relative = path.resolve().relative_to(WEBAGENT_DIR.resolve())
        return "/" + relative.as_posix()

    def _send_ws_json(self, payload: dict) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.wfile.write(encode_ws_frame(data, opcode=1))
        self.wfile.flush()

    def _handle_realtime_websocket(self) -> None:
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self.send_error(426, "WebSocket Upgrade Required")
            return

        client_key = self.headers.get("Sec-WebSocket-Key")
        if not client_key:
            self.send_error(400, "Missing Sec-WebSocket-Key")
            return

        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {websocket_accept_key(client_key)}\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "\r\n"
        )
        self.request.sendall(response.encode("ascii"))
        self.close_connection = True

        from realtime_iq import FS
        from realtime_server import DEFAULT_TX, RealtimeSession

        tx_path = Path(os.environ.get("REALTIME_TX", str(DEFAULT_TX)))
        session = RealtimeSession(tx_path)
        message_reader = WebSocketMessageReader(self.rfile)
        peer = self.client_address
        print(f"Realtime WebSocket client connected: {peer}")

        try:
            self._send_ws_json({"type": "status", "status": "connected", "sample_rate": FS})
            while True:
                opcode, payload = message_reader.read_message()
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    self.wfile.write(encode_ws_frame(payload, opcode=0xA))
                    self.wfile.flush()
                    continue
                if opcode == 0x1:
                    try:
                        message = json.loads(payload.decode("utf-8"))
                    except json.JSONDecodeError:
                        self._send_ws_json({"type": "error", "message": "Invalid JSON message"})
                        continue
                    message_type = message.get("type")
                    if message_type == "start":
                        self._send_ws_json(session.start(message))
                    elif message_type == "stop":
                        self._send_ws_json(session.stop())
                    elif message_type == "ping":
                        self._send_ws_json({"type": "pong", "timestamp": time.time()})
                    else:
                        self._send_ws_json({"type": "warning", "message": f"Unknown message type: {message_type}"})
                    continue
                if opcode == 0x2:
                    for result in session.push_audio(payload):
                        self._send_ws_json(result)
        except (ConnectionError, OSError):
            pass
        except Exception as exc:
            print(f"Realtime WebSocket error {peer}: {exc}", file=sys.stderr)
            try:
                self._send_ws_json({"type": "error", "message": str(exc)})
            except Exception:
                pass
        finally:
            print(f"Realtime WebSocket client disconnected: {peer}")

    def _handle_analyze_recording(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            self._send_json(400, {"ok": False, "error": "Empty request body"})
            return
        if content_length > MAX_ANALYSIS_UPLOAD_BYTES:
            self._send_json(413, {"ok": False, "error": "Recording upload is too large"})
            return

        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type.lower():
            self._send_json(415, {"ok": False, "error": "Expected multipart/form-data"})
            return
        analysis_script = next((path for path in ANALYSIS_SCRIPT_CANDIDATES if path.exists()), ANALYSIS_SCRIPT_CANDIDATES[0])
        if not analysis_script.exists():
            candidates = ", ".join(str(path) for path in ANALYSIS_SCRIPT_CANDIDATES)
            self._send_json(500, {"ok": False, "error": f"Missing analysis script. Checked: {candidates}"})
            return

        body = self.rfile.read(content_length)
        fields = self._parse_multipart_fields(body, content_type)

        timestamp = self._safe_slug(
            self._field_text(fields, "timestamp", datetime.utcnow().strftime("%Y%m%d_%H%M%S")),
            "session",
        )
        prefix = self._safe_slug(self._field_text(fields, "prefix", "webagent_recording"), "webagent_recording")
        session_slug = self._safe_slug(f"{prefix}_{timestamp}_{uuid.uuid4().hex[:8]}", "webagent_session")
        session_dir = UPLOAD_DIR / session_slug
        figures_dir = session_dir / "figures"
        session_dir.mkdir(parents=True, exist_ok=True)
        figures_dir.mkdir(parents=True, exist_ok=True)

        wav_bytes = self._field_bytes(fields, "recording")
        events_bytes = self._field_bytes(fields, "events")
        diagnostics_bytes = self._field_bytes(fields, "diagnostics")
        if not wav_bytes:
            self._send_json(400, {"ok": False, "error": "Missing recording WAV"})
            return
        if not events_bytes:
            self._send_json(400, {"ok": False, "error": "Missing OS event log"})
            return

        wav_path = session_dir / f"{prefix}_{timestamp}.wav"
        events_path = session_dir / f"os_event_log_{timestamp}.txt"
        diagnostics_path = session_dir / f"{prefix}_diagnostics_{timestamp}.json"
        wav_path.write_bytes(wav_bytes)
        events_path.write_bytes(events_bytes)
        if diagnostics_bytes:
            diagnostics_path.write_bytes(diagnostics_bytes)
        else:
            diagnostics_path.write_text("{}", encoding="utf-8")

        cmd = [
            sys.executable,
            str(analysis_script),
            "--wav",
            str(wav_path),
            "--events",
            str(events_path),
            "--diagnostics",
            str(diagnostics_path),
            "--out-dir",
            str(figures_dir),
            "--figure-set",
            "feature-visualizations",
        ]

        try:
            completed = subprocess.run(
                cmd,
                cwd=str(analysis_script.parent),
                text=True,
                capture_output=True,
                timeout=180,
                check=False,
            )
        except subprocess.TimeoutExpired:
            self._send_json(504, {"ok": False, "error": "Figure generation timed out"})
            return

        if completed.returncode != 0:
            self._send_json(
                500,
                {
                    "ok": False,
                    "error": "Figure generation failed. Make sure scipy, soundfile, and matplotlib are installed.",
                    "stdout": completed.stdout[-4000:],
                    "stderr": completed.stderr[-4000:],
                },
            )
            return

        summary_path = figures_dir / "analysis_summary.json"
        summary_payload = {}
        if summary_path.exists():
            try:
                summary_payload = json.loads(summary_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                summary_payload = {}
        figure_descriptions = summary_payload.get("figures") or {}
        figures = [
            {
                "name": path.name,
                "url": self._static_url_for(path),
                "description": str(figure_descriptions.get(path.name) or ""),
            }
            for path in sorted(figures_dir.glob("*.png"))
        ]
        features_path = figures_dir / "pipeline_features.npz"
        predictions_path = figures_dir / "window_predictions.json"
        predictions_payload = None
        if predictions_path.exists():
            try:
                predictions_payload = json.loads(predictions_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                predictions_payload = None

        self._send_json(
            200,
            {
                "ok": True,
                "session": session_slug,
                "figures": figures,
                "summary": {
                    "name": summary_path.name,
                    "url": self._static_url_for(summary_path),
                } if summary_path.exists() else None,
                "features": {
                    "name": features_path.name,
                    "url": self._static_url_for(features_path),
                } if features_path.exists() else None,
                "predictions": {
                    "name": predictions_path.name,
                    "url": self._static_url_for(predictions_path),
                    **predictions_payload,
                } if predictions_payload else None,
                "stdout": completed.stdout[-4000:],
            },
        )


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), AppHandler)
    print(f"Server running at http://localhost:{port}")
    print(f"Realtime IQ WebSocket available at ws://localhost:{port}/realtime")
    server.serve_forever()


if __name__ == "__main__":
    main()
