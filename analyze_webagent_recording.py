"""Generate post-recording signal feature visualizations for the web UI."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from dataclasses import asdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import joblib
import numpy as np
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch
from scipy.signal import stft

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR / "scripts"))

DEFAULT_MLP_MODEL = SCRIPT_DIR / "models" / "signal_event_model_audible_only.joblib"

from signal_event_cnn import split_feature_matrices  # noqa: E402
from train_signal_event_model import (  # noqa: E402
    EPS,
    FC,
    FS,
    FS_SLOW,
    RANGE_PER_SAMPLE_CM,
    SPEED_OF_SOUND,
    FeatureConfig,
    compute_recording_features,
    extract_features,
    read_audio,
    sliding_starts,
    window_matrix,
)


FIGURE_DESCRIPTIONS = {
    "02_doppler_velocity.png": (
        "Shows motion speed and direction over time. Energy away from zero indicates "
        "movement; positive and negative velocities indicate opposite radial directions."
    ),
    "05_derived_motion_traces.png": (
        "Compares dominant reflection range, phase-derived radial velocity, motion energy, "
        "and audible-band energy. Aligned peaks reveal which physical and acoustic changes "
        "occurred together."
    ),
    "06_mlp_prediction_timeline.png": (
        "Audible-only MLP predictions from overlapping 0.5-second windows. The upper strip "
        "shows the predicted event label and the lower trace shows prediction confidence."
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wav", required=True, type=Path)
    parser.add_argument("--events", type=Path)
    parser.add_argument("--diagnostics", type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--figure-set", default="feature-visualizations")
    parser.add_argument("--model", default=DEFAULT_MLP_MODEL, type=Path)
    return parser.parse_args()


def robust_limits(matrix: np.ndarray, low: float = 2.0, high: float = 99.0) -> tuple[float, float]:
    finite = matrix[np.isfinite(matrix)]
    if not finite.size:
        return 0.0, 1.0
    lower, upper = np.percentile(finite, [low, high])
    if upper <= lower:
        upper = lower + 1.0
    return float(lower), float(upper)


def save_figure(fig: plt.Figure, path: Path) -> None:
    fig.tight_layout()
    fig.savefig(path, dpi=170, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def plot_range_time(
    output: Path,
    amplitude_db: np.ndarray,
    time_seconds: np.ndarray,
    range_cm: np.ndarray,
    top_bins: np.ndarray,
) -> None:
    fig, axis = plt.subplots(figsize=(13, 5.5))
    vmin, vmax = robust_limits(amplitude_db)
    image = axis.imshow(
        amplitude_db,
        origin="lower",
        aspect="auto",
        extent=[time_seconds[0], time_seconds[-1], range_cm[0], range_cm[-1]],
        cmap="magma",
        vmin=vmin,
        vmax=vmax,
    )
    for index, range_bin in enumerate(top_bins):
        axis.axhline(
            range_cm[range_bin],
            color="#48cae4",
            linewidth=1,
            alpha=0.9,
            label="Most variable ranges" if index == 0 else None,
        )
    axis.set(
        title="Matched-filter range-time energy",
        xlabel="Time (s)",
        ylabel="Round-trip range (cm)",
    )
    axis.legend(loc="upper right")
    fig.colorbar(image, ax=axis, label="Correlation amplitude (dB)")
    save_figure(fig, output)


def plot_doppler_velocity(
    output: Path,
    correlation: np.ndarray,
    time_offset: float,
    top_bins: np.ndarray,
) -> None:
    strongest_bin = int(top_bins[0])
    slow_signal = correlation[strongest_bin] - np.mean(correlation[strongest_bin])
    nperseg = min(64, len(slow_signal))
    if nperseg < 8:
        raise ValueError("Recording is too short for a Doppler map.")
    noverlap = max(0, nperseg - max(2, nperseg // 12))
    frequencies, times, spectrum = stft(
        slow_signal,
        fs=FS_SLOW,
        window="hann",
        nperseg=nperseg,
        noverlap=noverlap,
        nfft=128,
        return_onesided=False,
        boundary=None,
        padded=False,
    )
    frequencies = np.fft.fftshift(frequencies)
    spectrum_db = 20 * np.log10(np.abs(np.fft.fftshift(spectrum, axes=0)) + EPS)
    velocity_cm_s = frequencies * (SPEED_OF_SOUND / FC) / 2 * 100
    vmin, vmax = robust_limits(spectrum_db, 5, 99.5)

    fig, axis = plt.subplots(figsize=(13, 5.5))
    image = axis.imshow(
        spectrum_db,
        origin="lower",
        aspect="auto",
        extent=[
            times[0] + time_offset,
            times[-1] + time_offset,
            velocity_cm_s[0],
            velocity_cm_s[-1],
        ],
        cmap="inferno",
        vmin=vmin,
        vmax=vmax,
    )
    axis.axhline(0, color="white", linewidth=0.8, alpha=0.7)
    axis.set(
        title="Doppler velocity-time map",
        xlabel="Time (s)",
        ylabel="Radial velocity (cm/s)",
    )
    fig.colorbar(image, ax=axis, label="Doppler energy (dB)")
    save_figure(fig, output)


def plot_range_variability(
    output: Path,
    correlation: np.ndarray,
    range_cm: np.ndarray,
    top_bins: np.ndarray,
) -> None:
    variability = np.var(np.abs(correlation), axis=1)
    normalized = variability / max(float(np.max(variability)), EPS)
    fig, axis = plt.subplots(figsize=(12, 4.8))
    axis.plot(range_cm, normalized, color="#176b87", linewidth=2)
    axis.scatter(
        range_cm[top_bins],
        normalized[top_bins],
        color="#d1495b",
        s=42,
        zorder=3,
        label="Most variable ranges",
    )
    for range_bin in top_bins:
        axis.annotate(
            f"{range_cm[range_bin]:.1f} cm",
            (range_cm[range_bin], normalized[range_bin]),
            xytext=(4, 7),
            textcoords="offset points",
            fontsize=8,
        )
    axis.set(
        title="Range-bin reflection variability",
        xlabel="Round-trip range (cm)",
        ylabel="Normalized variance",
        ylim=(0, 1.08),
    )
    axis.grid(True, alpha=0.25)
    axis.legend()
    save_figure(fig, output)


def select_strongest_window(
    correlation: np.ndarray,
    delta_phase: np.ndarray,
    offset_seconds: float,
    duration_seconds: float,
    config: FeatureConfig,
) -> float:
    usable_start = config.crop_start_seconds
    usable_end = duration_seconds - config.crop_end_seconds
    starts = list(sliding_starts(usable_start, usable_end, config))
    if not starts:
        return max(0.0, min(duration_seconds - config.window_seconds, 0.0))
    frame_count = max(1, int(round(config.window_seconds * FS_SLOW)))
    best_start = starts[0]
    best_score = -np.inf
    amplitude = np.abs(correlation)
    for start in starts:
        start_frame = int(round((start - offset_seconds) * FS_SLOW))
        amp_window = window_matrix(amplitude, start_frame, frame_count)
        phase_window = window_matrix(delta_phase, start_frame, frame_count)
        score = float(np.mean(np.std(amp_window, axis=1)) + np.mean(np.abs(phase_window)))
        if score > best_score:
            best_score = score
            best_start = start
    return float(best_start)


def plot_model_inputs(
    output: Path,
    ultrasound: np.ndarray,
    audible: np.ndarray,
    window_start: float,
    config: FeatureConfig,
) -> None:
    amplitude_map = ultrasound[0, 0]
    phase_map = ultrasound[0, 1]
    audible_map = audible[0, 0]
    phase_limit = max(float(np.percentile(np.abs(phase_map), 99)), 1e-3)
    extent = [window_start, window_start + config.window_seconds, 0, 1]

    fig, axes = plt.subplots(1, 3, figsize=(16, 5.2))
    amp_image = axes[0].imshow(
        amplitude_map,
        origin="lower",
        aspect="auto",
        extent=extent,
        cmap="magma",
    )
    phase_image = axes[1].imshow(
        phase_map,
        origin="lower",
        aspect="auto",
        extent=extent,
        cmap="RdBu_r",
        vmin=-phase_limit,
        vmax=phase_limit,
    )
    audible_image = axes[2].imshow(
        audible_map,
        origin="lower",
        aspect="auto",
        extent=[
            window_start,
            window_start + config.window_seconds,
            config.audible_low_hz / 1000,
            config.audible_high_hz / 1000,
        ],
        cmap="viridis",
    )
    axes[0].set(
        title="Pooled ultrasound amplitude",
        xlabel="Time (s)",
        ylabel="Pooled range position",
    )
    axes[1].set(
        title="Pooled ultrasound phase change",
        xlabel="Time (s)",
        ylabel="Pooled range position",
    )
    axes[2].set(
        title="Pooled audible log spectrum",
        xlabel="Time (s)",
        ylabel="Frequency (kHz)",
    )
    fig.colorbar(amp_image, ax=axes[0], label="Amplitude (dB)")
    fig.colorbar(phase_image, ax=axes[1], label="Phase change (rad)")
    fig.colorbar(audible_image, ax=axes[2], label="Amplitude (dB)")
    fig.suptitle(
        f"Exact neural-network input maps for strongest 0.5 s window ({window_start:.2f} s)",
        fontsize=14,
        fontweight="bold",
    )
    save_figure(fig, output)


def frame_rms_db(samples: np.ndarray, frame_count: int) -> np.ndarray:
    frame_size = max(1, int(round(FS / FS_SLOW)))
    output = np.full(frame_count, np.nan, dtype=np.float64)
    for index in range(frame_count):
        start = index * frame_size
        frame = samples[start : start + frame_size]
        if frame.size:
            output[index] = 20 * np.log10(np.sqrt(np.mean(frame**2)) + EPS)
    return output


def plot_derived_traces(
    output: Path,
    correlation: np.ndarray,
    delta_phase: np.ndarray,
    audible_samples: np.ndarray,
    time_seconds: np.ndarray,
    range_cm: np.ndarray,
    top_bins: np.ndarray,
) -> None:
    peak_bins = np.argmax(np.abs(correlation), axis=0)
    peak_range = range_cm[peak_bins]
    selected_phase = delta_phase[top_bins]
    motion_energy = np.mean(np.abs(selected_phase), axis=0)
    radial_velocity = (
        np.median(selected_phase, axis=0)
        * (SPEED_OF_SOUND / FC)
        / (4 * np.pi)
        * FS_SLOW
        * 100
    )
    audible_rms = frame_rms_db(audible_samples, correlation.shape[1])

    fig, axes = plt.subplots(4, 1, figsize=(13, 9), sharex=True)
    traces = [
        (peak_range, "Dominant reflection range", "Range (cm)", "#176b87"),
        (radial_velocity, "Phase-derived radial velocity", "Velocity (cm/s)", "#c44536"),
        (motion_energy, "Phase motion energy", "Mean |dphase| (rad)", "#5f6caf"),
        (audible_rms, "Audible-band energy", "RMS (dBFS)", "#3a7d44"),
    ]
    for axis, (values, title, ylabel, color) in zip(axes, traces):
        axis.plot(time_seconds[: len(values)], values, color=color, linewidth=1.4)
        axis.set_title(title, loc="left", fontsize=10, fontweight="bold")
        axis.set_ylabel(ylabel)
        axis.grid(True, alpha=0.22)
    axes[-1].set_xlabel("Time (s)")
    fig.suptitle("Derived motion and band-energy features", fontsize=14, fontweight="bold")
    save_figure(fig, output)


def contiguous_label_runs(labels: np.ndarray) -> list[tuple[int, int, str]]:
    if not len(labels):
        return []
    runs = []
    run_start = 0
    for index in range(1, len(labels) + 1):
        if index == len(labels) or labels[index] != labels[run_start]:
            runs.append((run_start, index, str(labels[run_start])))
            run_start = index
    return runs


def plot_mlp_prediction_timeline(
    output: Path,
    recording,
    model_artifact: dict,
    config: FeatureConfig,
) -> tuple[dict, list[dict]]:
    feature_set = str(model_artifact.get("featureSet") or "ultrasound")
    usable_start = config.crop_start_seconds
    usable_end = recording.duration_seconds - config.crop_end_seconds
    starts = list(sliding_starts(usable_start, usable_end, config))
    if not starts:
        raise ValueError("Recording is too short for MLP prediction windows.")

    features = np.asarray(
        [
            extract_features(recording, window_start, config, feature_set)
            for window_start in starts
        ],
        dtype=np.float32,
    )
    pipeline = model_artifact["pipeline"]
    encoder = model_artifact["labelEncoder"]
    probabilities = pipeline.predict_proba(features)
    predicted_indices = np.argmax(probabilities, axis=1)
    predicted_labels = encoder.inverse_transform(predicted_indices)
    confidence = np.max(probabilities, axis=1)
    class_names = [str(name) for name in encoder.classes_]
    centers = np.asarray(starts) + config.window_seconds / 2

    colors = [
        "#277da1",
        "#f9844a",
        "#43aa8b",
        "#f9c74f",
        "#6c757d",
        "#9b5de5",
        "#577590",
    ][: len(class_names)]
    color_map = ListedColormap(colors)
    left = centers[0] - config.stride_seconds / 2
    right = centers[-1] + config.stride_seconds / 2

    fig, axes = plt.subplots(
        2,
        1,
        figsize=(14, 5.5),
        sharex=True,
        gridspec_kw={"height_ratios": [1, 2]},
    )
    axes[0].imshow(
        predicted_indices[None, :],
        origin="lower",
        aspect="auto",
        interpolation="nearest",
        extent=[left, right, 0, 1],
        cmap=color_map,
        vmin=-0.5,
        vmax=len(class_names) - 0.5,
    )
    axes[0].set_yticks([])
    axes[0].set_ylabel("Predicted\nlabel")
    axes[0].set_title(
        f"MLP event-label timeline ({config.window_seconds:.1f} s windows, "
        f"{config.stride_seconds:.2f} s stride)",
        loc="left",
        fontsize=12,
        fontweight="bold",
    )
    for start_index, end_index, label in contiguous_label_runs(predicted_labels):
        run_duration = (end_index - start_index) * config.stride_seconds
        if run_duration < 0.5:
            continue
        run_center = (centers[start_index] + centers[end_index - 1]) / 2
        axes[0].text(
            run_center,
            0.5,
            label,
            ha="center",
            va="center",
            fontsize=8,
            color="white",
            fontweight="bold",
            bbox={"facecolor": "black", "alpha": 0.35, "edgecolor": "none", "pad": 2},
        )

    point_colors = [colors[index] for index in predicted_indices]
    axes[1].plot(centers, confidence, color="#263238", linewidth=1.2, alpha=0.7)
    axes[1].scatter(centers, confidence, c=point_colors, s=15, zorder=3)
    axes[1].set(
        xlabel="Time (s)",
        ylabel="Confidence",
        ylim=(0, 1.03),
    )
    axes[1].grid(True, alpha=0.25)
    axes[1].legend(
        handles=[
            Patch(facecolor=color, label=label)
            for label, color in zip(class_names, colors)
        ],
        loc="upper center",
        bbox_to_anchor=(0.5, -0.28),
        ncol=min(4, len(class_names)),
        frameon=False,
    )
    save_figure(fig, output)
    prediction_rows = []
    for index, (start, label, probability_row) in enumerate(
        zip(starts, predicted_labels, probabilities),
        start=1,
    ):
        prediction_rows.append(
            {
                "windowIndex": index,
                "startSeconds": float(start),
                "endSeconds": float(start + config.window_seconds),
                "centerSeconds": float(start + config.window_seconds / 2),
                "predictedLabel": str(label),
                "confidence": float(np.max(probability_row)),
                "probabilities": {
                    class_name: float(probability)
                    for class_name, probability in zip(class_names, probability_row)
                },
            }
        )
    summary = {
        "featureSet": feature_set,
        "windowCount": len(starts),
        "windowSeconds": config.window_seconds,
        "strideSeconds": config.stride_seconds,
        "labelCounts": dict(Counter(str(label) for label in predicted_labels)),
        "meanConfidence": float(np.mean(confidence)),
    }
    return summary, prediction_rows


def main() -> None:
    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if not args.model.exists():
        raise FileNotFoundError(f"Missing MLP model: {args.model}")
    model_artifact = joblib.load(args.model)
    config = FeatureConfig(**model_artifact["featureConfig"])
    samples, sample_rate = read_audio(args.wav)
    recording = compute_recording_features(samples, sample_rate, config, "combined")
    if recording.C is None or recording.dphi is None or recording.top_bins is None:
        raise RuntimeError("Ultrasound feature extraction did not produce correlation maps.")
    if recording.audible_samples is None:
        raise RuntimeError("Audible feature extraction did not produce filtered samples.")

    correlation = recording.C
    delta_phase = recording.dphi
    top_bins = recording.top_bins
    time_seconds = recording.offset_seconds + np.arange(correlation.shape[1]) / FS_SLOW
    range_cm = np.arange(correlation.shape[0]) * RANGE_PER_SAMPLE_CM
    amplitude_db = 20 * np.log10(np.abs(correlation) + EPS)

    plot_doppler_velocity(
        args.out_dir / "02_doppler_velocity.png",
        correlation,
        recording.offset_seconds,
        top_bins,
    )
    plot_derived_traces(
        args.out_dir / "05_derived_motion_traces.png",
        correlation,
        delta_phase,
        recording.audible_samples,
        time_seconds,
        range_cm,
        top_bins,
    )
    prediction_summary, prediction_rows = plot_mlp_prediction_timeline(
        args.out_dir / "06_mlp_prediction_timeline.png",
        recording,
        model_artifact,
        config,
    )
    prediction_path = args.out_dir / "window_predictions.json"
    prediction_path.write_text(
        json.dumps(
            {
                "model": str(args.model),
                "featureSet": prediction_summary["featureSet"],
                "windowSeconds": config.window_seconds,
                "strideSeconds": config.stride_seconds,
                "predictions": prediction_rows,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    np.savez_compressed(
        args.out_dir / "pipeline_features.npz",
        correlation=correlation,
        delta_phase=delta_phase,
        top_bins=top_bins,
        time_seconds=time_seconds,
        range_cm=range_cm,
    )
    summary = {
        "wav": str(args.wav),
        "sampleRate": sample_rate,
        "durationSeconds": recording.duration_seconds,
        "chirpOffsetSeconds": recording.offset_seconds,
        "chirpCount": int(correlation.shape[1]),
        "rangeBinCount": int(correlation.shape[0]),
        "topRangeBinsCm": [float(range_cm[index]) for index in top_bins],
        "predictionModel": str(args.model),
        "predictionFile": prediction_path.name,
        "prediction": prediction_summary,
        "featureConfig": asdict(config),
        "figures": FIGURE_DESCRIPTIONS,
    }
    (args.out_dir / "analysis_summary.json").write_text(
        json.dumps(summary, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
