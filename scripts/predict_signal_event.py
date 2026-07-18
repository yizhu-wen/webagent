"""Run windowed event-label prediction on a sensed WAV recording."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import joblib
import numpy as np

from train_signal_event_model import (
    FeatureConfig,
    compute_recording_features,
    extract_features,
    read_audio,
    sliding_starts,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path, help="Input sensed WAV recording.")
    parser.add_argument("--model", default="models/signal_event_model.joblib", type=Path)
    parser.add_argument("--out", default=None, type=Path, help="Optional CSV output path.")
    parser.add_argument("--crop-start-seconds", default=None, type=float)
    parser.add_argument("--crop-end-seconds", default=None, type=float)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    artifact = joblib.load(args.model)
    config = FeatureConfig(**artifact["featureConfig"])
    feature_set = artifact.get("featureSet", "ultrasound")
    if args.crop_start_seconds is not None:
        config = FeatureConfig(**{**artifact["featureConfig"], "crop_start_seconds": args.crop_start_seconds})
    if args.crop_end_seconds is not None:
        config = FeatureConfig(**{**config.__dict__, "crop_end_seconds": args.crop_end_seconds})

    samples, sample_rate = read_audio(args.wav)
    recording_features = compute_recording_features(samples, sample_rate, config, feature_set)
    duration = recording_features.duration_seconds
    usable_start = config.crop_start_seconds
    usable_end = duration - config.crop_end_seconds
    if usable_end - usable_start < config.window_seconds:
        raise SystemExit("Recording is too short after cropping.")

    features = []
    windows = []
    for window_start in sliding_starts(usable_start, usable_end, config):
        features.append(extract_features(recording_features, window_start, config, feature_set))
        windows.append((window_start, window_start + config.window_seconds))

    x = np.asarray(features, dtype=np.float32)
    pipeline = artifact["pipeline"]
    encoder = artifact["labelEncoder"]
    probabilities = pipeline.predict_proba(x)
    predicted_indices = np.argmax(probabilities, axis=1)
    predicted_labels = encoder.inverse_transform(predicted_indices)
    class_names = list(encoder.classes_)

    rows = []
    for (window_start, window_end), label, probs in zip(windows, predicted_labels, probabilities):
        row = {
            "window_start_sec": round(float(window_start), 6),
            "window_end_sec": round(float(window_end), 6),
            "predicted_label": str(label),
            "confidence": round(float(np.max(probs)), 6),
        }
        for class_name, probability in zip(class_names, probs):
            row[f"prob_{class_name}"] = round(float(probability), 6)
        rows.append(row)

    summary = {
        "wav": str(args.wav),
        "model": str(args.model),
        "featureSet": feature_set,
        "durationSeconds": duration,
        "windowCount": len(rows),
        "predictedLabelCounts": {
            label: int(sum(row["predicted_label"] == label for row in rows))
            for label in class_names
        },
    }
    print(json.dumps(summary, indent=2))

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"Saved predictions: {args.out}")


if __name__ == "__main__":
    main()
