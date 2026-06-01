#!/usr/bin/env python3
"""Local WebSocket backend for real-time browser-to-Python ultrasonic sensing.

Run from the project root or webagent folder:

    python realtime_server.py

This standalone debug server receives raw Float32 microphone frames at
ws://127.0.0.1:8765 and returns JSON amplitude/phase/range features for live
plotting. The deployed app uses server.py's same-origin /realtime endpoint.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import struct
import time
from pathlib import Path
from typing import Any

import numpy as np

from realtime_iq import FS, StreamingIqProcessor


WEBAGENT_DIR = Path(__file__).resolve().parent
DEFAULT_TX = WEBAGENT_DIR / "triangle_fmcw_20-23kHz_20ms_48kHz_600s.wav"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


async def read_exact(reader: asyncio.StreamReader, n_bytes: int) -> bytes:
    data = await reader.readexactly(n_bytes)
    if len(data) != n_bytes:
        raise ConnectionError("Unexpected EOF")
    return data


async def read_http_headers(reader: asyncio.StreamReader) -> dict[str, str]:
    raw = await reader.readuntil(b"\r\n\r\n")
    text = raw.decode("latin1")
    lines = text.split("\r\n")
    headers: dict[str, str] = {"request-line": lines[0]}
    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()
    return headers


def websocket_accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


async def send_handshake(writer: asyncio.StreamWriter, headers: dict[str, str]) -> None:
    key = headers.get("sec-websocket-key")
    if not key:
        raise ConnectionError("Missing Sec-WebSocket-Key")
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {websocket_accept_key(key)}\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "\r\n"
    )
    writer.write(response.encode("ascii"))
    await writer.drain()


async def read_ws_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    first, second = await read_exact(reader, 2)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", await read_exact(reader, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await read_exact(reader, 8))[0]
    mask = await read_exact(reader, 4) if masked else b""
    payload = await read_exact(reader, length) if length else b""
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


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


async def send_json(writer: asyncio.StreamWriter, payload: dict[str, Any]) -> None:
    writer.write(encode_ws_frame(json.dumps(payload, separators=(",", ":")).encode("utf-8"), opcode=1))
    await writer.drain()


class RealtimeSession:
    def __init__(self, tx_path: Path) -> None:
        self.tx_path = tx_path
        self.processor: StreamingIqProcessor | None = None
        self.sample_rate = FS
        self.frame_count = 0
        self.started_at = time.time()

    def start(self, metadata: dict[str, Any]) -> dict[str, Any]:
        self.sample_rate = int(metadata.get("sample_rate") or metadata.get("sampleRate") or FS)
        start_epoch = float(metadata.get("timestamp") or time.time())
        self.processor = StreamingIqProcessor(self.tx_path, sample_rate=self.sample_rate)
        self.processor.reset(start_epoch=start_epoch)
        self.frame_count = 0
        self.started_at = start_epoch
        return {
            "type": "status",
            "status": "started",
            "sample_rate": self.sample_rate,
            "processing_sample_rate": FS,
            "resampling": self.sample_rate != FS,
            "tx": str(self.tx_path),
        }

    def stop(self) -> dict[str, Any]:
        chirps = self.processor.chirp_index if self.processor else 0
        self.processor = None
        return {
            "type": "status",
            "status": "stopped",
            "frames_received": self.frame_count,
            "chirps_processed": chirps,
        }

    def push_audio(self, payload: bytes) -> list[dict[str, Any]]:
        if self.processor is None:
            self.processor = StreamingIqProcessor(self.tx_path, sample_rate=self.sample_rate)
            self.processor.reset(start_epoch=self.started_at)
        if len(payload) % 4 != 0:
            return [{"type": "warning", "message": "Dropped non-Float32-aligned audio frame"}]
        samples = np.frombuffer(payload, dtype="<f4")
        self.frame_count += 1
        results = self.processor.push_samples(samples)
        if self.frame_count == 1 or self.frame_count % 25 == 0:
            chirps = self.processor.chirp_index if self.processor else 0
            results.insert(0, {
                "type": "status",
                "status": "frames",
                "frames_received": self.frame_count,
                "chirps_processed": chirps,
                "aligned": bool(self.processor and self.processor.aligned),
            })
        return results


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, tx_path: Path) -> None:
    peer = writer.get_extra_info("peername")
    session = RealtimeSession(tx_path)
    try:
        headers = await read_http_headers(reader)
        await send_handshake(writer, headers)
        await send_json(writer, {"type": "status", "status": "connected", "sample_rate": FS})
        print(f"Realtime client connected: {peer}")

        while True:
            opcode, payload = await read_ws_frame(reader)
            if opcode == 0x8:
                break
            if opcode == 0x9:
                writer.write(encode_ws_frame(payload, opcode=0xA))
                await writer.drain()
                continue
            if opcode == 0x1:
                try:
                    message = json.loads(payload.decode("utf-8"))
                except json.JSONDecodeError:
                    await send_json(writer, {"type": "error", "message": "Invalid JSON message"})
                    continue
                message_type = message.get("type")
                if message_type == "start":
                    await send_json(writer, session.start(message))
                elif message_type == "stop":
                    await send_json(writer, session.stop())
                elif message_type == "ping":
                    await send_json(writer, {"type": "pong", "timestamp": time.time()})
                else:
                    await send_json(writer, {"type": "warning", "message": f"Unknown message type: {message_type}"})
                continue
            if opcode == 0x2:
                for result in session.push_audio(payload):
                    await send_json(writer, result)
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    except Exception as exc:  # Keep the local server alive while surfacing diagnostics.
        print(f"Realtime client error {peer}: {exc}")
        try:
            await send_json(writer, {"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        writer.close()
        await writer.wait_closed()
        print(f"Realtime client disconnected: {peer}")


async def run_server(host: str, port: int, tx_path: Path) -> None:
    server = await asyncio.start_server(
        lambda reader, writer: handle_client(reader, writer, tx_path),
        host,
        port,
    )
    sockets = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
    print(f"Realtime WebSocket server listening on {sockets}")
    print("Open the website and start sensing to stream live amplitude/phase.")
    async with server:
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--tx", default=str(DEFAULT_TX))
    args = parser.parse_args()
    asyncio.run(run_server(args.host, args.port, Path(args.tx)))


if __name__ == "__main__":
    main()
