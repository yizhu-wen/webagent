"""PyTorch CNN architecture and feature tensor helpers for signal events."""

from __future__ import annotations

import os
from dataclasses import dataclass

# Conda's NumPy and PyTorch's Windows CPU wheel bundle separate OpenMP runtimes.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import numpy as np
import torch
from torch import nn


FEATURE_SET_SUFFIX = {
    "ultrasound": "ultrasound_only",
    "audible": "audible_only",
    "combined": "combined",
}


@dataclass(frozen=True)
class CNNConfig:
    branch_channels: tuple[int, int, int] = (16, 32, 64)
    embedding_size: int = 96
    hidden_size: int = 96
    dropout: float = 0.35


class ConvBranch(nn.Module):
    def __init__(self, input_channels: int, config: CNNConfig) -> None:
        super().__init__()
        c1, c2, c3 = config.branch_channels
        self.features = nn.Sequential(
            nn.Conv2d(input_channels, c1, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(c1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(c1, c2, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(c2),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(c2, c3, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(c3),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d((4, 3)),
        )
        self.embedding = nn.Sequential(
            nn.Flatten(),
            nn.Linear(c3 * 4 * 3, config.embedding_size),
            nn.ReLU(inplace=True),
            nn.Dropout(config.dropout),
        )

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.embedding(self.features(inputs))


class SignalEventCNN(nn.Module):
    def __init__(self, feature_set: str, class_count: int, config: CNNConfig | None = None) -> None:
        super().__init__()
        if feature_set not in FEATURE_SET_SUFFIX:
            raise ValueError(f"Unsupported feature set: {feature_set}")
        self.feature_set = feature_set
        self.config = config or CNNConfig()
        self.ultrasound_branch = (
            ConvBranch(2, self.config) if feature_set in {"ultrasound", "combined"} else None
        )
        self.audible_branch = (
            ConvBranch(1, self.config) if feature_set in {"audible", "combined"} else None
        )
        branch_count = 2 if feature_set == "combined" else 1
        self.classifier = nn.Sequential(
            nn.Linear(self.config.embedding_size * branch_count, self.config.hidden_size),
            nn.ReLU(inplace=True),
            nn.Dropout(self.config.dropout),
            nn.Linear(self.config.hidden_size, class_count),
        )

    def forward(
        self,
        ultrasound: torch.Tensor | None = None,
        audible: torch.Tensor | None = None,
    ) -> torch.Tensor:
        embeddings = []
        if self.ultrasound_branch is not None:
            if ultrasound is None:
                raise ValueError("Ultrasound input is required.")
            embeddings.append(self.ultrasound_branch(ultrasound))
        if self.audible_branch is not None:
            if audible is None:
                raise ValueError("Audible input is required.")
            embeddings.append(self.audible_branch(audible))
        return self.classifier(torch.cat(embeddings, dim=1))


def split_feature_matrices(
    combined_features: np.ndarray,
    range_bins: int,
    time_bins: int,
    audible_freq_bins: int,
    audible_time_bins: int,
) -> tuple[np.ndarray, np.ndarray]:
    ultrasound_plane_size = range_bins * time_bins
    audible_plane_size = audible_freq_bins * audible_time_bins
    expected = ultrasound_plane_size * 2 + audible_plane_size
    if combined_features.shape[1] != expected:
        raise ValueError(
            f"Expected {expected} combined features, got {combined_features.shape[1]}."
        )
    ultrasound = combined_features[:, : ultrasound_plane_size * 2].reshape(
        -1, 2, range_bins, time_bins
    )
    audible = combined_features[:, -audible_plane_size:].reshape(
        -1, 1, audible_freq_bins, audible_time_bins
    )
    return ultrasound.astype(np.float32), audible.astype(np.float32)


def fit_channel_normalization(inputs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mean = inputs.mean(axis=(0, 2, 3), keepdims=True, dtype=np.float64).astype(np.float32)
    std = inputs.std(axis=(0, 2, 3), keepdims=True, dtype=np.float64).astype(np.float32)
    return mean, np.maximum(std, 1e-6)


def normalize_channels(inputs: np.ndarray, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    return ((inputs - mean) / std).astype(np.float32)
