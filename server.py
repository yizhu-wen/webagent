from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime
from email.parser import BytesParser
from email.policy import default as email_default_policy
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid
from urllib.parse import urlparse


AUDIO_FILE_NAME = "triangle_fmcw_20-23kHz_20ms_48kHz_600s.wav"
WEBAGENT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = WEBAGENT_DIR.parent
AUDIO_FILE_PATH = WEBAGENT_DIR / AUDIO_FILE_NAME
UPLOAD_DIR = WEBAGENT_DIR / "uploads"
ANALYSIS_SCRIPT = PROJECT_DIR / "analyze_webagent_recording.py"
MAX_ANALYSIS_UPLOAD_BYTES = 120 * 1024 * 1024


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEBAGENT_DIR), **kwargs)

    def _send_json(self, status_code: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(data)

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
        if not ANALYSIS_SCRIPT.exists():
            self._send_json(500, {"ok": False, "error": f"Missing analysis script: {ANALYSIS_SCRIPT}"})
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
            str(ANALYSIS_SCRIPT),
            "--wav",
            str(wav_path),
            "--events",
            str(events_path),
            "--diagnostics",
            str(diagnostics_path),
            "--out-dir",
            str(figures_dir),
            "--figure-set",
            "input-amplitude-phase",
        ]

        try:
            completed = subprocess.run(
                cmd,
                cwd=str(PROJECT_DIR),
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

        figures = [
            {
                "name": path.name,
                "url": self._static_url_for(path),
            }
            for path in sorted(figures_dir.glob("*.png"))
        ]
        summary_path = figures_dir / "analysis_summary.json"
        features_path = figures_dir / "pipeline_features.npz"

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
                "stdout": completed.stdout[-4000:],
            },
        )


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", 8000), AppHandler)
    print("Server running at http://localhost:8000")
    server.serve_forever()


if __name__ == "__main__":
    main()
