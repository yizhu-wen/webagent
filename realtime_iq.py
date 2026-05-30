#!/usr/bin/env python3
"""Streaming IQ feature extraction for the webagent real-time backend."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, correlate, correlation_lags, hilbert, resample_poly, sosfilt


FS = 48_000
T_TRI = 0.020
N_TRI = int(FS * T_TRI)
LO_CUT = 19_700
HI_CUT = 23_300
FILTER_ORDER = 6
N_REF_CHIRPS = 20
SPEED_OF_SOUND = 343.0
FC = 21_500
WAVELENGTH = SPEED_OF_SOUND / FC
R_MIN = 0.0
R_MAX = 1.20
N_RANGE = 320
ALIGN_SEARCH_SECONDS = 1.50


def load_mono_wav(path: Path) -> tuple[np.ndarray, int]:
    data, fs = sf.read(str(path), dtype="float64")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data, fs


def delay_signal(sig: np.ndarray, t: np.ndarray, tau: float) -> np.ndarray:
    t_delayed = t - tau
    return (
        np.interp(t_delayed, t, np.real(sig), left=0, right=0)
        + 1j * np.interp(t_delayed, t, np.imag(sig), left=0, right=0)
    )


class StreamingIqProcessor:
    """Processes browser Float32 mic frames into live range/amplitude/phase points."""

    def __init__(self, tx_wav: Path, sample_rate: int = FS) -> None:
        self.input_sample_rate = int(sample_rate)
        gcd = math.gcd(self.input_sample_rate, FS)
        self.resample_up = FS // gcd
        self.resample_down = self.input_sample_rate // gcd
        tx_real, tx_fs = load_mono_wav(tx_wav)
        if tx_fs != FS:
            raise ValueError(f"Expected {FS} Hz TX chirp WAV, got {tx_fs}")
        tx_real = tx_real[:N_TRI]
        if len(tx_real) != N_TRI:
            raise ValueError(f"TX WAV is too short: {tx_wav}")

        self.tx_real = tx_real
        self.tx = hilbert(tx_real)
        self.tx_conj = np.conj(self.tx)
        self.sos = butter(FILTER_ORDER, [LO_CUT, HI_CUT], btype="band", fs=FS, output="sos")
        self.r_grid, self.ref_bank = self._build_range_bank()
        self.reset()

    def reset(self, start_epoch: float | None = None) -> None:
        self.start_epoch = start_epoch
        self.filter_zi = np.zeros((self.sos.shape[0], 2), dtype=np.float64)
        self.buffer = np.empty(0, dtype=np.float64)
        self.aligned = False
        self.alignment = None
        self.chirp_index = 0
        self.prev_phase_angle = None
        self.phase_unwrapped = 0.0
        self.amp_floor = None
        self.amp_peak = None

    def _resample_if_needed(self, samples: np.ndarray) -> np.ndarray:
        if self.input_sample_rate == FS:
            return samples
        return resample_poly(samples, self.resample_up, self.resample_down)

    def _build_range_bank(self) -> tuple[np.ndarray, np.ndarray]:
        r_grid = np.linspace(R_MIN, R_MAX, N_RANGE)
        t_tri = np.arange(N_TRI) / FS
        ref_bank = np.empty((N_RANGE, N_TRI), dtype=np.complex128)

        for idx, r_value in enumerate(r_grid):
            tau = 2 * r_value / SPEED_OF_SOUND
            rx_ref = delay_signal(self.tx, t_tri, tau)
            if_ref = rx_ref * self.tx_conj
            ref_bank[idx] = if_ref / math.sqrt(float(np.sum(np.abs(if_ref) ** 2)) + 1e-30)

        return r_grid, ref_bank

    def _try_align(self) -> dict | None:
        ref = np.tile(self.tx_real[:N_TRI], N_REF_CHIRPS)
        min_samples = len(ref) + N_TRI
        if len(self.buffer) < min_samples:
            return None

        n_search = min(int(ALIGN_SEARCH_SECONDS * FS), len(self.buffer))
        rx_search = self.buffer[:n_search].astype(np.float64)
        ref_energy = math.sqrt(float(np.sum(ref ** 2)))
        corr = correlate(rx_search, ref, mode="full")
        lags = correlation_lags(len(rx_search), len(ref), mode="full")
        abs_corr = np.abs(corr) / (ref_energy + 1e-12)
        search_corr = np.where(lags >= 0, abs_corr, -np.inf)
        peak_idx = int(np.argmax(search_corr))
        global_delta = int(lags[peak_idx])
        phase_delta = global_delta % N_TRI
        peak = float(abs_corr[peak_idx])
        baseline = float(np.median(abs_corr))

        self.buffer = self.buffer[phase_delta:]
        self.aligned = True
        self.alignment = {
            "global_delta_samples": global_delta,
            "global_trim_seconds": global_delta / FS,
            "phase_delta_samples": phase_delta,
            "phase_trim_seconds": phase_delta / FS,
            "peak_over_baseline": peak / (baseline + 1e-12),
        }
        return self.alignment

    def _update_amp_normalization(self, amp: float) -> float:
        if self.amp_floor is None:
            self.amp_floor = amp
            self.amp_peak = amp + 1e-12
        else:
            self.amp_floor = 0.995 * self.amp_floor + 0.005 * min(self.amp_floor, amp)
            self.amp_peak = max(0.995 * self.amp_peak, amp)
        return float((amp - self.amp_floor) / max(self.amp_peak - self.amp_floor, 1e-12))

    def _process_one_chirp(self, samples: np.ndarray) -> dict:
        rx_analytic = hilbert(samples)
        if_data = rx_analytic * self.tx_conj
        c_all = np.conj(self.ref_bank) @ if_data
        idx_peak = int(np.argmax(np.abs(c_all)))
        c_peak = c_all[idx_peak]

        amp = float(np.abs(c_peak))
        amp_norm = max(0.0, min(1.2, self._update_amp_normalization(amp)))
        phase_angle = float(np.angle(c_peak))
        if self.prev_phase_angle is None:
            self.phase_unwrapped = phase_angle
        else:
            delta = float(np.angle(np.exp(1j * (phase_angle - self.prev_phase_angle))))
            self.phase_unwrapped += delta
        self.prev_phase_angle = phase_angle

        t_rel = self.chirp_index * T_TRI
        displacement_mm = self.phase_unwrapped * WAVELENGTH / (4 * np.pi) * 1000
        feature = {
            "type": "feature",
            "time": t_rel,
            "timestamp": (self.start_epoch + t_rel) if self.start_epoch is not None else None,
            "chirp_index": self.chirp_index,
            "amplitude": amp,
            "amplitude_norm": amp_norm,
            "phase": self.phase_unwrapped,
            "range_cm": float(self.r_grid[idx_peak] * 100),
            "displacement_mm": float(displacement_mm),
        }
        self.chirp_index += 1
        return feature

    def push_samples(self, samples: np.ndarray) -> list[dict]:
        if samples.size == 0:
            return []
        samples = np.asarray(samples, dtype=np.float64)
        samples = self._resample_if_needed(samples)
        filtered, self.filter_zi = sosfilt(self.sos, samples, zi=self.filter_zi)
        self.buffer = np.concatenate([self.buffer, filtered])

        out = []
        if not self.aligned:
            alignment = self._try_align()
            if alignment is None:
                return out
            out.append({"type": "alignment", **alignment})

        while len(self.buffer) >= N_TRI:
            chirp = self.buffer[:N_TRI]
            self.buffer = self.buffer[N_TRI:]
            out.append(self._process_one_chirp(chirp))

        # Bound memory if the browser pauses or changes stream shape.
        max_keep = N_TRI * 8
        if len(self.buffer) > max_keep:
            self.buffer = self.buffer[-max_keep:]

        return out
