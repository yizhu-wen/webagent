"""Generate post-recording signal feature visualizations for the web UI."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import joblib
import numpy as np
from matplotlib.colors import ListedColormap
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from scipy.signal import stft

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR / "scripts"))

DEFAULT_MLP_MODEL = SCRIPT_DIR / "models" / "signal_event_model_audible_only.joblib"
DEFAULT_AUDIO_EVENT_OFFSET_MS = 80.0
ACTION_COLORS = {
    "keydown": "#d62728",
    "pointer_move": "#1f77b4",
    "scroll": "#17becf",
    "click": "#9467bd",
}

from signal_event_cnn import split_feature_matrices  # noqa: E402
from train_signal_event_model import (  # noqa: E402
    EPS,
    FC,
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
from ultrasonic_feature_maps import extract_stage4_traces  # noqa: E402


FIGURE_DESCRIPTIONS = {
    "stage4_signal_events_amplitude_change.png": (
        "Median-normalized left/right amplitude-change lines made from the 10 "
        "matched-filter lag bins with the greatest temporal variation, with "
        "time-aligned key, pointer-move, scroll, and click markers."
    ),
    "stage4_signal_events_phase_change.png": (
        "Median-normalized left/right wrapped phase-change lines made from the "
        "10 matched-filter lag bins with the greatest temporal variation, with "
        "time-aligned key, pointer-move, scroll, and click markers."
    ),
    "02_doppler_velocity.png": (
        "Shows motion speed and direction over time. Energy away from zero indicates "
        "movement; positive and negative velocities indicate opposite radial directions."
    ),
    "06_mlp_prediction_timeline.png": (
        "Audible-only MLP predictions from overlapping 0.5-second windows. The upper strip "
        "shows the predicted event label and the lower trace shows prediction confidence."
    ),
}


@dataclass(frozen=True)
class ActionMarker:
    """One browser action aligned to the start of the captured audio."""

    name: str
    time_seconds: float
    label: str
    value: str


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


def _event_field(value: str, name: str) -> str | None:
    prefix = f"{name}="
    for token in value.split():
        if token.startswith(prefix):
            return token[len(prefix) :]
    return None


def _event_label(name: str, value: str) -> str:
    if name == "keydown":
        code = _event_field(value, "code")
        if code and code.startswith("Key") and len(code) == 4:
            return code[3:]
        return _event_field(value, "key") or "key"
    if name == "pointer_move":
        return "move"
    return name


def load_action_markers(events_path: Path | None) -> list[ActionMarker]:
    """Parse the browser's pipe-delimited event log into audio-relative actions."""
    if events_path is None or not events_path.exists():
        return []

    headers: dict[str, str] = {}
    raw_events: list[tuple[str, str, float]] = []
    for raw_line in events_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            header_parts = [part.strip() for part in line[1:].split("|", 1)]
            if len(header_parts) == 2:
                headers[header_parts[0].lower()] = header_parts[1]
            continue

        parts = [part.strip() for part in line.rsplit("|", 2)]
        if len(parts) != 3:
            continue
        name = parts[0].lower()
        if name not in ACTION_COLORS:
            continue
        try:
            epoch_seconds = float(parts[2])
        except ValueError:
            continue
        raw_events.append((name, parts[1], epoch_seconds))

    if not raw_events:
        return []

    reference_epoch_text = (
        headers.get("audio_start_epoch")
        or headers.get("start_epoch")
    )
    try:
        reference_epoch = float(reference_epoch_text)
    except (TypeError, ValueError):
        reference_epoch = raw_events[0][2]
    try:
        audio_event_offset_ms = float(
            headers.get("audio_event_offset_ms", DEFAULT_AUDIO_EVENT_OFFSET_MS)
        )
    except ValueError:
        audio_event_offset_ms = DEFAULT_AUDIO_EVENT_OFFSET_MS

    markers = []
    pending_legacy_click_epoch: float | None = None
    for name, value, epoch_seconds in raw_events:
        if name == "click":
            pressed = _event_field(value, "pressed")
            if pressed == "false":
                continue
            if pressed is None:
                if (
                    pending_legacy_click_epoch is not None
                    and epoch_seconds - pending_legacy_click_epoch <= 0.5
                ):
                    pending_legacy_click_epoch = None
                    continue
                pending_legacy_click_epoch = epoch_seconds
        time_seconds = (
            epoch_seconds
            - reference_epoch
            + audio_event_offset_ms / 1000.0
        )
        if time_seconds < 0:
            continue
        markers.append(
            ActionMarker(
                name=name,
                time_seconds=time_seconds,
                label=_event_label(name, value),
                value=value,
            )
        )
    return markers


