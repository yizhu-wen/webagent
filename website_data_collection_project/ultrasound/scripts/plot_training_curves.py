"""Plot epoch-by-epoch train/evaluation curves for the signal event MLP.

This script uses the same dataset preparation and feature extractors as
``train_signal_event_model.py``. It trains the same MLP architecture one epoch
at a time with ``partial_fit`` so loss and accuracy can be measured on both the
train split and held-out evaluation split after every epoch.
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from sklearn.decomposition import PCA
from sklearn.metrics import accuracy_score, log_loss
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import LabelEncoder, StandardScaler

from train_signal_event_model import (
    FeatureConfig,
    assign_splits,
    build_windows_for_session,
    collect_session_files,
    FEATURE_SETS,
    materialize_dataset,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default="data", type=Path)
    parser.add_argument("--history-out", default="models/training_curves.csv", type=Path)
    parser.add_argument("--plot-out", default="models/training_curves.png", type=Path)
    parser.add_argument("--feature-set", default="ultrasound", choices=FEATURE_SETS)
    parser.add_argument("--epochs", default=80, type=int)
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


def load_dataset(args: argparse.Namespace) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str], FeatureConfig]:
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
    all_records = []
    issues = []
    for session_key, files in sorted(sessions.items()):
        records, session_issues = build_windows_for_session(session_key, files, config)
        all_records.extend(records)
        issues.extend(session_issues)

    if not all_records:
        raise SystemExit("No training windows were generated.")

    x, y_text, session_ids, records = materialize_dataset(all_records, config, args.feature_set)
    splits = assign_splits(
        records,
        y_text,
        session_ids,
        test_sessions_per_label=args.test_sessions_per_label,
        random_seed=args.random_seed,
    )
    return x, y_text, splits, issues, config


def write_history(path: Path, history: list[dict[str, float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "epoch",
                "train_loss",
                "evaluation_loss",
                "train_accuracy",
                "evaluation_accuracy",
            ],
        )
        writer.writeheader()
        writer.writerows(history)


def plot_history(path: Path, history: list[dict[str, float]], feature_set: str) -> None:
    epochs = [row["epoch"] for row in history]
    train_loss = [row["train_loss"] for row in history]
    eval_loss = [row["evaluation_loss"] for row in history]
    train_acc = [row["train_accuracy"] for row in history]
    eval_acc = [row["evaluation_accuracy"] for row in history]

    best_eval_index = int(np.argmax(eval_acc))
    best_epoch = epochs[best_eval_index]

    fig, axes = plt.subplots(1, 2, figsize=(16, 6), dpi=160)
    fig.suptitle(f"Signal Event MLP Training Curves ({feature_set})", fontsize=16, fontweight="bold")

    axes[0].plot(epochs, train_loss, label="train loss", linewidth=2)
    axes[0].plot(epochs, eval_loss, label="evaluation loss", linewidth=2)
    axes[0].scatter([best_epoch], [eval_loss[best_eval_index]], zorder=3)
    axes[0].annotate(
        f"best eval acc\nepoch {best_epoch}",
        xy=(best_epoch, eval_loss[best_eval_index]),
        xytext=(best_epoch + 2, eval_loss[best_eval_index]),
        fontsize=9,
    )
    axes[0].set_title("Loss")
    axes[0].set_xlabel("Epoch")
    axes[0].set_ylabel("Cross-entropy loss")
    axes[0].grid(True, alpha=0.5)
    axes[0].legend()

    axes[1].plot(epochs, train_acc, label="train accuracy", linewidth=2)
    axes[1].plot(epochs, eval_acc, label="evaluation accuracy", linewidth=2)
    axes[1].scatter([best_epoch], [eval_acc[best_eval_index]], zorder=3)
    axes[1].annotate(
        f"best eval {eval_acc[best_eval_index]:.3f}\nepoch {best_epoch}",
        xy=(best_epoch, eval_acc[best_eval_index]),
        xytext=(best_epoch + 2, eval_acc[best_eval_index] - 0.08),
        fontsize=9,
    )
    axes[1].set_title("Accuracy")
    axes[1].set_xlabel("Epoch")
    axes[1].set_ylabel("Accuracy")
    axes[1].set_ylim(0, 1.02)
    axes[1].grid(True, alpha=0.5)
    axes[1].legend()

    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    args = parse_args()
    x, y_text, splits, issues, _config = load_dataset(args)

    encoder = LabelEncoder()
    y = encoder.fit_transform(y_text)
    train_mask = splits == "train"
    eval_mask = splits == "test"
    classes = np.arange(len(encoder.classes_))

    scaler = StandardScaler()
    x_train_scaled = scaler.fit_transform(x[train_mask])
    x_eval_scaled = scaler.transform(x[eval_mask])

    pca_components = min(96, max(8, int(train_mask.sum()) - len(encoder.classes_) - 1), x.shape[1])
    pca = PCA(n_components=pca_components, random_state=args.random_seed, whiten=True)
    x_train = pca.fit_transform(x_train_scaled)
    x_eval = pca.transform(x_eval_scaled)
    y_train = y[train_mask]
    y_eval = y[eval_mask]

    mlp = MLPClassifier(
        hidden_layer_sizes=(96, 48),
        activation="relu",
        solver="adam",
        alpha=1e-3,
        batch_size=64,
        learning_rate_init=1e-3,
        max_iter=1,
        shuffle=False,
        random_state=args.random_seed,
    )

    rng = np.random.default_rng(args.random_seed)
    history = []
    for epoch in range(1, args.epochs + 1):
        order = rng.permutation(len(x_train))
        mlp.partial_fit(x_train[order], y_train[order], classes=classes)

        train_proba = mlp.predict_proba(x_train)
        eval_proba = mlp.predict_proba(x_eval)
        train_pred = np.argmax(train_proba, axis=1)
        eval_pred = np.argmax(eval_proba, axis=1)

        history.append(
            {
                "epoch": epoch,
                "train_loss": log_loss(y_train, train_proba, labels=classes),
                "evaluation_loss": log_loss(y_eval, eval_proba, labels=classes),
                "train_accuracy": accuracy_score(y_train, train_pred),
                "evaluation_accuracy": accuracy_score(y_eval, eval_pred),
            }
        )

    write_history(args.history_out, history)
    plot_history(args.plot_out, history, args.feature_set)

    best = max(history, key=lambda row: row["evaluation_accuracy"])
    final = history[-1]
    print(f"Feature set: {args.feature_set}")
    print(f"Classes: {', '.join(encoder.classes_)}")
    print(f"Windows: train={len(y_train)}, evaluation={len(y_eval)}, total={len(y)}")
    print(f"PCA components: {pca_components}")
    print(
        "Best evaluation accuracy: "
        f"{best['evaluation_accuracy']:.3f} at epoch {int(best['epoch'])}"
    )
    print(
        "Final epoch: "
        f"{int(final['epoch'])}, "
        f"train loss={final['train_loss']:.3f}, "
        f"evaluation loss={final['evaluation_loss']:.3f}, "
        f"train accuracy={final['train_accuracy']:.3f}, "
        f"evaluation accuracy={final['evaluation_accuracy']:.3f}"
    )
    print(f"Saved history: {args.history_out}")
    print(f"Saved plot: {args.plot_out}")
    if issues:
        print("Issues:")
        for issue in issues:
            print(f"  - {issue}")


if __name__ == "__main__":
    main()
