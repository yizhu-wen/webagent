#!/usr/bin/env python3
"""Streaming source-map extraction for live Stage-4 feature traces.

The completed-recording reference uses zero-phase filtering. A live stream has
no future samples, so this processor uses the causal form of the same sixth-
order Butterworth band filters. Chirp references, alignment, normalized matched
filtering, lag bins, and amplitude/phase change definitions match
``ultrasonic_feature_maps.py`` and the supplied feature-line demo. The browser
uses accumulated map columns for top-10 variable-bin selection, averaging, and
median normalization while drawing the live lines.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from scipy.signal import butter, correlate, hilbert, resample_poly, sosfilt

from ultrasonic_feature_maps import (
    CHIRP_DURATION,
    CHIRP_SAMPLES,
    EPS,
    FILTER_ORDER,
    FS,
    LAGS,
    LEFT_F0,
    LEFT_F1,
    MAX_LAG,
    RANGE_PER_SAMPLE_CM,
    RIGHT_F0,
    RIGHT_F1,
    RX_LEFT_BAND,
    RX_RIGHT_BAND,
    START_TRIM_SEC,
    calculate_change_vectors,
    matched_filter_frame,
    reference_chirp,
)


T_TRI = CHIRP_DURATION
N_TRI = CHIRP_SAMPLES
ALIGNMENT_CHIRPS = 7
ALIGN_SEARCH_SECONDS = 1.5
FEATURE_EMIT_STRIDE_CHIRPS = 4


class StreamingIqProcessor:
    """Convert browser Float32 mic frames into Stage-4 source-map columns."""

    def __init__(self, tx_wav: Path, sample_rate: int = FS) -> None:
        if not Path(tx_wav).exists():
            raise FileNotFoundError(f"Missing TX chirp WAV: {tx_wav}")
        self.input_sample_rate = int(sample_rate)
        divisor = math.gcd(self.input_sample_rate, FS)
        self.resample_up = FS // divisor
        self.resample_down = self.input_sample_rate // divisor

        self.reference_left = hilbert(reference_chirp(LEFT_F0, LEFT_F1))
        self.reference_right = hilbert(reference_chirp(RIGHT_F0, RIGHT_F1))
        self.sos_left = butter(
            FILTER_ORDER,
            RX_LEFT_BAND,
            btype="band",
            fs=FS,
            output="sos",
        )
        self.sos_right = butter(
            FILTER_ORDER,
            RX_RIGHT_BAND,
            btype="band",
            fs=FS,
            output="sos",
        )
        self.reset()

    def reset(self, start_epoch: float | None = None) -> None:
        self.start_epoch = start_epoch
        self.left_filter_zi = np.zeros((self.sos_left.shape[0], 2), dtype=np.float64)
        self.right_filter_zi = np.zeros((self.sos_right.shape[0], 2), dtype=np.float64)
        self.left_buffer = np.empty(0, dtype=np.float64)
        self.right_buffer = np.empty(0, dtype=np.float64)
        self.left_buffer_start_sample = 0
        self.right_buffer_start_sample = 0
        self.received_sample_count = 0
        self.aligned = False
        self.alignment = None
        self.chirp_index = 0
        self.previous_left_map = None
        self.previous_right_map = None
        self.trim_complete = False
        self.pending_amplitude_left: list[np.ndarray] = []
        self.pending_amplitude_right: list[np.ndarray] = []
        self.pending_phase_left: list[np.ndarray] = []
        self.pending_phase_right: list[np.ndarray] = []
        self.pending_window_start_sample = None

    def _resample_if_needed(self, samples: np.ndarray) -> np.ndarray:
        if self.input_sample_rate == FS:
            return samples
        return resample_poly(samples, self.resample_up, self.resample_down)

    @staticmethod
    def _find_alignment(
        received: np.ndarray,
        reference: np.ndarray,
    ) -> dict[str, float | int]:
        received_analytic = hilbert(received)
        correlation = np.abs(correlate(received_analytic, reference, mode="valid"))
        global_offset = int(np.argmax(correlation))
        period_offset = global_offset % N_TRI
        peak = float(correlation[global_offset])
        baseline = float(np.median(correlation))
        return {
            "global_delta_samples": global_offset,
            "phase_delta_samples": period_offset,
            "peak_over_baseline": peak / (baseline + EPS),
        }

    def _try_align(self) -> dict | None:
        minimum_samples = N_TRI * ALIGNMENT_CHIRPS
        if min(len(self.left_buffer), len(self.right_buffer)) < minimum_samples:
            return None

        search_samples = min(
            int(ALIGN_SEARCH_SECONDS * FS),
            len(self.left_buffer),
            len(self.right_buffer),
        )
        left = self._find_alignment(
            self.left_buffer[:search_samples], self.reference_left
        )
        right = self._find_alignment(
            self.right_buffer[:search_samples], self.reference_right
        )
        left_offset = int(left["phase_delta_samples"])
        right_offset = int(right["phase_delta_samples"])
        self.left_buffer = self.left_buffer[left_offset:]
        self.right_buffer = self.right_buffer[right_offset:]
        self.left_buffer_start_sample += left_offset
        self.right_buffer_start_sample += right_offset
        self.aligned = True
        self.alignment = {
            "method": "dual_band_analytic_chirp_correlation",
            "left": left,
            "right": right,
            "phase_delta_samples": left_offset,
            "phase_trim_seconds": left_offset / FS,
            "peak_over_baseline": min(
                float(left["peak_over_baseline"]),
                float(right["peak_over_baseline"]),
            ),
        }
        return self.alignment

    @staticmethod
    def _sample_latest(pending: list[np.ndarray]) -> np.ndarray:
        """Downsample for transport without modifying a retained column."""
        return pending[-1]

    def _process_one_chirp(
        self,
        left_samples: np.ndarray,
        right_samples: np.ndarray,
        left_start_sample: int,
        right_start_sample: int,
    ) -> dict | None:
        left_map = matched_filter_frame(hilbert(left_samples), self.reference_left)
        right_map = matched_filter_frame(hilbert(right_samples), self.reference_right)

        if self.previous_left_map is None or self.previous_right_map is None:
            self.previous_left_map = left_map
            self.previous_right_map = right_map
            self.chirp_index += 1
            return None

        amplitude_left, phase_left = calculate_change_vectors(
            self.previous_left_map, left_map
        )
        amplitude_right, phase_right = calculate_change_vectors(
            self.previous_right_map, right_map
        )
        self.previous_left_map = left_map
        self.previous_right_map = right_map

        time_seconds = left_start_sample / FS
        if time_seconds < START_TRIM_SEC:
            self.chirp_index += 1
            return None
        if not self.trim_complete:
            # The batch reference keeps its first post-trim complex column and
            # assigns the first change to the following column.
            self.trim_complete = True
            self.chirp_index += 1
            return None

        if self.pending_window_start_sample is None:
            self.pending_window_start_sample = left_start_sample
        self.pending_amplitude_left.append(amplitude_left)
        self.pending_amplitude_right.append(amplitude_right)
        self.pending_phase_left.append(phase_left)
        self.pending_phase_right.append(phase_right)
        self.chirp_index += 1

        if len(self.pending_amplitude_left) < FEATURE_EMIT_STRIDE_CHIRPS:
            return None

        amplitude_left_out = self._sample_latest(self.pending_amplitude_left)
        amplitude_right_out = self._sample_latest(self.pending_amplitude_right)
        phase_left_out = self._sample_latest(self.pending_phase_left)
        phase_right_out = self._sample_latest(self.pending_phase_right)
        window_start_sample = int(self.pending_window_start_sample)
        self.pending_amplitude_left.clear()
        self.pending_amplitude_right.clear()
        self.pending_phase_left.clear()
        self.pending_phase_right.clear()
        self.pending_window_start_sample = None

        feature = {
            "type": "feature_map",
            "method": "stage4_top10_source_maps",
            "time": time_seconds,
            "timestamp": (
                self.start_epoch + time_seconds
                if self.start_epoch is not None
                else None
            ),
            "chirp_index": self.chirp_index - 1,
            "chirp_start_sample": left_start_sample,
            "right_chirp_start_sample": right_start_sample,
            "window_start_time": window_start_sample / FS,
            "window_end_time": (left_start_sample + N_TRI) / FS,
            "timestamp_source": "processed_sample_chirp_start",
            "feature_stride_chirps": FEATURE_EMIT_STRIDE_CHIRPS,
            "temporal_sampling": "latest_chirp_every_4",
            "lag_count": len(LAGS),
            "max_lag": MAX_LAG,
            "range_bin_cm": RANGE_PER_SAMPLE_CM,
            "amplitude_change_left": np.round(amplitude_left_out, 6).tolist(),
            "amplitude_change_right": np.round(amplitude_right_out, 6).tolist(),
            "phase_change_left": np.round(phase_left_out, 5).tolist(),
            "phase_change_right": np.round(phase_right_out, 5).tolist(),
        }
        return feature

    def push_samples(self, samples: np.ndarray) -> list[dict]:
        if samples.size == 0:
            return []
        samples = np.asarray(samples, dtype=np.float64)
        samples = self._resample_if_needed(samples)
        left_filtered, self.left_filter_zi = sosfilt(
            self.sos_left, samples, zi=self.left_filter_zi
        )
        right_filtered, self.right_filter_zi = sosfilt(
            self.sos_right, samples, zi=self.right_filter_zi
        )
        self.left_buffer = np.concatenate([self.left_buffer, left_filtered])
        self.right_buffer = np.concatenate([self.right_buffer, right_filtered])
        self.received_sample_count += len(samples)

        output: list[dict] = []
        if not self.aligned:
            alignment = self._try_align()
            if alignment is None:
                return output
            output.append({"type": "alignment", **alignment})

        while min(len(self.left_buffer), len(self.right_buffer)) >= N_TRI:
            left_start = self.left_buffer_start_sample
            right_start = self.right_buffer_start_sample
            left_chirp = self.left_buffer[:N_TRI]
            right_chirp = self.right_buffer[:N_TRI]
            self.left_buffer = self.left_buffer[N_TRI:]
            self.right_buffer = self.right_buffer[N_TRI:]
            self.left_buffer_start_sample += N_TRI
            self.right_buffer_start_sample += N_TRI
            feature = self._process_one_chirp(
                left_chirp,
                right_chirp,
                left_start,
                right_start,
            )
            if feature is not None:
                output.append(feature)

        max_keep = N_TRI * 8
        if len(self.left_buffer) > max_keep:
            trimmed = len(self.left_buffer) - max_keep
            self.left_buffer = self.left_buffer[-max_keep:]
            self.left_buffer_start_sample += trimmed
        if len(self.right_buffer) > max_keep:
            trimmed = len(self.right_buffer) - max_keep
            self.right_buffer = self.right_buffer[-max_keep:]
            self.right_buffer_start_sample += trimmed
        return output
