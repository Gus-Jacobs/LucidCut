#!/usr/bin/env python3
"""
Shared feature extraction for the per-user personalized false-positive filter.

Both the training script (train_model.py) and the live worker (process_video.py)
import this so the feature vector is guaranteed identical at train and inference
time. Keep this deterministic and dependency-light (cv2 + numpy only).

A detection crop -> fixed-length vector of:
  - a 32x32 grayscale thumbnail (shape/structure cues), flattened + normalized
  - an HSV colour histogram (skin-tone / colour distribution cues)
"""

import numpy as np
import cv2

FEATURE_SIZE = (32, 32)  # thumbnail dimensions used for the structural features


def extract_features_from_bgr(bgr):
    """Return a 1-D float32 feature vector for a BGR image, or None if invalid."""
    if bgr is None or getattr(bgr, "size", 0) == 0:
        return None
    try:
        img = cv2.resize(bgr, FEATURE_SIZE, interpolation=cv2.INTER_AREA)
    except Exception:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32).flatten() / 255.0

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hist_parts = []
    for ch, bins, rng in ((0, 16, 180), (1, 16, 256), (2, 16, 256)):
        h = cv2.calcHist([hsv], [ch], None, [bins], [0, rng]).flatten()
        h = h / (h.sum() + 1e-6)
        hist_parts.append(h)

    return np.concatenate([gray, np.concatenate(hist_parts)]).astype(np.float32)


def extract_features_from_path(path):
    """Load an image from disk and return its feature vector (or None)."""
    return extract_features_from_bgr(cv2.imread(path))