def _activity_spans(
    markers: list[ActionMarker],
    name: str,
    time_min: float,
    time_max: float,
    gap_seconds: float = 0.30,
) -> list[tuple[float, float]]:
    """Group dense pointer or scroll samples into readable activity spans."""
    times = sorted(
        marker.time_seconds
        for marker in markers
        if marker.name == name and time_min <= marker.time_seconds <= time_max
    )
    if not times:
        return []

    spans: list[tuple[float, float]] = []
    start = previous = times[0]
    for current in times[1:]:
        if current - previous > gap_seconds:
            spans.append(
                (max(time_min, start - 0.05), min(time_max, previous + 0.05))
            )
            start = current
        previous = current
    spans.append((max(time_min, start - 0.05), min(time_max, previous + 0.05)))
    return spans


def overlay_action_markers(
    axis: plt.Axes,
    markers: list[ActionMarker],
    time_min: float,
    time_max: float,
) -> list[Line2D | Patch]:
    """Overlay the four tracked action types using the realtime chart colors."""
    visible = [
        marker
        for marker in markers
        if time_min <= marker.time_seconds <= time_max
    ]
    if not visible:
        return []

    legend_handles: list[Line2D | Patch] = []
    for name, display_name in (
        ("pointer_move", "move"),
        ("scroll", "scroll"),
    ):
        spans = _activity_spans(visible, name, time_min, time_max)
        if not spans:
            continue
        color = ACTION_COLORS[name]
        for span_start, span_end in spans:
            axis.axvspan(span_start, span_end, color=color, alpha=0.10, linewidth=0)
            axis.text(
                (span_start + span_end) / 2,
                0.98,
                display_name,
                color=color,
                fontsize=9,
                fontweight="bold",
                ha="center",
                va="top",
                transform=axis.get_xaxis_transform(),
            )
        legend_handles.append(
            Patch(facecolor=color, alpha=0.18, label=display_name)
        )

    for name, line_style in (("keydown", ":"), ("click", "--")):
        selected = [marker for marker in visible if marker.name == name]
        if not selected:
            continue
        color = ACTION_COLORS[name]
        for marker in selected:
            axis.axvline(
                marker.time_seconds,
                color=color,
                linewidth=1.3,
                linestyle=line_style,
                alpha=0.62,
            )
            axis.text(
                marker.time_seconds,
                0.98,
                marker.label,
                color=color,
                fontsize=9,
                fontweight="bold",
                ha="right",
                va="top",
                rotation=90,
                transform=axis.get_xaxis_transform(),
            )
        legend_handles.append(
            Line2D(
                [0],
                [0],
                color=color,
                linewidth=1.5,
                linestyle=line_style,
                label="key" if name == "keydown" else "click",
            )
        )
    return legend_handles


def plot_stage4_feature_trace(
    output: Path,
    feature: str,
    time_seconds: np.ndarray,
    normalized_left: np.ndarray,
    normalized_right: np.ndarray,
    action_markers: list[ActionMarker],
) -> None:
    """Save the same final two-series line chart as the reference demo."""
    fig, axis = plt.subplots(figsize=(16, 5.5))
    axis.plot(
        time_seconds,
        normalized_left,
        color="C0",
        linewidth=0.9,
        label="left channel",
    )
    axis.plot(
        time_seconds,
        normalized_right,
        color="C1",
        linewidth=0.9,
        label="right channel",
    )
    ymax = max(
        float(np.max(normalized_left)),
        float(np.max(normalized_right)),
        1e-8,
    )
    axis.set_ylim(0, ymax * 1.14)
    axis.set_ylabel(feature, fontsize=13)
    axis.set_xlabel("time (s)", fontsize=13)
    axis.tick_params(axis="both", labelsize=11)
    axis.margins(x=0)
    action_handles = overlay_action_markers(
        axis,
        action_markers,
        float(time_seconds[0]),
        float(time_seconds[-1]),
    )
    trace_handles, _ = axis.get_legend_handles_labels()
    axis.legend(
        handles=[*trace_handles, *action_handles],
        loc="best",
        framealpha=0.95,
        fontsize=11,
        ncol=min(6, 2 + len(action_handles)),
    )
    axis.set_title(feature.capitalize(), fontsize=16, fontweight="bold")
    fig.tight_layout()
    fig.savefig(output, dpi=130, bbox_inches="tight")
    plt.close(fig)


