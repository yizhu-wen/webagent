"""Plot training/evaluation curves for all signal feature sets together."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt


DEFAULT_CURVES = [
    ("Ultrasound only", Path("models/training_curves_ultrasound_only.csv")),
    ("Audible only", Path("models/training_curves_audible_only.csv")),
    ("Audible + ultrasound", Path("models/training_curves_combined.csv")),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plot-out", default="models/training_curves_comparison.png", type=Path)
    return parser.parse_args()


def load_history(path: Path) -> list[dict[str, float]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return [
            {
                "epoch": float(row["epoch"]),
                "train_loss": float(row["train_loss"]),
                "evaluation_loss": float(row["evaluation_loss"]),
                "train_accuracy": float(row["train_accuracy"]),
                "evaluation_accuracy": float(row["evaluation_accuracy"]),
            }
            for row in csv.DictReader(handle)
        ]


def plot_comparison(output: Path) -> None:
    histories = [(label, load_history(path)) for label, path in DEFAULT_CURVES]

    fig, axes = plt.subplots(2, 2, figsize=(16, 10), dpi=160)
    fig.suptitle("Feature Set Training Curve Comparison", fontsize=17, fontweight="bold")

    panels = [
        (axes[0, 0], "train_loss", "Train Loss", "Cross-entropy loss"),
        (axes[0, 1], "evaluation_loss", "Evaluation Loss", "Cross-entropy loss"),
        (axes[1, 0], "train_accuracy", "Train Accuracy", "Accuracy"),
        (axes[1, 1], "evaluation_accuracy", "Evaluation Accuracy", "Accuracy"),
    ]

    for axis, metric, title, ylabel in panels:
        for label, history in histories:
            axis.plot(
                [row["epoch"] for row in history],
                [row[metric] for row in history],
                linewidth=2,
                label=label,
            )
        axis.set_title(title)
        axis.set_xlabel("Epoch")
        axis.set_ylabel(ylabel)
        axis.grid(True, alpha=0.45)
        if "accuracy" in metric:
            axis.set_ylim(0, 1.02)
        axis.legend()

    fig.tight_layout()
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    args = parse_args()
    plot_comparison(args.plot_out)
    print(f"Saved comparison plot: {args.plot_out}")


if __name__ == "__main__":
    main()
