"""Dual-band ultrasonic matched-filter features and Stage-4 traces.

This module mirrors the feature path used by ``extract_feature_maps_demo.py``:

    mono audio -> left/right band split -> analytic chirp frames
        -> normalized matched filtering -> amplitude/phase change maps
        -> top-10 variable bins -> mean trace -> median normalization

The batch functions use zero-phase filtering and are intended for completed
recordings. ``matched_filter_frame`` and ``calculate_change_vectors`` expose the
same per-chirp math for the causal realtime processor.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, correlate, hilbert, sosfiltfilt


FS = 48_000
CHIRP_DURATION = 0.012
CHIRP_SAMPLES = 576

LEFT_F0 = 19_000
LEFT_F1 = 20_500
RIGHT_F0 = 21_500
RIGHT_F1 = 23_000

RX_LEFT_BAND = (18_800, 20_700)
RX_RIGHT_BAND = (21_300, 23_200)
FILTER_ORDER = 6

MAX_LAG = 280
LAGS = np.arange(MAX_LAG + 1)
START_TRIM_SEC = 3.0
TOP_K = 10
RANGE_PER_SAMPLE_CM = 343.0 / (2 * FS) * 100.0
EPS = 1e-12
NORMALIZATION_EPS = 1e-8


def _to_float(samples: np.ndarray) -> np.ndarray:
    if np.issubdtype(samples.dtype, np.floating):
        return samples.astype(np.float64)
    info = np.iinfo(samples.dtype)
    return samples.astype(np.float64) / max(abs(info.min), info.max)


def load_wav(wav_path: str | Path) -> tuple[np.ndarray, int]:
    fs, samples = wavfile.read(Path(wav_path))
    samples = _to_float(np.asarray(samples))
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    if samples.ndim != 1:
        raise ValueError(f"Expected mono or stereo WAV data, got {samples.shape}")
    if fs != FS:
        raise ValueError(f"Expected a {FS} Hz recording, got {fs} Hz")
    return samples, fs


def bandpass(
    samples: np.ndarray,
    low_hz: float,
    high_hz: float,
    fs: int = FS,
    order: int = FILTER_ORDER,
) -> np.ndarray:
    sos = butter(order, [low_hz, high_hz], btype="band", fs=fs, output="sos")
    return sosfiltfilt(sos, samples)


def split_bands(samples: np.ndarray, fs: int = FS) -> tuple[np.ndarray, np.ndarray]:
    return (
        bandpass(samples, *RX_LEFT_BAND, fs=fs),
        bandpass(samples, *RX_RIGHT_BAND, fs=fs),
    )


def triangle_instantaneous_frequency(
    f0: float,
    f1: float,
    sample_count: int = CHIRP_SAMPLES,
) -> np.ndarray:
    half = sample_count // 2
    up = np.linspace(f0, f1, half, endpoint=False)
    down = np.linspace(f1, f0, sample_count - half, endpoint=False)
    return np.concatenate([up, down])


def reference_chirp(f0: float, f1: float) -> np.ndarray:
    frequency = triangle_instantaneous_frequency(f0, f1)
    phase = np.cumsum(2.0 * np.pi * frequency / FS)
    return np.sin(phase)


def reference_chirps_analytic() -> tuple[np.ndarray, np.ndarray]:
    return (
        hilbert(reference_chirp(LEFT_F0, LEFT_F1)),
        hilbert(reference_chirp(RIGHT_F0, RIGHT_F1)),
    )


def align_chirps(
    received_analytic: np.ndarray,
    reference_analytic: np.ndarray,
    chirp_samples: int = CHIRP_SAMPLES,
) -> tuple[np.ndarray, int]:
    correlation = np.abs(correlate(received_analytic, reference_analytic, mode="valid"))
    offset = int(np.argmax(correlation)) % chirp_samples
    frame_count = (len(received_analytic) - offset) // chirp_samples
    starts = offset + np.arange(frame_count) * chirp_samples
    return starts, offset


def frame_signal(
    received_analytic: np.ndarray,
    starts: np.ndarray,
    chirp_samples: int = CHIRP_SAMPLES,
) -> np.ndarray:
    starts = np.asarray(starts, dtype=int)
    starts = starts[starts + chirp_samples <= len(received_analytic)]
    if len(starts) == 0:
        raise ValueError("The recording does not contain one complete chirp frame")
    return np.stack([received_analytic[start : start + chirp_samples] for start in starts])


def matched_filter(
    frames: np.ndarray,
    reference_analytic: np.ndarray,
    lags: np.ndarray = LAGS,
) -> np.ndarray:
    """Return normalized complex correlation as [lag, chirp]."""
    chirp_samples = frames.shape[1]
    complex_map = np.zeros((len(lags), frames.shape[0]), dtype=np.complex128)
    for row, lag in enumerate(lags):
        received_segment = frames[:, lag:]
        reference_segment = reference_analytic[: chirp_samples - lag]
        numerator = received_segment @ np.conj(reference_segment)
        received_energy = np.sum(np.abs(received_segment) ** 2, axis=1)
        reference_energy = np.sum(np.abs(reference_segment) ** 2)
        complex_map[row] = numerator / np.sqrt(
            received_energy * reference_energy + EPS
        )
    return complex_map


def matched_filter_frame(
    frame: np.ndarray,
    reference_analytic: np.ndarray,
    lags: np.ndarray = LAGS,
) -> np.ndarray:
    """Realtime equivalent of ``matched_filter`` for one analytic chirp."""
    frame = np.asarray(frame, dtype=np.complex128)
    reference_analytic = np.asarray(reference_analytic, dtype=np.complex128)
    sample_count = len(frame)
    if len(reference_analytic) != sample_count:
        raise ValueError("Frame and reference must have the same length")
    if int(np.max(lags)) >= sample_count:
        raise ValueError("Lag exceeds the chirp frame length")

    full_correlation = np.correlate(frame, reference_analytic, mode="full")
    numerator = full_correlation[sample_count - 1 + lags]
    received_tail_energy = np.cumsum(np.abs(frame[::-1]) ** 2)[::-1][lags]
    reference_prefix_energy = np.cumsum(np.abs(reference_analytic) ** 2)[
        sample_count - 1 - lags
    ]
    return numerator / np.sqrt(
        received_tail_energy * reference_prefix_energy + EPS
    )


def calculate_feature_map(complex_map: np.ndarray, feature: str) -> np.ndarray:
    feature = feature.strip().lower().replace("_", " ")
    if feature in {"amplitude", "amplitude change"}:
        return np.abs(np.diff(np.abs(complex_map), axis=1))
    if feature in {"phase", "phase change"}:
        return np.abs(np.angle(complex_map[:, 1:] * np.conj(complex_map[:, :-1])))
    raise ValueError("feature must be 'amplitude' or 'phase'")


def calculate_change_vectors(
    previous_map: np.ndarray,
    current_map: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Return amplitude-change and absolute wrapped phase-change vectors."""
    amplitude_change = np.abs(np.abs(current_map) - np.abs(previous_map))
    phase_change = np.abs(np.angle(current_map * np.conj(previous_map)))
    return amplitude_change, phase_change