def plot_stage4_feature_changes(
    output_dir: Path,
    feature_maps: dict[str, np.ndarray | float],
    action_markers: list[ActionMarker],
) -> None:
    """Render the latest reference-format amplitude and phase line charts."""
    for feature in ("amplitude", "phase"):
        plot_stage4_feature_trace(
            output_dir / f"stage4_signal_events_{feature}_change.png",
            f"{feature} change",
            np.asarray(feature_maps["time"]),
            np.asarray(feature_maps[f"{feature}_left_trace"]),
            np.asarray(feature_maps[f"{feature}_right_trace"]),
            action_markers,
        )


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
    model_artifact = joblib.load(args.model) if args.model.exists() else None
    config = (
        FeatureConfig(**model_artifact["featureConfig"])
        if model_artifact is not None
        else FeatureConfig()
    )
    samples, sample_rate = read_audio(args.wav)
    feature_maps = extract_stage4_traces(samples, sample_rate)
    action_markers = load_action_markers(args.events)
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

    plot_stage4_feature_changes(args.out_dir, feature_maps, action_markers)

    plot_doppler_velocity(
        args.out_dir / "02_doppler_velocity.png",
        correlation,
        recording.offset_seconds,
        top_bins,
    )
    prediction_summary = None
    prediction_path = None
    if model_artifact is not None:
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
        feature_time=feature_maps["time"],
        feature_lags=feature_maps["lags"],
        amplitude_change_left=feature_maps["amplitude_left"],
        amplitude_change_right=feature_maps["amplitude_right"],
        phase_change_left=feature_maps["phase_left"],
        phase_change_right=feature_maps["phase_right"],
        amplitude_change_left_trace=feature_maps["amplitude_left_trace"],
        amplitude_change_right_trace=feature_maps["amplitude_right_trace"],
        phase_change_left_trace=feature_maps["phase_left_trace"],
        phase_change_right_trace=feature_maps["phase_right_trace"],
        amplitude_change_left_selected_bins=feature_maps[
            "amplitude_left_selected_bins"
        ],
        amplitude_change_right_selected_bins=feature_maps[
            "amplitude_right_selected_bins"
        ],
        phase_change_left_selected_bins=feature_maps["phase_left_selected_bins"],
        phase_change_right_selected_bins=feature_maps["phase_right_selected_bins"],
        amplitude_change_left_median=feature_maps["amplitude_left_median"],
        amplitude_change_right_median=feature_maps["amplitude_right_median"],
        phase_change_left_median=feature_maps["phase_left_median"],
        phase_change_right_median=feature_maps["phase_right_median"],
    )
    summary = {
        "wav": str(args.wav),
        "sampleRate": sample_rate,
        "durationSeconds": recording.duration_seconds,
        "chirpOffsetSeconds": recording.offset_seconds,
        "chirpCount": int(correlation.shape[1]),
        "rangeBinCount": int(correlation.shape[0]),
        "topRangeBinsCm": [float(range_cm[index]) for index in top_bins],
        "predictionModel": str(args.model) if model_artifact is not None else None,
        "predictionFile": prediction_path.name if prediction_path is not None else None,
        "prediction": prediction_summary,
        "featureConfig": asdict(config),
        "actionMarkerCount": len(action_markers),
        "actionMarkerCounts": dict(Counter(marker.name for marker in action_markers)),
        "figures": FIGURE_DESCRIPTIONS,
    }
    (args.out_dir / "analysis_summary.json").write_text(
        json.dumps(summary, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
