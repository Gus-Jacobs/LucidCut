#!/usr/bin/env python3
"""
Lightweight object follow-tracker for the editor.

Given a video, a start time, and an initial box (percent coords), this tracks the
region forward with an OpenCV tracker (CSRT preferred — best accuracy on CPU) and
returns per-keyframe boxes until the subject is lost, the scene changes, or a time
cap is reached. Output (stdout, last line): {"track":[{"t","box"}], "tracker": "..."}

Requires an OpenCV build that ships trackers (opencv-contrib-python). With plain
opencv-python no tracker is available, so it returns just the seed box and the
editor leaves a static box the user can still use.
"""

import sys
import json

import cv2
import numpy as np

MAX_TRACK_SECONDS = 30.0   # cap a single track so it stays bounded
SAMPLE_HZ = 5              # keyframes recorded per second
SCENE_DIFF = 0.10         # big frame change => scene cut => stop following


def make_tracker(tier="mid"):
    # tier picks the accuracy/speed tradeoff: CSRT is most accurate (heavier),
    # KCF is balanced, MOSSE is fastest (best for weak hardware).
    if tier == "low":
        order = ("TrackerMOSSE_create", "TrackerKCF_create", "TrackerCSRT_create")
    elif tier == "high":
        order = ("TrackerCSRT_create", "TrackerKCF_create", "TrackerMOSSE_create")
    else:
        order = ("TrackerKCF_create", "TrackerCSRT_create", "TrackerMOSSE_create")
    legacy = getattr(cv2, "legacy", None)
    for name in order:
        for ns in (cv2, legacy):
            if ns is not None and hasattr(ns, name):
                try:
                    return getattr(ns, name)(), name.replace("Tracker", "").replace("_create", "")
                except Exception:
                    pass
    return None, "none"


def smooth_and_pad(track, win=5, pad=0.08):
    """Reduce per-frame tracker jitter with a centered moving average, and expand
    each box a little so a fast-moving subject can't peek out of the blur."""
    if len(track) < 3:
        return track
    boxes = [k["box"] for k in track]
    n = len(boxes)
    half = win // 2
    out = []
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        avg = {k: sum(b[k] for b in boxes[lo:hi]) / (hi - lo) for k in ("x", "y", "w", "h")}
        cx, cy = avg["x"] + avg["w"] / 2, avg["y"] + avg["h"] / 2
        nw = min(100.0, avg["w"] * (1 + pad))
        nh = min(100.0, avg["h"] * (1 + pad))
        nx = max(0.0, min(100.0 - nw, cx - nw / 2))
        ny = max(0.0, min(100.0 - nh, cy - nh / 2))
        out.append({"t": track[i]["t"], "box": {"x": nx, "y": ny, "w": nw, "h": nh}})
    return out


def main():
    data = json.loads(sys.argv[1])
    video, start, box_pct = data["video"], float(data["time"]), data["box"]
    tier = data.get("tier", "mid")

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        print(json.dumps({"error": "cannot open video"}))
        return 1

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
    ret, frame = cap.read()
    if not ret or W == 0 or H == 0:
        print(json.dumps({"error": "cannot read start frame"}))
        return 1

    x = max(0, min(W - 2, box_pct["x"] / 100.0 * W))
    y = max(0, min(H - 2, box_pct["y"] / 100.0 * H))
    w = max(2, min(W - x, box_pct["w"] / 100.0 * W))
    h = max(2, min(H - y, box_pct["h"] / 100.0 * H))

    track = [{"t": round(start, 3), "box": box_pct}]
    tracker, tracker_name = make_tracker(tier)
    if tracker is None:
        print(json.dumps({"track": track, "tracker": "none",
                          "note": "no tracker available (install opencv-contrib-python)"}))
        return 0

    try:
        tracker.init(frame, (int(x), int(y), int(w), int(h)))
    except Exception as e:
        print(json.dumps({"track": track, "tracker": "none", "note": f"init failed: {e}"}))
        return 0

    step = max(1, int(round(fps / SAMPLE_HZ)))
    prev_small = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (32, 32)).astype(np.float32) / 255.0
    fidx = 0
    ok = True
    while ok:
        for _ in range(step):
            ret, frame = cap.read()
            fidx += 1
            if not ret:
                break
        if not ret:
            break
        t = start + fidx / fps
        if t - start > MAX_TRACK_SECONDS:
            break
        small = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (32, 32)).astype(np.float32) / 255.0
        if float(np.mean(np.abs(small - prev_small))) > SCENE_DIFF:
            break  # scene cut — the subject is (probably) gone
        prev_small = small
        try:
            ok, bb = tracker.update(frame)
        except Exception:
            break
        if not ok:
            break
        bx, by, bw, bh = bb
        if bw <= 1 or bh <= 1:
            break
        track.append({"t": round(t, 3), "box": {
            "x": max(0.0, min(100.0, bx / W * 100.0)),
            "y": max(0.0, min(100.0, by / H * 100.0)),
            "w": max(0.0, min(100.0, bw / W * 100.0)),
            "h": max(0.0, min(100.0, bh / H * 100.0)),
        }})

    cap.release()
    track = smooth_and_pad(track)
    print(json.dumps({"track": track, "tracker": tracker_name}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
