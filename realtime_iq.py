#!/usr/bin/env python3
"""Streaming extraction for live Stage-4 traces and micro-Doppler heatmaps.

The completed-recording reference uses zero-phase filtering. A live stream has
no future samples, so this processor uses the causal form of the same sixth-
order Butterworth band filters. Chirp references, alignment, normalized matched
filtering, lag bins, and amplitude/phase change definitions match
``ultrasonic_feature_maps.py`` and the supplied feature-line demo. The browser
uses accumulated map columns for top-10 variable-bin selection, averaging, and
median normalization while drawing the live lines. The processor also retains
complex maps for causal top-12-bin MTI and slow-time Doppler FFT columns.
"""

from __future__ import annotations

import math
from collections import deque
from pathlib import Path

import numpy as np
from scipy.signal import butter, correlate, get_window, hilbert, resample_poly, sosfilt

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
DOPPLER_TOP_K = 12
DOPPLER_WINDOW_CHIRPS = 64
DOPPLER_HOP_CHIRPS = 8
DOPPLER_NFFT = 256
DOPPLER_DB_FLOOR = -30.0
DOPPLER_SLOW_RATE_HZ = 1.0 / CHIRP_DURATION
DOPPLER_FREQUENCIES_HZ = np.fft.fftshift(
    np.fft.fftfreq(DOPPLER_NFFT, d=CHIRP_DURATION)
)
DOPPLER_WINDOW = get_window("hann", DOPPLER_WINDOW_CHIRPS)


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
        self.doppler_left_window: deque[np.ndarray] = deque(
            maxlen=DOPPLER_WINDOW_CHIRPS
        )
        self.doppler_right_window: deque[np.ndarray] = deque(
            maxlen=DOPPLER_WINDOW_CHIRPS
        )
        self.doppler_map_count = 0
        self.doppler_change_count = 0
        self.doppler_left_mean = np.zeros(len(LAGS), dtype=np.complex128)
        self.doppler_right_mean = np.zeros(len(LAGS), dtype=np.complex128)
        self.doppler_previous_left_map = None
        self.doppler_previous_right_map = None
        self.doppler_left_change_sum = np.zeros(len(LAGS), dtype=np.float64)
        self.doppler_right_change_sum = np.zeros(len(LAGS), dtype=np.float64)
        self.doppler_left_change_square_sum = np.zeros(
            len(LAGS), dtype=np.float64
        )
        self.doppler_right_change_square_sum = np.zeros(
            len(LAGS), dtype=np.float64
        )
        self.doppler_left_echo_sum = np.zeros(len(LAGS), dtype=np.float64)
        self.doppler_right_echo_sum = np.zeros(len(LAGS), dtype=np.float64)

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

    @staticmethod
    def _select_doppler_bins(
        change_sum: np.ndarray,
        change_square_sum: np.ndarray,
        echo_sum: np.ndarray,
        count: int,
    ) -> np.ndarray:
        if count <= 0:
            return np.arange(min(DOPPLER_TOP_K, len(change_sum)))
        mean_change = change_sum / count
        change_variance = np.maximum(
            change_square_sum / count - mean_change * mean_change,
            0.0,
        )
        score = np.sqrt(change_variance) * (echo_sum / count)
        return np.sort(np.argsort(score)[::-1][:DOPPLER_TOP_K])

    @staticmethod
    def _doppler_power_column(
        maps: deque[np.ndarray],
        running_mean: np.ndarray,
        selected_bins: np.ndarray,
    ) -> np.ndarray:
        window_maps = np.stack(tuple(maps), axis=1)
        moving_maps = window_maps - running_mean[:, np.newaxis]
        selected = moving_maps[selected_bins] * DOPPLER_WINDOW[np.newaxis, :]
        spectrum = np.fft.fft(selected, n=DOPPLER_NFFT, axis=1)
        power = np.sum(np.abs(spectrum) ** 2, axis=0)
        power = np.fft.fftshift(power)
        if float(np.max(power)) <= EPS:
            return np.full(DOPPLER_NFFT, DOPPLER_DB_FLOOR, dtype=np.float64)
        power_db = 10.0 * np.log10(power + EPS)
        power_db -= np.max(power_db)
        return np.clip(power_db, DOPPLER_DB_FLOOR, 0.0)

    def _update_doppler(
        self,
        left_map: np.ndarray,
        right_map: np.ndarray,
        time_seconds: float,
    ) -> dict | None:
        self.doppler_map_count += 1
        map_count = self.doppler_map_count
        self.doppler_left_mean += (
            left_map - self.doppler_left_mean
        ) / map_count
        self.doppler_right_mean += (
            right_map - self.doppler_right_mean
        ) / map_count
        self.doppler_left_window.append(left_map.copy())
        self.doppler_right_window.append(right_map.copy())

        if (
            self.doppler_previous_left_map is not None
            and self.doppler_previous_right_map is not None
        ):
            left_change = np.abs(
                np.abs(left_map) - np.abs(self.doppler_previous_left_map)
            )
            right_change = np.abs(
                np.abs(right_map) - np.abs(self.doppler_previous_right_map)
            )
            self.doppler_change_count += 1
            self.doppler_left_change_sum += left_change
            self.doppler_right_change_sum += right_change
            self.doppler_left_change_square_sum += left_change * left_change
            self.doppler_right_change_square_sum += right_change * right_change
            self.doppler_left_echo_sum += np.abs(left_map)
            self.doppler_right_echo_sum += np.abs(right_map)

        self.doppler_previous_left_map = left_map
        self.doppler_previous_right_map = right_map

        if (
            len(self.doppler_left_window) < DOPPLER_WINDOW_CHIRPS
            or map_count % DOPPLER_HOP_CHIRPS
        ):
            return None

        left_bins = self._select_doppler_bins(
            self.doppler_left_change_sum,
            self.doppler_left_change_square_sum,
            self.doppler_left_echo_sum,
            self.doppler_change_count,
        )
        right_bins = self._select_doppler_bins(
            self.doppler_right_change_sum,
            self.doppler_right_change_square_sum,
            self.doppler_right_echo_sum,
            self.doppler_change_count,
        )
        left_power_db = self._doppler_power_column(
            self.doppler_left_window,
            self.doppler_left_mean,
            left_bins,
        )
        right_power_db = self._doppler_power_column(
            self.doppler_right_window,
            self.doppler_right_mean,
            right_bins,
        )
        window_start_time = (
            time_seconds - (DOPPLER_WINDOW_CHIRPS - 1) * CHIRP_DURATION
        )
        center_time = (
            window_start_time + DOPPLER_WINDOW_CHIRPS / 2 * CHIRP_DURATION
        )
        return {
            "type": "doppler",
            "method": "causal_micro_doppler_top12_mti_stft",
            "time": center_time,
            "timestamp": (
                self.start_epoch + center_time
                if self.start_epoch is not None
                else None
            ),
            "window_start_time": window_start_time,
            "window_end_time": time_seconds + CHIRP_DURATION,
            "latency_seconds": (
                time_seconds + CHIRP_DURATION - center_time
            ),
            "timestamp_source": "doppler_window_center",
            "window_chirps": DOPPLER_WINDOW_CHIRPS,
            "hop_chirps": DOPPLER_HOP_CHIRPS,
            "nfft": DOPPLER_NFFT,
            "slow_rate_hz": DOPPLER_SLOW_RATE_HZ,
            "db_floor": DOPPLER_DB_FLOOR,
            "frequencies_hz": np.round(DOPPLER_FREQUENCIES_HZ, 4).tolist(),
            "left_power_db": np.round(left_power_db, 3).tolist(),
            "right_power_db": np.round(right_power_db, 3).tolist(),
            "left_selected_bins": left_bins.tolist(),
            "right_selected_bins": right_bins.tolist(),
        }

    def _process_one_chirp(
        self,
        left_samples: np.ndarray,
        right_samples: np.ndarray,
        left_start_sample: int,
        right_start_sample: int,
    ) -> list[dict]:
        output: list[dict] = []
        left_map = matched_filter_frame(hilbert(left_samples), self.reference_left)
        right_map = matched_filter_frame(hilbert(right_samples), self.reference_right)

        if self.previous_left_map is None or self.previous_right_map is None:
            self.previous_left_map = left_map
            self.previous_right_map = right_map
            self.chirp_index += 1
            return output

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
            return output

        doppler = self._update_doppler(left_map, right_map, time_seconds)
        if doppler is not None:
            output.append(doppler)

        if not self.trim_complete:
            # The batch reference keeps its first post-trim complex column and
            # assigns the first change to the following column.
            self.trim_complete = True
            self.chirp_index += 1
            return output

        if self.pending_window_start_sample is None:
            self.pending_window_start_sample = left_start_sample
        self.pending_amplitude_left.append(amplitude_left)
        self.pending_amplitude_right.append(amplitude_right)
        self.pending_phase_left.append(phase_left)
        self.pending_phase_right.append(phase_right)
        self.chirp_index += 1

        if len(self.pending_amplitude_left) < FEATURE_EMIT_STRIDE_CHIRPS:
            return output

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

        output.append({
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
        })
        return output

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
            results = self._process_one_chirp(
                left_chirp,
                right_chirp,
                left_start,
                right_start,
            )
            output.extend(results)

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
