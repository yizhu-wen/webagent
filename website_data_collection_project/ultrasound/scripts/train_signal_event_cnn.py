"""Train CNN event recognizers for ultrasound, audible, and combined features."""

from __future__ import annotations

import argparse
import copy
import csv
import json
import os
import random
import time
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

# Conda's NumPy and PyTorch's Windows CPU wheel bundle separate OpenMP runtimes.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import torch
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from signal_event_cnn import (
    CNNConfig,
    FEATURE_SET_SUFFIX,
    SignalEventCNN,
    fit_channel_normalization,
    normalize_channels,
    split_feature_matrices,
)
from train_signal_event_model import (
    FEATURE_SETS,
    FOLDER_CONFIG,
    FS,
    FeatureConfig,
    assign_splits,
    build_windows_for_session,
    collect_session_files,
    feature_components,
    feature_extractor_name,
    materialize_dataset,
    save_manifest,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default="data", type=Path)
    parser.add_argument("--output-dir", default="models", type=Path)
    parser.add_argument("--epochs", default=80, type=int)
    parser.add_argument("--batch-size", default=64, type=int)
    parser.add_argument("--learning-rate", default=1e-3, type=float)
    parser.add_argument("--weight-decay", default=1e-3, type=float)
    parser.add_argument("--label-smoothing", default=0.05, type=float)
    parser.add_argument("--feature-sets", nargs="+", choices=FEATURE_SETS, default=list(FEATURE_SETS))
    parser.add_argument("--window-seconds", default=0.5, type=float)
    parser.add_argument("--stride-seconds", default=0.25, type=float)
    parser.add_argument("--crop-start-seconds", default=1.0, type=float)
    parser.add_argument("--crop-end-seconds", default=1.0, type=float)
    parser.add_argument("--test-sessions-per-label", default=2, type=int)
    parser.add_argument("--random-seed", default=42, type=int)
    return parser.parse_args()


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def make_loader(
    feature_set: str,
    ultrasound: np.ndarray,
    audible: np.ndarray,
    labels: np.ndarray,
    batch_size: int,
    shuffle: bool,
    seed: int,
) -> DataLoader:
    tensors: list[torch.Tensor] = []
    if feature_set in {"ultrasound", "combined"}:
        tensors.append(torch.from_numpy(ultrasound))
    if feature_set in {"audible", "combined"}:
        tensors.append(torch.from_numpy(audible))
    tensors.append(torch.from_numpy(labels.astype(np.int64)))
    generator = torch.Generator().manual_seed(seed)
    return DataLoader(
        TensorDataset(*tensors),
        batch_size=batch_size,
        shuffle=shuffle,
        generator=generator,
        num_workers=0,
    )


def unpack_batch(
    feature_set: str,
    batch: list[torch.Tensor] | tuple[torch.Tensor, ...],
    device: torch.device,
) -> tuple[torch.Tensor | None, torch.Tensor | None, torch.Tensor]:
    if feature_set == "ultrasound":
        ultrasound, labels = batch
        return ultrasound.to(device), None, labels.to(device)
    if feature_set == "audible":
        audible, labels = batch
        return None, audible.to(device), labels.to(device)
    ultrasound, audible, labels = batch
    return ultrasound.to(device), audible.to(device), labels.to(device)


def evaluate(
    model: SignalEventCNN,
    loader: DataLoader,
    feature_set: str,
    device: torch.device,
) -> tuple[float, float, np.ndarray, np.ndarray]:
    model.eval()
    criterion = nn.CrossEntropyLoss()
    total_loss = 0.0
    targets = []
    probabilities = []
    with torch.no_grad():
        for batch in loader:
            ultrasound, audible, labels = unpack_batch(feature_set, batch, device)
            logits = model(ultrasound, audible)
            total_loss += float(criterion(logits, labels)) * len(labels)
            targets.append(labels.cpu().numpy())
            probabilities.append(torch.softmax(logits, dim=1).cpu().numpy())
    y_true = np.concatenate(targets)
    proba = np.concatenate(probabilities)
    y_pred = np.argmax(proba, axis=1)
    return total_loss / len(y_true), float(accuracy_score(y_true, y_pred)), y_pred, proba