def select_most_variable_bins(
    feature_map: np.ndarray,
    top_k: int = TOP_K,
) -> np.ndarray:
    """Select the reference script's no-event fallback lag bins."""
    feature_map = np.asarray(feature_map, dtype=np.float64)
    if feature_map.ndim != 2:
        raise ValueError(
            f"Expected a [lag, time] feature map, got {feature_map.shape}"
        )
    if not 1 <= top_k <= feature_map.shape[0]:
        raise ValueError(
            f"top_k must be between 1 and {feature_map.shape[0]}, got {top_k}"
        )
    return np.sort(np.argsort(feature_map.std(axis=1))[::-1][:top_k])


def aggregate_and_normalize(
    feature_map: np.ndarray,
    top_k: int = TOP_K,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Average the most-variable bins and divide by the full-trace median."""
    feature_map = np.asarray(feature_map, dtype=np.float64)
    selected_bins = select_most_variable_bins(feature_map, top_k=top_k)
    raw_trace = np.mean(feature_map[selected_bins], axis=0)
    quiet_median = float(np.median(raw_trace))
    normalized_trace = raw_trace / (quiet_median + NORMALIZATION_EPS)
    return normalized_trace, selected_bins, quiet_median


def extract_complex_range_maps(
    samples: np.ndarray,
    sample_rate: int = FS,
    start_trim_sec: float = START_TRIM_SEC,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if sample_rate != FS:
        raise ValueError(f"Expected {FS} Hz audio, got {sample_rate} Hz")
    received_left, received_right = split_bands(np.asarray(samples, dtype=np.float64), sample_rate)
    reference_left, reference_right = reference_chirps_analytic()
    received_left_analytic = hilbert(received_left)
    received_right_analytic = hilbert(received_right)

    starts_left, _ = align_chirps(received_left_analytic, reference_left)
    starts_right, _ = align_chirps(received_right_analytic, reference_right)
    complex_left = matched_filter(
        frame_signal(received_left_analytic, starts_left), reference_left
    )
    complex_right = matched_filter(
        frame_signal(received_right_analytic, starts_right), reference_right
    )

    common_frames = min(complex_left.shape[1], complex_right.shape[1])
    chirp_time = starts_left[0] / FS + np.arange(common_frames) * CHIRP_DURATION
    keep = chirp_time >= start_trim_sec
    if not np.any(keep):
        raise ValueError(
            f"No chirps remain after trimming the first {start_trim_sec:g} seconds"
        )
    complex_left = complex_left[:, :common_frames][:, keep]
    complex_right = complex_right[:, :common_frames][:, keep]
    chirp_time = chirp_time[keep]
    if complex_left.shape[1] < 2:
        raise ValueError("At least two retained chirps are required for a change map")
    return complex_left, complex_right, chirp_time


def extract_all_feature_maps(
    samples: np.ndarray,
    sample_rate: int = FS,
    start_trim_sec: float = START_TRIM_SEC,
) -> dict[str, np.ndarray]:
    complex_left, complex_right, chirp_time = extract_complex_range_maps(
        samples,
        sample_rate=sample_rate,
        start_trim_sec=start_trim_sec,
    )
    return {
        "amplitude_left": calculate_feature_map(complex_left, "amplitude"),
        "amplitude_right": calculate_feature_map(complex_right, "amplitude"),
        "phase_left": calculate_feature_map(complex_left, "phase"),
        "phase_right": calculate_feature_map(complex_right, "phase"),
        "time": chirp_time[1:],
        "lags": LAGS.copy(),
    }


def extract_stage4_traces(
    samples: np.ndarray,
    sample_rate: int = FS,
    start_trim_sec: float = START_TRIM_SEC,
    top_k: int = TOP_K,
) -> dict[str, np.ndarray | float]:
    """Return the latest reference-format maps and normalized line traces."""
    feature_maps = extract_all_feature_maps(
        samples,
        sample_rate=sample_rate,
        start_trim_sec=start_trim_sec,
    )
    result: dict[str, np.ndarray | float] = dict(feature_maps)
    for feature in ("amplitude", "phase"):
        for channel in ("left", "right"):
            trace, selected_bins, median = aggregate_and_normalize(
                feature_maps[f"{feature}_{channel}"],
                top_k=top_k,
            )
            result[f"{feature}_{channel}_trace"] = trace
            result[f"{feature}_{channel}_selected_bins"] = selected_bins
            result[f"{feature}_{channel}_median"] = median
    return result
