"""Train a neural network event recognizer from collected sensing recordings.

The dataset is expected to use the current project export layout:

    data/<label-folder>/recording_<timestamp>.wav
    data/<label-folder>/tracking_data_<timestamp>.json

The script crops the first and last second of each recording before extracting
windows, then trains an sklearn MLPClassifier on one of three feature sets:
ultrasound cross-correlation features ported from
``D:/research/human_agents_xcorr-main/process.py``, audible spectrogram
features, or both concatenated.
Splitting is done by recording session, not by individual window, so test
windows do not come from recordings seen during training.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from math import gcd
from pathlib import Path
from typing import Iterable

import joblib
import numpy as np
import soundfile as sf
from scipy.signal import butter, correlate, hilbert, resample_poly, sosfiltfilt, stft
from sklearn.decomposition import PCA
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import LabelEncoder, StandardScaler


SESSION_RE = re.compile(r"(\d{8}_\d{6})")

# Cross-correlation sensing constants ported from the referenced process.py
# pipeline/config.py. The model features are derived from this ultrasound
# matched-filter range-time representation, not from a broadband audio STFT.
FS = 48_000
LEFT_F0 = 19_000
LEFT_F1 = 20_500
RIGHT_F0 = 21_500
RIGHT_F1 = 23_000
FC = (LEFT_F0 + LEFT_F1 + RIGHT_F0 + RIGHT_F1) / 4
CHIRP_MS = 12.0
N_TRI = int(round(FS * CHIRP_MS / 1000.0))
FS_SLOW = FS / N_TRI
BP_LO = 18_700
BP_HI = 23_300
BP_ORDER = 6
SPEED_OF_SOUND = 343.0
RANGE_PER_SAMPLE_CM = SPEED_OF_SOUND / (2 * FS) * 100.0
R_MAX_CM = 50.0
N_LAGS = int(R_MAX_CM / RANGE_PER_SAMPLE_CM) + 1
N_TOP = 5
GATE_MIN_BIN = 2
EPS = 1e-9
FEATURE_SETS = ("ultrasound", "audible", "combined")
LABEL_SCHEMES = ("original", "interaction")

# Coarse interaction target kept alongside the original seven-class label.
# Body motion and hand waving are intentionally treated as background/no-user-
# interface interaction, as requested for the binary models.
INTERACTION_LABEL_BY_ORIGINAL = {
    "body_motion": "no_interaction",
    "click_tap": "interaction",
    "hand_wave": "no_interaction",
    "keydown": "interaction",
    "no_event": "no_interaction",
    "pointer_move": "interaction",
    "scroll": "interaction",
}

FOLDER_CONFIG = {
    "handwave": {
        "label": "hand_wave",
        "mode": "manual",
        "manual_label": "hand_wave",
    },
    "bodymotion": {
        "label": "body_motion",
        "mode": "manual",
        "manual_label": "body_motion",
    },
    "noevent": {
        "label": "no_event",
        "mode": "manual",
        "manual_label": "no_event",
    },
    "keydown": {
        "label": "keydown",
        "mode": "event",
        "event_names": ["keydown"],
    },
    "click-tap": {
        "label": "click_tap",
        "mode": "event",
        # One physical click/tap creates tap, tap_to_click, and click. Use the
        # inferred tap_to_click marker to avoid triplicating the same action.
        "event_names": ["tap_to_click"],
    },
    "pointermove": {
        "label": "pointer_move",
        "mode": "event",
        "event_names": ["pointer_move"],
    },
    "scroll": {
        "label": "scroll",
        "mode": "event",
        "event_names": ["wheel_swipe", "wheel_pinch"],
    },
}


@dataclass(frozen=True)
class FeatureConfig:
    window_seconds: float = 0.5
    stride_seconds: float = 0.25
    crop_start_seconds: float = 1.0
    crop_end_seconds: float = 1.0
    pooled_range_bins: int = 64
    pooled_time_bins: int = 25
    selected_range_bins: int = N_TOP
    audible_low_hz: float = 50.0
    audible_high_hz: float = 18_000.0
    audible_fft_size: int = 1024
    audible_hop_length: int = 480
    audible_freq_bins: int = 64
    audible_time_bins: int = 25
    min_window_seconds: float = 0.45


@dataclass
class RecordingFeatureState:
    C: np.ndarray | None
    dphi: np.ndarray | None
    top_bins: np.ndarray | None
    audible_samples: np.ndarray | None
    offset_seconds: float
    duration_seconds: float
    sample_rate: int


@dataclass
class WindowRecord:
    sample_id: str
    label: str
    interaction_label: str
    folder: str
    session_id: str
    wav_path: str
    tracking_path: str
    window_start_sec: float
    window_end_sec: float
    source: str
    target_event_count: int
    target_event_names: str
    split: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default="data", type=Path)
    parser.add_argument("--model-out", default="models/signal_event_model.joblib", type=Path)
    parser.add_argument("--manifest-out", default="models/window_manifest.csv", type=Path)
    parser.add_argument("--report-out", default="models/signal_event_report.json", type=Path)
    parser.add_argument("--feature-set", default="ultrasound", choices=FEATURE_SETS)
    parser.add_argument(
        "--label-scheme",
        default="original",
        choices=LABEL_SCHEMES,
        help="Train on the original seven labels or the binary interaction target.",
    )
    parser.add_argument("--window-seconds", default=0.5, type=float)
    parser.add_argument("--stride-seconds", default=0.25, type=float)
    parser.add_argument("--crop-start-seconds", default=1.0, type=float)
    parser.add_argument("--crop-end-seconds", default=1.0, type=float)
    parser.add_argument("--audible-low-hz", default=50.0, type=float)
    parser.add_argument("--audible-high-hz", default=18_000.0, type=float)
    parser.add_argument("--audible-freq-bins", default=64, type=int)
    parser.add_argument("--audible-time-bins", default=25, type=int)
    parser.add_argument("--test-sessions-per-label", default=2, type=int)
    parser.add_argument("--random-seed", default=42, type=int)
    return parser.parse_args()


def uses_ultrasound(feature_set: str) -> bool:
    return feature_set in {"ultrasound", "combined"}


def uses_audible(feature_set: str) -> bool:
    return feature_set in {"audible", "combined"}


def feature_extractor_name(feature_set: str) -> str:
    names = {
        "ultrasound": "ultrasound_xcorr_pooled_amplitude_phase_no_summary_stats",
        "audible": "audible_band_log_spectrogram",
        "combined": "combined_ultrasound_xcorr_and_audible_spectrogram",
    }
    return names[feature_set]


def feature_components(feature_set: str) -> list[str]:
    components = []
    if uses_ultrasound(feature_set):
        components.extend([
            "pooled_log_xcorr_amplitude",
            "pooled_inter_chirp_phase_change",
        ])
    if uses_audible(feature_set):
        components.append("pooled_audible_log_spectrogram")
    return components


def model_label(record: WindowRecord, label_scheme: str) -> str:
    if label_scheme == "original":
        return record.label
    if label_scheme == "interaction":
        return record.interaction_label
    raise ValueError(f"Unsupported label scheme: {label_scheme}")


def session_id_from_path(path: Path) -> str | None:
    match = SESSION_RE.search(path.name)
    return match.group(1) if match else None


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    samples, sample_rate = sf.read(path, dtype="float32", always_2d=False)
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    if int(sample_rate) != FS:
        common = gcd(int(sample_rate), FS)
        samples = resample_poly(samples, FS // common, int(sample_rate) // common)
        sample_rate = FS
    return np.asarray(samples, dtype=np.float32), int(sample_rate)


def event_time_seconds(event: dict, start_epoch: float) -> float | None:
    try:
        return float(event["epochSeconds"]) - start_epoch
    except (KeyError, TypeError, ValueError):
        return None


def collect_session_files(data_dir: Path) -> dict[str, dict[str, Path]]:
    sessions: dict[str, dict[str, Path]] = {}
    for folder in sorted(data_dir.iterdir()):
        if not folder.is_dir() or folder.name not in FOLDER_CONFIG:
            continue
        for path in sorted(folder.iterdir()):
            if not path.is_file():
                continue
            session_id = session_id_from_path(path)
            if not session_id:
                continue
            key = f"{folder.name}/{session_id}"
            sessions.setdefault(key, {"folder": folder})
            if path.name.startswith("recording_") and path.suffix.lower() == ".wav":
                sessions[key]["wav"] = path
            elif path.name.startswith("tracking_data_") and path.suffix.lower() == ".json":
                sessions[key]["tracking"] = path
            elif path.name.startswith("recording_diagnostics_") and path.suffix.lower() == ".json":
                sessions[key]["diagnostics"] = path
    return sessions


def sliding_starts(start_sec: float, end_sec: float, config: FeatureConfig) -> Iterable[float]:
    latest_start = end_sec - config.window_seconds
    if latest_start + 1e-9 < start_sec:
        return
    index = 0
    while True:
        window_start = start_sec + index * config.stride_seconds
        if window_start > latest_start + 1e-9:
            break
        yield round(window_start, 6)
        index += 1


def build_windows_for_session(
    session_key: str,
    files: dict[str, Path],
    config: FeatureConfig,
) -> tuple[list[WindowRecord], list[str]]:
    issues: list[str] = []
    if "wav" not in files or "tracking" not in files:
        return [], [f"{session_key}: missing wav or tracking file"]

    folder_name = files["folder"].name
    folder_config = FOLDER_CONFIG[folder_name]
    label = folder_config["label"]
    session_id = session_key.split("/", 1)[1]

    try:
        samples, sample_rate = read_audio(files["wav"])
        tracking = load_json(files["tracking"])
    except Exception as exc:  # pragma: no cover - reported in CLI output
        return [], [f"{session_key}: failed to load files: {exc}"]

    duration_sec = len(samples) / sample_rate
    if sample_rate != 48000:
        issues.append(f"{session_key}: sample_rate={sample_rate}; expected 48000")

    events = tracking.get("events") or []
    start_epoch = float(tracking.get("startEpochSeconds") or 0)
    records: list[WindowRecord] = []

    def add_window(window_start: float, source: str, target_events: list[str]) -> None:
        window_end = window_start + config.window_seconds
        if window_end - window_start < config.min_window_seconds:
            return
        sample_id = f"{folder_name}_{session_id}_{len(records):04d}"
        records.append(
            WindowRecord(
                sample_id=sample_id,
                label=label,
                interaction_label=INTERACTION_LABEL_BY_ORIGINAL[label],
                folder=folder_name,
                session_id=session_id,
                wav_path=str(files["wav"]),
                tracking_path=str(files["tracking"]),
                window_start_sec=window_start,
                window_end_sec=window_end,
                source=source,
                target_event_count=len(target_events),
                target_event_names=";".join(sorted(set(target_events))),
            )
        )

    if folder_config["mode"] == "manual":
        expected_label = folder_config["manual_label"]
        starts = [
            event
            for event in events
            if event.get("name") == "manual_label_start"
            and (event.get("properties") or {}).get("collectionLabel") == expected_label
        ]
        ends = [
            event
            for event in events
            if event.get("name") == "manual_label_end"
            and (event.get("properties") or {}).get("collectionLabel") == expected_label
        ]
        if not starts or not ends:
            return [], [f"{session_key}: missing manual interval for {expected_label}"]
        interval_start = event_time_seconds(starts[0], start_epoch)
        interval_end = event_time_seconds(ends[-1], start_epoch)
        if interval_start is None or interval_end is None:
            return [], [f"{session_key}: invalid manual interval times"]
        usable_start = max(interval_start + config.crop_start_seconds, 0)
        usable_end = min(interval_end - config.crop_end_seconds, duration_sec)
        for window_start in sliding_starts(usable_start, usable_end, config):
            add_window(window_start, "manual_interval", [expected_label])
    else:
        target_names = set(folder_config["event_names"])
        target_event_times: list[tuple[float, str]] = []
        for event in events:
            name = event.get("name")
            if name not in target_names:
                continue
            event_time = event_time_seconds(event, start_epoch)
            if event_time is None:
                continue
            if config.crop_start_seconds <= event_time <= duration_sec - config.crop_end_seconds:
                target_event_times.append((event_time, str(name)))
        if not target_event_times:
            return [], [f"{session_key}: no target events after edge crop"]

        usable_start = config.crop_start_seconds
        usable_end = duration_sec - config.crop_end_seconds
        for window_start in sliding_starts(usable_start, usable_end, config):
            window_end = window_start + config.window_seconds
            target_events = [
                name for event_time, name in target_event_times if window_start <= event_time < window_end
            ]
            if target_events:
                add_window(window_start, "event_window", target_events)

    if not records:
        issues.append(f"{session_key}: no windows generated")
    return records, issues


def average_pool(matrix: np.ndarray, out_rows: int, out_cols: int) -> np.ndarray:
    row_splits = np.array_split(np.arange(matrix.shape[0]), out_rows)
    col_splits = np.array_split(np.arange(matrix.shape[1]), out_cols)
    output = np.empty((out_rows, out_cols), dtype=np.float32)
    for row_index, rows in enumerate(row_splits):
        for col_index, cols in enumerate(col_splits):
            output[row_index, col_index] = matrix[np.ix_(rows, cols)].mean()
    return output


def synth_reference_chirp() -> tuple[np.ndarray, np.ndarray]:
    def one_band(f0: float, f1: float) -> np.ndarray:
        half = N_TRI // 2
        up = np.linspace(f0, f1, half, endpoint=False)
        down = np.linspace(f1, f0, N_TRI - half, endpoint=False)
        phase = 2 * np.pi * np.cumsum(np.concatenate([up, down])) / FS
        return np.sin(phase)

    # Approximate the mono microphone reference by averaging the distinct
    # chirps emitted by the left and right speakers.
    tx_real = 0.5 * (
        one_band(LEFT_F0, LEFT_F1)
        + one_band(RIGHT_F0, RIGHT_F1)
    )
    return tx_real, hilbert(tx_real)


def bandpass_rx(samples: np.ndarray) -> np.ndarray:
    sos = butter(BP_ORDER, [BP_LO, BP_HI], btype="bandpass", fs=FS, output="sos")
    return sosfiltfilt(sos, np.asarray(samples, dtype=np.float64))


def bandpass_audible(samples: np.ndarray, config: FeatureConfig) -> np.ndarray:
    low_hz = max(float(config.audible_low_hz), 1.0)
    high_hz = min(float(config.audible_high_hz), FS / 2 - 100.0)
    if low_hz >= high_hz:
        raise ValueError(f"Invalid audible band: {low_hz} Hz to {high_hz} Hz")
    sos = butter(4, [low_hz, high_hz], btype="bandpass", fs=FS, output="sos")
    return sosfiltfilt(sos, np.asarray(samples, dtype=np.float64))


def find_chirp_offset(rx_bandpassed: np.ndarray, tx_real: np.ndarray) -> int:
    search_len = min(len(rx_bandpassed), N_TRI * 20)
    segment = rx_bandpassed[:search_len]
    corr = correlate(segment, tx_real, mode="same")
    return max(int(np.argmax(np.abs(corr)) - N_TRI // 2), 0)


def frame_chirps(signal: np.ndarray, offset: int) -> np.ndarray:
    framed = signal[offset:]
    n_chirps = len(framed) // N_TRI
    framed = framed[: n_chirps * N_TRI]
    return framed.reshape(n_chirps, N_TRI).T


def build_ref_bank(tx_analytic: np.ndarray) -> np.ndarray:
    bank = np.zeros((N_LAGS, N_TRI), dtype=np.complex128)
    for lag in range(N_LAGS):
        ref = np.zeros(N_TRI, dtype=np.complex128)
        ref[lag:] = tx_analytic[: N_TRI - lag]
        bank[lag] = ref / (np.sqrt(np.sum(np.abs(ref) ** 2)) + 1e-30)
    return bank


def select_top_bins(C: np.ndarray, k: int = N_TOP) -> np.ndarray:
    variance = np.var(np.abs(C), axis=1)
    eligible = np.arange(GATE_MIN_BIN, len(variance))
    return eligible[np.argsort(variance[eligible])[-k:][::-1]]


def compute_delta_phase(C: np.ndarray) -> np.ndarray:
    dphi = np.zeros(C.shape, dtype=np.float64)
    dphi[:, 1:] = np.angle(C[:, 1:] * np.conj(C[:, :-1]))
    return dphi


def compute_recording_features(
    samples: np.ndarray,
    sample_rate: int,
    config: FeatureConfig,
    feature_set: str = "ultrasound",
) -> RecordingFeatureState:
    if sample_rate != FS:
        raise ValueError(f"Expected {FS} Hz after resampling, got {sample_rate}")

    C = None
    dphi = None
    top_bins = None
    audible_samples = None
    offset = 0

    if uses_ultrasound(feature_set):
        tx_real, tx_analytic = synth_reference_chirp()
        rx_bandpassed = bandpass_rx(samples)
        rx_analytic = hilbert(rx_bandpassed)
        offset = find_chirp_offset(rx_bandpassed, tx_real)
        rx_frames = frame_chirps(rx_analytic, offset)
        ref_bank = build_ref_bank(tx_analytic)
        C = np.conj(ref_bank) @ rx_frames
        dphi = compute_delta_phase(C)
        top_bins = select_top_bins(C, k=config.selected_range_bins)

    if uses_audible(feature_set):
        audible_samples = bandpass_audible(samples, config)

    return RecordingFeatureState(
        C=C,
        dphi=dphi,
        top_bins=top_bins,
        audible_samples=audible_samples,
        offset_seconds=offset / FS,
        duration_seconds=len(samples) / sample_rate,
        sample_rate=sample_rate,
    )


def window_matrix(matrix: np.ndarray, start_frame: int, frame_count: int) -> np.ndarray:
    output = np.zeros((matrix.shape[0], frame_count), dtype=matrix.dtype)
    source_start = max(start_frame, 0)
    source_end = min(start_frame + frame_count, matrix.shape[1])
    if source_end <= source_start:
        return output
    dest_start = source_start - start_frame
    output[:, dest_start : dest_start + (source_end - source_start)] = matrix[:, source_start:source_end]
    return output


def window_audio(samples: np.ndarray, start_sec: float, config: FeatureConfig) -> np.ndarray:
    window_samples = max(1, int(round(config.window_seconds * FS)))
    start_sample = int(round(start_sec * FS))
    output = np.zeros(window_samples, dtype=np.float64)
    source_start = max(start_sample, 0)
    source_end = min(start_sample + window_samples, len(samples))
    if source_end <= source_start:
        return output
    dest_start = source_start - start_sample
    output[dest_start : dest_start + (source_end - source_start)] = samples[source_start:source_end]
    return output


def extract_ultrasound_features(
    recording_features: RecordingFeatureState,
    window_start_sec: float,
    config: FeatureConfig,
) -> np.ndarray:
    if recording_features.C is None or recording_features.dphi is None:
        raise ValueError("Ultrasound features were requested but were not computed.")
    frame_count = max(1, int(round(config.window_seconds * FS_SLOW)))
    start_frame = int(round((window_start_sec - recording_features.offset_seconds) * FS_SLOW))
    C_window = window_matrix(recording_features.C, start_frame, frame_count)
    dphi_window = window_matrix(recording_features.dphi, start_frame, frame_count)

    amplitude_db = 20 * np.log10(np.abs(C_window) + EPS)
    phase_change = np.asarray(dphi_window, dtype=np.float64)

    pooled_amp = average_pool(
        amplitude_db,
        config.pooled_range_bins,
        config.pooled_time_bins,
    )
    pooled_phase = average_pool(
        phase_change,
        config.pooled_range_bins,
        config.pooled_time_bins,
    )

    return np.concatenate([
        pooled_amp.astype(np.float32).ravel(),
        pooled_phase.astype(np.float32).ravel(),
    ])


def extract_audible_features(
    recording_features: RecordingFeatureState,
    window_start_sec: float,
    config: FeatureConfig,
) -> np.ndarray:
    if recording_features.audible_samples is None:
        raise ValueError("Audible features were requested but were not computed.")
    segment = window_audio(recording_features.audible_samples, window_start_sec, config)
    nperseg = min(config.audible_fft_size, len(segment))
    noverlap = max(0, nperseg - config.audible_hop_length)
    frequencies, _times, spectrum = stft(
        segment,
        fs=FS,
        window="hann",
        nperseg=nperseg,
        noverlap=noverlap,
        nfft=config.audible_fft_size,
        boundary=None,
        padded=False,
    )
    mask = (frequencies >= config.audible_low_hz) & (frequencies <= config.audible_high_hz)
    audible_log = 20 * np.log10(np.abs(spectrum[mask]) + EPS)
    pooled = average_pool(
        audible_log,
        config.audible_freq_bins,
        config.audible_time_bins,
    )
    return pooled.astype(np.float32).ravel()


def extract_features(
    recording_features: RecordingFeatureState,
    window_start_sec: float,
    config: FeatureConfig,
    feature_set: str = "ultrasound",
) -> np.ndarray:
    parts = []
    if uses_ultrasound(feature_set):
        parts.append(extract_ultrasound_features(recording_features, window_start_sec, config))
    if uses_audible(feature_set):
        parts.append(extract_audible_features(recording_features, window_start_sec, config))
    return np.concatenate(parts)


def materialize_dataset(
    records: list[WindowRecord],
    config: FeatureConfig,
    feature_set: str = "ultrasound",
    label_scheme: str = "original",
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[WindowRecord]]:
    feature_cache: dict[str, RecordingFeatureState] = {}
    features = []
    labels = []
    sessions = []
    kept_records = []

    for record in records:
        if record.wav_path not in feature_cache:
            samples, sample_rate = read_audio(Path(record.wav_path))
            feature_cache[record.wav_path] = compute_recording_features(
                samples,
                sample_rate,
                config,
                feature_set,
            )
        recording_features = feature_cache[record.wav_path]
        duration = recording_features.duration_seconds
        if record.window_end_sec > duration + 1e-6:
            continue
        features.append(extract_features(recording_features, record.window_start_sec, config, feature_set))
        labels.append(model_label(record, label_scheme))
        sessions.append(f"{record.folder}/{record.session_id}")
        kept_records.append(record)

    return (
        np.asarray(features, dtype=np.float32),
        np.asarray(labels),
        np.asarray(sessions),
        kept_records,
    )


def assign_splits(
    records: list[WindowRecord],
    labels: np.ndarray,
    sessions: np.ndarray,
    test_sessions_per_label: int,
    random_seed: int,
) -> np.ndarray:
    rng = np.random.default_rng(random_seed)
    label_to_sessions: dict[str, list[str]] = defaultdict(list)
    for label in sorted(set(labels)):
        label_sessions = sorted(set(sessions[labels == label]))
        rng.shuffle(label_sessions)
        label_to_sessions[label] = label_sessions

    test_sessions = set()
    for label, label_sessions in label_to_sessions.items():
        count = min(max(1, test_sessions_per_label), max(1, len(label_sessions) - 1))
        test_sessions.update(label_sessions[:count])

    splits = np.asarray(["test" if session in test_sessions else "train" for session in sessions])
    for record, split in zip(records, splits):
        record.split = str(split)
    return splits


def save_manifest(path: Path, records: list[WindowRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        fieldnames = list(asdict(records[0]).keys()) if records else list(WindowRecord.__dataclass_fields__)
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for record in records:
            writer.writerow(asdict(record))


def main() -> None:
    args = parse_args()
    config = FeatureConfig(
        window_seconds=args.window_seconds,
        stride_seconds=args.stride_seconds,
        crop_start_seconds=args.crop_start_seconds,
        crop_end_seconds=args.crop_end_seconds,
        audible_low_hz=args.audible_low_hz,
        audible_high_hz=args.audible_high_hz,
        audible_freq_bins=args.audible_freq_bins,
        audible_time_bins=args.audible_time_bins,
    )

    sessions = collect_session_files(args.data_dir)
    all_records: list[WindowRecord] = []
    issues: list[str] = []
    for session_key, files in sorted(sessions.items()):
        records, session_issues = build_windows_for_session(session_key, files, config)
        all_records.extend(records)
        issues.extend(session_issues)

    if not all_records:
        raise SystemExit("No training windows were generated.")

    x, y_text, session_ids, records = materialize_dataset(
        all_records,
        config,
        args.feature_set,
        args.label_scheme,
    )
    original_labels = np.asarray([record.label for record in records])
    splits = assign_splits(
        records,
        original_labels,
        session_ids,
        test_sessions_per_label=args.test_sessions_per_label,
        random_seed=args.random_seed,
    )

    encoder = LabelEncoder()
    y = encoder.fit_transform(y_text)
    train_mask = splits == "train"
    test_mask = splits == "test"

    pca_components = min(96, max(8, int(train_mask.sum()) - len(encoder.classes_) - 1), x.shape[1])
    pipeline = Pipeline(
        steps=[
            ("scaler", StandardScaler()),
            ("pca", PCA(n_components=pca_components, random_state=args.random_seed, whiten=True)),
            (
                "mlp",
                MLPClassifier(
                    hidden_layer_sizes=(96, 48),
                    activation="relu",
                    solver="adam",
                    alpha=1e-3,
                    batch_size=64,
                    learning_rate_init=1e-3,
                    max_iter=500,
                    early_stopping=True,
                    validation_fraction=0.2,
                    n_iter_no_change=25,
                    random_state=args.random_seed,
                ),
            ),
        ]
    )
    pipeline.fit(x[train_mask], y[train_mask])

    train_pred = pipeline.predict(x[train_mask])
    test_pred = pipeline.predict(x[test_mask])
    class_names = list(encoder.classes_)
    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "dataDir": str(args.data_dir),
        "modelOut": str(args.model_out),
        "manifestOut": str(args.manifest_out),
        "featureSet": args.feature_set,
        "labelScheme": args.label_scheme,
        "interactionLabelByOriginal": INTERACTION_LABEL_BY_ORIGINAL,
        "splitStratification": "original_label",
        "featureExtractor": feature_extractor_name(args.feature_set),
        "featureComponents": feature_components(args.feature_set),
        "featureConfig": asdict(config),
        "folderConfig": FOLDER_CONFIG,
        "classNames": class_names,
        "sessionCount": len(set(session_ids)),
        "windowCount": int(len(records)),
        "windowCountsByLabel": dict(Counter(y_text)),
        "trainWindowCountsByLabel": dict(Counter(y_text[train_mask])),
        "testWindowCountsByLabel": dict(Counter(y_text[test_mask])),
        "trainSessions": sorted(set(session_ids[train_mask])),
        "testSessions": sorted(set(session_ids[test_mask])),
        "featureCount": int(x.shape[1]),
        "pcaComponents": int(pca_components),
        "mlpIterations": int(pipeline.named_steps["mlp"].n_iter_),
        "trainAccuracy": float(accuracy_score(y[train_mask], train_pred)),
        "testAccuracy": float(accuracy_score(y[test_mask], test_pred)),
        "classificationReport": classification_report(
            y[test_mask],
            test_pred,
            labels=np.arange(len(class_names)),
            target_names=class_names,
            output_dict=True,
            zero_division=0,
        ),
        "confusionMatrix": confusion_matrix(
            y[test_mask],
            test_pred,
            labels=np.arange(len(class_names)),
        ).tolist(),
        "issues": issues,
    }

    artifact = {
        "pipeline": pipeline,
        "labelEncoder": encoder,
        "classNames": class_names,
        "featureConfig": asdict(config),
        "folderConfig": FOLDER_CONFIG,
        "featureSet": args.feature_set,
        "labelScheme": args.label_scheme,
        "interactionLabelByOriginal": INTERACTION_LABEL_BY_ORIGINAL,
        "splitStratification": "original_label",
        "featureExtractor": feature_extractor_name(args.feature_set),
        "featureComponents": feature_components(args.feature_set),
        "sampleRate": FS,
        "xcorrConfig": {
            "chirpMs": CHIRP_MS,
            "chirpSamples": N_TRI,
            "leftBandHz": [LEFT_F0, LEFT_F1],
            "rightBandHz": [RIGHT_F0, RIGHT_F1],
            "slowRateHz": FS_SLOW,
            "bandpassHz": [BP_LO, BP_HI],
            "rangeMaxCm": R_MAX_CM,
            "rangeBins": N_LAGS,
            "topBins": N_TOP,
        },
        "audibleConfig": {
            "bandpassHz": [config.audible_low_hz, config.audible_high_hz],
            "fftSize": config.audible_fft_size,
            "hopLength": config.audible_hop_length,
            "pooledBins": [config.audible_freq_bins, config.audible_time_bins],
        },
    }

    args.model_out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(artifact, args.model_out)
    save_manifest(args.manifest_out, records)
    args.report_out.parent.mkdir(parents=True, exist_ok=True)
    args.report_out.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"Generated {len(records)} windows from {len(set(session_ids))} sessions.")
    print(f"Feature set: {args.feature_set}")
    print(f"Label scheme: {args.label_scheme}")
    print(f"Classes: {', '.join(class_names)}")
    print(f"Train accuracy: {report['trainAccuracy']:.3f}")
    print(f"Test accuracy: {report['testAccuracy']:.3f}")
    print(f"Saved model: {args.model_out}")
    print(f"Saved manifest: {args.manifest_out}")
    print(f"Saved report: {args.report_out}")
    if issues:
        print("Issues:")
        for issue in issues:
            print(f"  - {issue}")


if __name__ == "__main__":
    main()
