#!/usr/bin/env python3
"""
Train the per-user personalized false-positive filter.

Reads labeled detection crops the user produced via the Review screen:
  DATA_DIR/training/labeled/positive/*.jpg   (real detections to keep)
  DATA_DIR/training/labeled/negative/*.jpg   (false positives to suppress)

and writes a scikit-learn classifier to:
  DATA_DIR/models/personal_filter.pkl  (+ meta.json with sample counts/accuracy)

DATA_DIR is taken from LUCIDCUT_DATA_DIR (the app's persistent userData folder in
production) so the learned model survives app updates. Invoked in the background
by server.js whenever enough new feedback has been collected.
"""

import os
import sys
import json
import glob
import pickle

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from features import extract_features_from_path

DATA_DIR = os.environ.get("LUCIDCUT_DATA_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "user-data")
LABELED_DIR = os.path.join(DATA_DIR, "training", "labeled")
MODELS_DIR = os.path.join(DATA_DIR, "models")
MODEL_PATH = os.path.join(MODELS_DIR, "personal_filter.pkl")
META_PATH = os.path.join(MODELS_DIR, "meta.json")

MIN_PER_CLASS = 8  # keep in sync with server.js MIN_SAMPLES_PER_CLASS


def _load(label):
    feats = []
    for p in glob.glob(os.path.join(LABELED_DIR, label, "*.jpg")):
        f = extract_features_from_path(p)
        if f is not None:
            feats.append(f)
    return feats


def main():
    pos = _load("positive")
    neg = _load("negative")
    print(f"[train] loaded positive={len(pos)} negative={len(neg)}")

    if len(pos) < MIN_PER_CLASS or len(neg) < MIN_PER_CLASS:
        print(f"[train] not enough samples (need {MIN_PER_CLASS} per class); skipping")
        return 1

    try:
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.model_selection import cross_val_score
    except ImportError:
        print("[train] scikit-learn not installed; run: pip install scikit-learn")
        return 1

    X = np.array(pos + neg, dtype=np.float32)
    y = np.array([1] * len(pos) + [0] * len(neg))

    clf = RandomForestClassifier(
        n_estimators=120, max_depth=None, random_state=0, class_weight="balanced")

    acc = None
    try:
        k = min(5, len(pos), len(neg))
        if k >= 2:
            acc = float(np.mean(cross_val_score(clf, X, y, cv=k)))
    except Exception as e:
        print(f"[train] cross-val skipped: {e}")

    clf.fit(X, y)

    os.makedirs(MODELS_DIR, exist_ok=True)
    tmp = MODEL_PATH + ".tmp"
    with open(tmp, "wb") as fh:
        pickle.dump(clf, fh)
    os.replace(tmp, MODEL_PATH)  # atomic swap so the worker never reads a partial file

    with open(META_PATH, "w") as fh:
        json.dump({"positive": len(pos), "negative": len(neg), "cv_accuracy": acc}, fh, indent=2)

    print(f"[train] saved {MODEL_PATH} (cv_accuracy={acc})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
