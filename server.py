from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from email.parser import BytesParser
from email.policy import default
from datetime import datetime
import json
from pathlib import Path
from urllib.parse import urlparse


AUDIO_FILE_NAME = "triangle_fmcw_20-24kHz_7ms_48kHz_10s.wav"
AUDIO_FILE_PATH = Path(__file__).resolve().parent / AUDIO_FILE_NAME
UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"


class AppHandler(SimpleHTTPRequestHandler):
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
        if parsed_path not in {"/api/send-wav", "/api/upload-recording"}:
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

        raw_body = self.rfile.read(content_length)
        content_type = self.headers.get("Content-Type", "").lower()

        file_bytes = raw_body
        extension = self._extension_from_content_type(content_type)

        if "multipart/form-data" in content_type:
            parsed_file = self._extract_uploaded_file(raw_body)
            if parsed_file is None:
                self._send_json(400, {"ok": False, "error": "Missing uploaded file"})
                return
            file_bytes, filename, part_content_type = parsed_file
            extension = Path(filename).suffix or self._extension_from_content_type(part_content_type)

        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        file_name = f"recording_{datetime.utcnow().strftime('%Y%m%d_%H%M%S_%f')}{extension}"
        file_path = UPLOAD_DIR / file_name
        file_path.write_bytes(file_bytes)

        self._send_json(
            200,
            {"ok": True, "saved_as": file_name, "bytes": len(file_bytes)},
        )

    @staticmethod
    def _extension_from_content_type(content_type: str) -> str:
        if "audio/wav" in content_type or "audio/wave" in content_type:
            return ".wav"
        if "audio/ogg" in content_type:
            return ".ogg"
        if "audio/mp4" in content_type or "audio/x-m4a" in content_type:
            return ".m4a"
        if "audio/mpeg" in content_type:
            return ".mp3"
        return ".webm"

    def _extract_uploaded_file(self, raw_body: bytes):
        header_block = (
            f"Content-Type: {self.headers.get('Content-Type', '')}\r\n"
            "MIME-Version: 1.0\r\n\r\n"
        ).encode("utf-8")
        message = BytesParser(policy=default).parsebytes(header_block + raw_body)
        if not message.is_multipart():
            return None

        for part in message.iter_parts():
            if part.get_content_disposition() != "form-data":
                continue
            payload = part.get_payload(decode=True) or b""
            filename = part.get_filename() or "recording"
            part_content_type = (part.get_content_type() or "").lower()
            return payload, filename, part_content_type

        return None


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", 8000), AppHandler)
    print("Server running at http://localhost:8000")
    server.serve_forever()


if __name__ == "__main__":
    main()
