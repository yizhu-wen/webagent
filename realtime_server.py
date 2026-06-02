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
import os
import struct
import time
from pathlib import Path
from typing import Any

import numpy as np

from realtime_iq import FS, StreamingIqProcessor


WEBAGENT_DIR = Path(__file__).resolve().parent
DEFAULT_TX = WEBAGENT_DIR / "triangle_fmcw_20-23kHz_20ms_48kHz_loop.wav"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
AUDIO_FRAME_MAGIC = b"WAIQ"
AUDIO_FRAME_HEADER = struct.Struct("<4sdII")
DEFAULT_MAX_FRAME_AGE_SECONDS = float(os.environ.get("REALTIME_MAX_FRAME_AGE_SECONDS", "1.0"))


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


async def read_ws_frame(reader: asyncio.StreamReader) -> tuple[bool, int, bytes]:
    first, second = await read_exact(reader, 2)
    fin = bool(first & 0x80)
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
    return fin, opcode, payload


class AsyncWebSocketMessageReader:
    def __init__(self, reader: asyncio.StreamReader) -> None:
        self.reader = reader
        self.pending_opcode: int | None = None
        self.pending_chunks: list[bytes] = []

    async def read_message(self) -> tuple[int, bytes]:
        while True:
            fin, opcode, payload = await read_ws_frame(self.reader)
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


async def send_json(writer: asyncio.StreamWriter, payload: dict[str, Any]) -> None:
    writer.write(encode_ws_frame(json.dumps(payload, separators=(",", ":")).encode("utf-8"), opcode=1))
    await writer.drain()


class RealtimeSession:
    def __init__(self, tx_path: Path) -> None:
        self.tx_path = tx_path
        self.processor: StreamingIqProcessor | None = None
        self.sample_rate = FS
        self.frame_count = 0
        self.processed_frame_count = 0
        self.dropped_stale_frames = 0
        self.dropped_gap_frames = 0
        self.last_sequence: int | None = None
        self.client_clock_offset = 0.0
        self.needs_realign = False
        self.latest_frame_age_seconds: float | None = None
        self.started_at = time.time()

    def start(self, metadata: dict[str, Any]) -> dict[str, Any]:
        self.sample_rate = int(metadata.get("sample_rate") or metadata.get("sampleRate") or FS)
        start_epoch = float(metadata.get("timestamp") or time.time())
        self.processor = StreamingIqProcessor(self.tx_path, sample_rate=self.sample_rate)
        self.processor.reset(start_epoch=start_epoch)
        self.frame_count = 0
        self.processed_frame_count = 0
        self.dropped_stale_frames = 0
        self.dropped_gap_frames = 0
        self.last_sequence = None
        self.client_clock_offset = time.time() - start_epoch
        self.needs_realign = False
        self.latest_frame_age_seconds = None
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
            "frames_processed": self.processed_frame_count,
            "dropped_stale_frames": self.dropped_stale_frames,
            "dropped_gap_frames": self.dropped_gap_frames,
            "chirps_processed": chirps,
        }

    def _parse_audio_payload(self, payload: bytes) -> tuple[np.ndarray | None, dict[str, Any]]:
        if payload.startswith(AUDIO_FRAME_MAGIC):
            if len(payload) < AUDIO_FRAME_HEADER.size:
                return None, {"warning": "Dropped short framed audio payload"}
            magic, timestamp, sequence, sample_count = AUDIO_FRAME_HEADER.unpack_from(payload)
            expected_length = AUDIO_FRAME_HEADER.size + sample_count * 4
            if magic != AUDIO_FRAME_MAGIC or len(payload) != expected_length:
                return None, {"warning": "Dropped malformed framed audio payload"}
            samples = np.frombuffer(payload, dtype="<f4", offset=AUDIO_FRAME_HEADER.size, count=sample_count)
            return samples, {
                "framed": True,
                "timestamp": float(timestamp),
                "sequence": int(sequence),
                "sample_count": int(sample_count),
            }

        if len(payload) % 4 != 0:
            return None, {"warning": "Dropped non-Float32-aligned audio frame"}
        return np.frombuffer(payload, dtype="<f4"), {"framed": False}

    def _reset_processor(self, start_epoch: float) -> None:
        if self.processor is None:
            self.processor = StreamingIqProcessor(self.tx_path, sample_rate=self.sample_rate)
        self.processor.reset(start_epoch=start_epoch)
        self.started_at = start_epoch
        self.needs_realign = False

    def _frame_age_seconds(self, frame_timestamp: float) -> float:
        estimated_server_frame_time = frame_timestamp + self.client_clock_offset
        return time.time() - estimated_server_frame_time

    def push_audio(self, payload: bytes) -> list[dict[str, Any]]:
        if self.processor is None:
            self.processor = StreamingIqProcessor(self.tx_path, sample_rate=self.sample_rate)
            self.processor.reset(start_epoch=self.started_at)

        self.frame_count += 1
        samples, frame_info = self._parse_audio_payload(payload)
        if samples is None:
            return [{"type": "warning", "message": frame_info["warning"]}]

        frame_timestamp = frame_info.get("timestamp")
        frame_sequence = frame_info.get("sequence")
        frame_age_seconds = None
        if frame_info.get("framed") and isinstance(frame_timestamp, float):
            frame_age_seconds = self._frame_age_seconds(frame_timestamp)
            self.latest_frame_age_seconds = frame_age_seconds
            if frame_age_seconds > DEFAULT_MAX_FRAME_AGE_SECONDS:
                self.dropped_stale_frames += 1
                self.needs_realign = True
                self.last_sequence = frame_sequence
                if self.frame_count == 1 or self.dropped_stale_frames % 25 == 0:
                    return [self._frame_status(aligned=False)]
                return []

            if self.processor.received_sample_count == 0 or self.needs_realign:
                self._reset_processor(frame_timestamp)
            elif isinstance(frame_sequence, int) and self.last_sequence is not None and frame_sequence > self.last_sequence + 1:
                self.dropped_gap_frames += frame_sequence - self.last_sequence - 1
                self._reset_processor(frame_timestamp)

            self.last_sequence = frame_sequence

        self.processed_frame_count += 1
        results = self.processor.push_samples(samples)
        if self.frame_count == 1 or self.frame_count % 25 == 0:
            results.insert(0, self._frame_status(aligned=bool(self.processor and self.processor.aligned)))
        return results

    def _frame_status(self, aligned: bool) -> dict[str, Any]:
        chirps = self.processor.chirp_index if self.processor else 0
        return {
            "type": "status",
            "status": "frames",
            "frames_received": self.frame_count,
            "frames_processed": self.processed_frame_count,
            "dropped_stale_frames": self.dropped_stale_frames,
            "dropped_gap_frames": self.dropped_gap_frames,
            "latest_frame_age_ms": (
                round(self.latest_frame_age_seconds * 1000, 1)
                if self.latest_frame_age_seconds is not None
                else None
            ),
            "chirps_processed": chirps,
            "aligned": aligned,
        }


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, tx_path: Path) -> None:
    peer = writer.get_extra_info("peername")
    session = RealtimeSession(tx_path)
    try:
        headers = await read_http_headers(reader)
        await send_handshake(writer, headers)
        await send_json(writer, {"type": "status", "status": "connected", "sample_rate": FS})
        print(f"Realtime client connected: {peer}")
        message_reader = AsyncWebSocketMessageReader(reader)

        while True:
            opcode, payload = await message_reader.read_message()
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