def write_history(path: Path, history: list[dict[str, float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(history[0]))
        writer.writeheader()
        writer.writerows(history)


def plot_history(path: Path, history: list[dict[str, float]], feature_set: str) -> None:
    epochs = [row["epoch"] for row in history]
    best = max(history, key=lambda row: (row["evaluation_accuracy"], -row["evaluation_loss"]))
    fig, axes = plt.subplots(1, 2, figsize=(16, 6), dpi=160)
    fig.suptitle(f"Signal Event CNN Training Curves ({feature_set})", fontsize=16, fontweight="bold")
    axes[0].plot(epochs, [row["train_loss"] for row in history], label="train loss", linewidth=2)
    axes[0].plot(
        epochs,
        [row["evaluation_loss"] for row in history],
        label="evaluation loss",
        linewidth=2,
    )
    axes[0].set(title="Loss", xlabel="Epoch", ylabel="Cross-entropy loss")
    axes[1].plot(
        epochs,
        [row["train_accuracy"] for row in history],
        label="train accuracy",
        linewidth=2,
    )
    axes[1].plot(
        epochs,
        [row["evaluation_accuracy"] for row in history],
        label="evaluation accuracy",
        linewidth=2,
    )
    axes[1].scatter([best["epoch"]], [best["evaluation_accuracy"]], zorder=3)
    axes[1].annotate(
        f"best {best['evaluation_accuracy']:.3f}\nepoch {int(best['epoch'])}",
        (best["epoch"], best["evaluation_accuracy"]),
        xytext=(6, -30),
        textcoords="offset points",
    )
    axes[1].set(title="Accuracy", xlabel="Epoch", ylabel="Accuracy", ylim=(0, 1.02))
    for axis in axes:
        axis.grid(True, alpha=0.45)
        axis.legend()
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def plot_comparison(
    path: Path,
    histories: dict[str, list[dict[str, float]]],
) -> None:
    labels = {
        "ultrasound": "Ultrasound only",
        "audible": "Audible only",
        "combined": "Audible + ultrasound",
    }
    panels = [
        ("train_loss", "Train Loss", "Cross-entropy loss"),
        ("evaluation_loss", "Evaluation Loss", "Cross-entropy loss"),
        ("train_accuracy", "Train Accuracy", "Accuracy"),
        ("evaluation_accuracy", "Evaluation Accuracy", "Accuracy"),
    ]
    fig, axes = plt.subplots(2, 2, figsize=(16, 10), dpi=160)
    fig.suptitle("CNN Feature Set Training Curve Comparison", fontsize=17, fontweight="bold")
    for axis, (metric, title, ylabel) in zip(axes.ravel(), panels):
        for feature_set, history in histories.items():
            axis.plot(
                [row["epoch"] for row in history],
                [row[metric] for row in history],
                linewidth=2,
                label=labels[feature_set],
            )
        axis.set(title=title, xlabel="Epoch", ylabel=ylabel)
        axis.grid(True, alpha=0.45)
        if "accuracy" in metric:
            axis.set_ylim(0, 1.02)
        axis.legend()
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def train_feature_set(
    feature_set: str,
    ultrasound: np.ndarray,
    audible: np.ndarray,
    labels: np.ndarray,
    train_mask: np.ndarray,
    eval_mask: np.ndarray,
    class_names: list[str],
    args: argparse.Namespace,
    config: FeatureConfig,
    session_ids: np.ndarray,
    y_text: np.ndarray,
    issues: list[str],
) -> tuple[dict, list[dict[str, float]]]:
    set_seed(args.random_seed)
    device = torch.device("cpu")
    ultrasound_mean, ultrasound_std = fit_channel_normalization(ultrasound[train_mask])
    audible_mean, audible_std = fit_channel_normalization(audible[train_mask])
    ultrasound_norm = normalize_channels(ultrasound, ultrasound_mean, ultrasound_std)
    audible_norm = normalize_channels(audible, audible_mean, audible_std)

    y_eval = labels[eval_mask]
    train_indices = np.flatnonzero(train_mask)
    fit_indices, validation_indices = train_test_split(
        train_indices,
        test_size=0.2,
        random_state=args.random_seed,
        stratify=labels[train_indices],
    )
    train_loader = make_loader(
        feature_set,
        ultrasound_norm[fit_indices],
        audible_norm[fit_indices],
        labels[fit_indices],
        args.batch_size,
        True,
        args.random_seed,
    )
    train_eval_loader = make_loader(
        feature_set,
        ultrasound_norm[fit_indices],
        audible_norm[fit_indices],
        labels[fit_indices],
        args.batch_size * 2,
        False,
        args.random_seed,
    )
    validation_loader = make_loader(
        feature_set,
        ultrasound_norm[validation_indices],
        audible_norm[validation_indices],
        labels[validation_indices],
        args.batch_size * 2,
        False,
        args.random_seed,
    )
    eval_loader = make_loader(
        feature_set,
        ultrasound_norm[eval_mask],
        audible_norm[eval_mask],
        y_eval,
        args.batch_size * 2,
        False,
        args.random_seed,
    )

    cnn_config = CNNConfig()
    model = SignalEventCNN(feature_set, len(class_names), cnn_config).to(device)
    class_counts = np.bincount(labels[fit_indices], minlength=len(class_names)).astype(np.float32)
    class_weights = len(fit_indices) / (len(class_names) * class_counts)
    criterion = nn.CrossEntropyLoss(
        weight=torch.from_numpy(class_weights).to(device),
        label_smoothing=args.label_smoothing,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer,
        mode="min",
        factor=0.5,
        patience=7,
        min_lr=1e-5,
    )

    history = []
    best_state = None
    best_epoch = 0
    best_validation_accuracy = -1.0
    best_validation_loss = float("inf")
    started = time.perf_counter()
    for epoch in range(1, args.epochs + 1):
        model.train()
        for batch in train_loader:
            ultrasound_batch, audible_batch, batch_labels = unpack_batch(feature_set, batch, device)
            optimizer.zero_grad(set_to_none=True)
            logits = model(ultrasound_batch, audible_batch)
            loss = criterion(logits, batch_labels)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()

        train_loss, train_accuracy, _train_pred, _ = evaluate(
            model, train_eval_loader, feature_set, device
        )
        validation_loss, validation_accuracy, _validation_pred, _ = evaluate(
            model, validation_loader, feature_set, device
        )
        eval_loss, eval_accuracy, _eval_pred, _ = evaluate(model, eval_loader, feature_set, device)
        scheduler.step(validation_loss)
        learning_rate = float(optimizer.param_groups[0]["lr"])
        history.append(
            {
                "epoch": epoch,
                "train_loss": train_loss,
                "validation_loss": validation_loss,
                "evaluation_loss": eval_loss,
                "train_accuracy": train_accuracy,
                "validation_accuracy": validation_accuracy,
                "evaluation_accuracy": eval_accuracy,
                "learning_rate": learning_rate,
            }
        )
        if (validation_accuracy, -validation_loss) > (
            best_validation_accuracy,
            -best_validation_loss,
        ):
            best_validation_accuracy = validation_accuracy
            best_validation_loss = validation_loss
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())
        if epoch == 1 or epoch % 10 == 0:
            print(
                f"[{feature_set}] epoch {epoch:02d}/{args.epochs}: "
                f"train={train_accuracy:.3f}, validation={validation_accuracy:.3f}, "
                f"evaluation={eval_accuracy:.3f}, lr={learning_rate:.1e}",
                flush=True,
            )

    training_seconds = time.perf_counter() - started
    if best_state is None:
        raise RuntimeError("CNN training did not produce a checkpoint.")
    model.load_state_dict(best_state)
    train_loss, train_accuracy, train_pred, _ = evaluate(
        model, train_eval_loader, feature_set, device
    )
    validation_loss, validation_accuracy, _validation_pred, _ = evaluate(
        model, validation_loader, feature_set, device
    )
    eval_started = time.perf_counter()
    eval_loss, eval_accuracy, eval_pred, _ = evaluate(model, eval_loader, feature_set, device)
    evaluation_seconds = time.perf_counter() - eval_started

    suffix = FEATURE_SET_SUFFIX[feature_set]
    model_path = args.output_dir / f"signal_event_cnn_{suffix}.pt"
    report_path = args.output_dir / f"signal_event_cnn_report_{suffix}.json"
    history_path = args.output_dir / f"training_curves_cnn_{suffix}.csv"
    plot_path = args.output_dir / f"training_curves_cnn_{suffix}.png"
    args.output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = {
        "architecture": "SignalEventCNN",
        "architectureConfig": asdict(cnn_config),
        "stateDict": model.state_dict(),
        "featureSet": feature_set,
        "featureConfig": asdict(config),
        "featureExtractor": feature_extractor_name(feature_set),
        "featureComponents": feature_components(feature_set),
        "classNames": class_names,
        "normalization": {
            "ultrasoundMean": ultrasound_mean.tolist(),
            "ultrasoundStd": ultrasound_std.tolist(),
            "audibleMean": audible_mean.tolist(),
            "audibleStd": audible_std.tolist(),
        },
        "sampleRate": FS,
    }
    torch.save(checkpoint, model_path)

    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "architecture": "2D CNN with modality-specific branches and late fusion",
        "architectureConfig": asdict(cnn_config),
        "featureSet": feature_set,
        "featureExtractor": feature_extractor_name(feature_set),
        "featureComponents": feature_components(feature_set),
        "featureConfig": asdict(config),
        "folderConfig": FOLDER_CONFIG,
        "classNames": class_names,
        "sessionCount": len(set(session_ids)),
        "windowCount": int(len(labels)),
        "windowCountsByLabel": dict(Counter(y_text)),
        "trainWindowCountsByLabel": dict(Counter(y_text[train_mask])),
        "testWindowCountsByLabel": dict(Counter(y_text[eval_mask])),
        "trainSessions": sorted(set(session_ids[train_mask])),
        "testSessions": sorted(set(session_ids[eval_mask])),
        "epochs": args.epochs,
        "bestEpoch": best_epoch,
        "fitWindowCount": int(len(fit_indices)),
        "validationWindowCount": int(len(validation_indices)),
        "parameterCount": int(sum(parameter.numel() for parameter in model.parameters())),
        "trainingSeconds": training_seconds,
        "evaluationSeconds": evaluation_seconds,
        "trainLoss": train_loss,
        "validationLoss": validation_loss,
        "testLoss": eval_loss,
        "trainAccuracy": train_accuracy,
        "validationAccuracy": validation_accuracy,
        "testAccuracy": eval_accuracy,
        "classificationReport": classification_report(
            labels[eval_mask],
            eval_pred,
            labels=np.arange(len(class_names)),
            target_names=class_names,
            output_dict=True,
            zero_division=0,
        ),
        "confusionMatrix": confusion_matrix(
            labels[eval_mask],
            eval_pred,
            labels=np.arange(len(class_names)),
        ).tolist(),
        "modelSelectionNote": (
            "Best epoch and learning-rate schedule selected with a stratified 20% subset "
            "of training windows. Test sessions were not used for model selection."
        ),
        "issues": issues,
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    write_history(history_path, history)
    plot_history(plot_path, history, feature_set)
    print(
        f"[{feature_set}] best epoch={best_epoch}, train accuracy={train_accuracy:.3f}, "
        f"test accuracy={eval_accuracy:.3f}, saved={model_path}",
        flush=True,
    )
    return report, history


def main() -> None:
    args = parse_args()
    set_seed(args.random_seed)
    torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
    config = FeatureConfig(
        window_seconds=args.window_seconds,
        stride_seconds=args.stride_seconds,
        crop_start_seconds=args.crop_start_seconds,
        crop_end_seconds=args.crop_end_seconds,
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

    print("Extracting combined features once for all three CNN models...", flush=True)
    combined, y_text, session_ids, records = materialize_dataset(
        all_records, config, "combined"
    )
    splits = assign_splits(
        records,
        y_text,
        session_ids,
        test_sessions_per_label=args.test_sessions_per_label,
        random_seed=args.random_seed,
    )
    encoder = LabelEncoder()
    labels = encoder.fit_transform(y_text)
    class_names = list(encoder.classes_)
    ultrasound, audible = split_feature_matrices(
        combined,
        config.pooled_range_bins,
        config.pooled_time_bins,
        config.audible_freq_bins,
        config.audible_time_bins,
    )
    train_mask = splits == "train"
    eval_mask = splits == "test"
    manifest_path = args.output_dir / "window_manifest_cnn.csv"
    save_manifest(manifest_path, records)
    print(
        f"Dataset ready: {len(labels)} windows, {train_mask.sum()} train, "
        f"{eval_mask.sum()} evaluation.",
        flush=True,
    )

    reports = {}
    histories = {}
    for feature_set in args.feature_sets:
        report, history = train_feature_set(
            feature_set,
            ultrasound,
            audible,
            labels,
            train_mask,
            eval_mask,
            class_names,
            args,
            config,
            session_ids,
            y_text,
            issues,
        )
        reports[feature_set] = report
        histories[feature_set] = history

    if len(histories) > 1:
        plot_comparison(args.output_dir / "training_curves_cnn_comparison.png", histories)

    comparison_path = args.output_dir / "model_comparison_cnn.csv"
    with comparison_path.open("w", newline="", encoding="utf-8") as handle:
        fieldnames = [
            "feature_set",
            "architecture",
            "best_epoch",
            "parameter_count",
            "train_accuracy",
            "test_accuracy",
            "macro_f1",
            "training_seconds",
            "evaluation_seconds",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for feature_set, report in reports.items():
            writer.writerow(
                {
                    "feature_set": feature_set,
                    "architecture": "cnn",
                    "best_epoch": report["bestEpoch"],
                    "parameter_count": report["parameterCount"],
                    "train_accuracy": report["trainAccuracy"],
                    "test_accuracy": report["testAccuracy"],
                    "macro_f1": report["classificationReport"]["macro avg"]["f1-score"],
                    "training_seconds": report["trainingSeconds"],
                    "evaluation_seconds": report["evaluationSeconds"],
                }
            )
    print(f"Saved CNN comparison: {comparison_path}")


if __name__ == "__main__":
    main()
