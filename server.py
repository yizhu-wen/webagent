from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


AUDIO_FILE_NAME = "triangle_fmcw_20-24kHz_7ms_48kHz_10s.wav"
AUDIO_FILE_PATH = Path(__file__).resolve().parent / AUDIO_FILE_NAME


class AppHandler(SimpleHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/api/send-wav":
            self.send_error(404, "Not Found")
            return

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
        self.end_headers()

        with AUDIO_FILE_PATH.open("rb") as audio_file:
            self.wfile.write(audio_file.read())


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", 8000), AppHandler)
    print("Server running at http://localhost:8000")
    server.serve_forever()


if __name__ == "__main__":
    main()
