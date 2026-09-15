"""Run windowed event-label prediction with a saved signal-event CNN."""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path

# Conda's NumPy and PyTorch's Windows CPU wheel bundle separate OpenMP runtimes.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import numpy as np
import torch

from signal_event_cnn import (
    CNNConfig,
    SignalEventCNN,
    normalize_channels,
    split_feature_matrices,
)
from train_signal_event_model import (
    FeatureConfig,
    compute_recording_features,
    extract_features,
    read_audio,
    sliding_starts,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--out", default="", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    checkpoint = torch.load(args.model, map_location="cpu", weights_only=False)
    config = FeatureConfig(**checkpoint["featureConfig"])
    feature_set = checkpoint["featureSet"]
    class_names = checkpoint["classNames"]
    model = SignalEventCNN(
        feature_set,
        len(class_names),
        CNNConfig(**checkpoint["architectureConfig"]),
    )
    model.load_state_dict(checkpoint["stateDict"])
    model.eval()

    samples, sample_rate = read_audio(args.wav)
    recording_features = compute_recording_features(samples, sample_rate, config, feature_set)
    usable_start = config.crop_start_seconds
    usable_end = recording_features.duration_seconds - config.crop_end_seconds
    starts = list(sliding_starts(usable_start, usable_end, config))
    features = np.asarray(
        [
            extract_features(recording_features, window_start, config, feature_set)
            for window_start in starts
        ],
        dtype=np.float32,
    )
    if feature_set == "ultrasound":
        combined = np.concatenate(
            [
                features,
                np.zeros(
                    (len(features), config.audible_freq_bins * config.audible_time_bins),
                    dtype=np.float32,
                ),
            ],
            axis=1,
        )
    elif feature_set == "audible":
        combined = np.concatenate(
            [
                np.zeros(
                    (len(features), config.pooled_range_bins * config.pooled_time_bins * 2),
                    dtype=np.float32,
                ),
                features,
            ],
            axis=1,
        )
    else:
        combined = features
    ultrasound, audible = split_feature_matrices(
        combined,
        config.pooled_range_bins,
        config.pooled_time_bins,
        config.audible_freq_bins,
        config.audible_time_bins,
    )
    normalization = checkpoint["normalization"]
    ultrasound = normalize_channels(
        ultrasound,
        np.asarray(normalization["ultrasoundMean"], dtype=np.float32),
        np.asarray(normalization["ultrasoundStd"], dtype=np.float32),
    )
    audible = normalize_channels(
        audible,
        np.asarray(normalization["audibleMean"], dtype=np.float32),
        np.asarray(normalization["audibleStd"], dtype=np.float32),
    )
    with torch.no_grad():
        logits = model(
            torch.from_numpy(ultrasound) if feature_set != "audible" else None,
            torch.from_numpy(audible) if feature_set != "ultrasound" else None,
        )
        probabilities = torch.softmax(logits, dim=1).numpy()
    predicted = np.argmax(probabilities, axis=1)
    rows = []
    for start, index, probs in zip(starts, predicted, probabilities):
        row = {
            "window_start_sec": start,
            "window_end_sec": start + config.window_seconds,
            "predicted_label": class_names[index],
            "confidence": float(np.max(probs)),
        }
        row.update({f"prob_{name}": float(value) for name, value in zip(class_names, probs)})
        rows.append(row)

    print(
        json.dumps(
            {
                "wav": str(args.wav),
                "model": str(args.model),
                "featureSet": feature_set,
                "windowCount": len(rows),
                "predictedLabelCounts": {
                    name: sum(row["predicted_label"] == name for row in rows)
                    for name in class_names
                },
            },
            indent=2,
        )
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        print(f"Saved predictions: {args.out}")


if __name__ == "__main__":
    main()
