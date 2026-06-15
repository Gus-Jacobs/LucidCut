#!/usr/bin/env python3
"""
LucidCut Content Detection Worker

Pipeline:
  1. (optional) Extract audio -> Whisper transcription -> word-level profanity matching
  2. (optional, beta) NSFW imagery scan:
       - Region mode (beta): NudeNet object detector -> per-body-part bounding boxes,
         so the editor can place censor bars over the exact offending region.
       - Frame mode (fallback): Falconsai whole-frame classifier -> scene-level flags.
  3. Cluster per-frame detections into scenes with merged region boxes + keyframe tracks
  4. Copy source video into outputs and write <output>.results.json

All progress is reported on stdout as "[progress] N" / "[step-N] msg" lines that
server.js parses. results.json is written even on failure (status: "error").
"""

import os
import sys
import json
import re
import subprocess
import tempfile
import traceback
from typing import Dict, List, Optional

import numpy as np
import cv2

# ==========================================
# PROGRESS BAR INTERCEPTOR
# Intercepts Whisper's tqdm progress and maps it to a 10%-50% range for the UI
# ==========================================
class ProgressInterceptor:
    def __init__(self, stream):
        self.stream = stream
    def write(self, data):
        self.stream.write(data)
        if "%|" in data:
            match = re.search(r'(\d+)%\|', data)
            if match:
                w_pct = int(match.group(1))
                overall = 10 + int(w_pct * 0.4)
                print(f"\n[progress] {overall}", flush=True)
    def flush(self):
        self.stream.flush()

sys.stderr = ProgressInterceptor(sys.stderr)

def log(msg: str):
    print(f"\n{msg}", flush=True)

def progress(pct: int):
    print(f"\n[progress] {pct}", flush=True)


# ==========================================
# CONFIG
# ==========================================
FRAME_SAMPLE_RATE = 2          # frames analyzed per second of video
SCENE_GAP_SECONDS = 3.0        # detections closer than this merge into one scene
HARD_SEVERITY_SCORE = 0.70     # max confidence above this => "hard" (cut) severity
CLASSIFIER_MODEL = "Falconsai/nsfw_image_detection"

DEFAULT_PROFANITY = [
    "damn", "hell", "crap", "piss",
    "ass", "bastard", "bitch",
    "shit", "fuck", "motherfucker"
]

# NudeNet detector classes grouped into the user-facing categories.
# Faces / feet / armpits / bellies-covered are deliberately ignored as noise.
NUDENET_CATEGORIES = {
    "explicit": [
        "FEMALE_GENITALIA_EXPOSED",
        "MALE_GENITALIA_EXPOSED",
        "ANUS_EXPOSED",
        "FEMALE_BREAST_EXPOSED",
        "BUTTOCKS_EXPOSED",
    ],
    "revealing": [
        "FEMALE_GENITALIA_COVERED",
        "FEMALE_BREAST_COVERED",
        "BUTTOCKS_COVERED",
        "ANUS_COVERED",
    ],
    "suggestive": [
        "BELLY_EXPOSED",
        "MALE_BREAST_EXPOSED",
    ],
}

CLASS_LABELS = {
    "FEMALE_GENITALIA_EXPOSED": "Exposed genitalia",
    "MALE_GENITALIA_EXPOSED": "Exposed genitalia",
    "ANUS_EXPOSED": "Exposed nudity",
    "FEMALE_BREAST_EXPOSED": "Exposed chest",
    "BUTTOCKS_EXPOSED": "Exposed buttocks",
    "FEMALE_GENITALIA_COVERED": "Revealing attire",
    "FEMALE_BREAST_COVERED": "Revealing attire",
    "BUTTOCKS_COVERED": "Revealing attire",
    "ANUS_COVERED": "Revealing attire",
    "BELLY_EXPOSED": "Exposed midriff",
    "MALE_BREAST_EXPOSED": "Exposed chest",
}


# ==========================================
# DETECTORS (lazily imported so a missing package degrades, not crashes)
# ==========================================
class RegionNSFWDetector:
    """NudeNet object detector: returns per-region boxes in percent coordinates."""

    def __init__(self, enabled_classes: List[str], threshold: float):
        from nudenet import NudeDetector
        self.detector = NudeDetector()
        self.enabled_classes = set(enabled_classes)
        self.threshold = threshold
        log("[nsfw] NudeNet region detector loaded")

    def predict(self, frame_bgr: np.ndarray) -> List[Dict]:
        h, w = frame_bgr.shape[:2]
        if h == 0 or w == 0:
            return []
        regions = []
        for det in self.detector.detect(frame_bgr):
            cls = det.get("class", "")
            score = float(det.get("score", 0.0))
            if cls not in self.enabled_classes or score < self.threshold:
                continue
            x, y, bw, bh = det.get("box", [0, 0, 0, 0])
            regions.append({
                "class": cls,
                "label": CLASS_LABELS.get(cls, cls),
                "score": score,
                # percent coordinates, matching the editor's box format
                "box": {
                    "x": max(0.0, min(100.0, x / w * 100.0)),
                    "y": max(0.0, min(100.0, y / h * 100.0)),
                    "w": max(0.0, min(100.0, bw / w * 100.0)),
                    "h": max(0.0, min(100.0, bh / h * 100.0)),
                },
            })
        return regions


class FrameNSFWClassifier:
    """Whole-frame classifier fallback: confidence only, no regions."""

    def __init__(self, threshold: float):
        from transformers import pipeline
        from PIL import Image
        self.Image = Image
        self.model = pipeline("image-classification", model=CLASSIFIER_MODEL, device=-1)
        self.threshold = threshold
        log(f"[nsfw] Frame classifier loaded ({CLASSIFIER_MODEL})")

    def predict(self, frame_bgr: np.ndarray) -> List[Dict]:
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        results = self.model(self.Image.fromarray(rgb))
        for result in results:
            if result["label"].lower() in ("nsfw", "porn", "pornography"):
                score = float(result["score"])
                if score >= self.threshold:
                    return [{"class": "NSFW_FRAME", "label": "Sensitive content",
                             "score": score, "box": None}]
        return []


class ProfanityDetector:
    def __init__(self, words: List[str], sensitivity: int = 65):
        self.target_words = [w.lower().strip() for w in words if w and w.strip()]
        self.sensitivity = sensitivity

    def detect_from_whisper(self, segments: List[Dict]) -> List[Dict]:
        from difflib import SequenceMatcher
        self._matcher = SequenceMatcher
        matches = []
        matched_indices = set()

        for segment_idx, segment in enumerate(segments):
            for word_idx, word_obj in enumerate(segment.get('words', [])):
                word_text = word_obj.get('word', '').strip()
                if not word_text:
                    continue
                word_clean = re.sub(r'^[^\w]+|[^\w]+$', '', word_text, flags=re.UNICODE).lower()
                if not word_clean:
                    continue
                for target_word in self.target_words:
                    if self._is_match(word_clean, target_word):
                        match_key = (segment_idx, word_idx)
                        if match_key not in matched_indices:
                            matches.append({
                                "word": word_clean,
                                "target": target_word,
                                "start": float(word_obj.get('start', 0.0)),
                                "end": float(word_obj.get('end', 0.0)),
                                "severity": self._get_severity(target_word),
                                "confidence": 1.0
                            })
                            matched_indices.add(match_key)
                        break
        return matches

    def _ratio(self, a: str, b: str) -> float:
        return self._matcher(None, a, b).ratio()

    def _is_match(self, word: str, target: str) -> bool:
        if self.sensitivity <= 35:
            return word == target
        elif self.sensitivity <= 75:
            if word == target:
                return True
            if target in word:
                if len(target) <= 3 and len(word) > len(target) + 3:
                    return False
                return True
            if len(target) >= 3 and len(word) >= 2:
                if self._ratio(word, target) >= 0.85:
                    return True
            return False
        else:
            if target in word:
                return True
            if len(target) >= 3 and len(word) >= 2:
                if self._ratio(word, target) >= 0.70:
                    return True
            return False

    @staticmethod
    def _get_severity(word: str) -> int:
        severity_map = {"damn": 1, "hell": 1, "crap": 1, "piss": 2, "ass": 2,
                        "bastard": 3, "bitch": 3, "shit": 4, "fuck": 5, "motherfucker": 5}
        return severity_map.get(word.lower(), 3)


# ==========================================
# AUDIO / TRANSCRIPTION
# ==========================================
def extract_audio(video_path: str, output_audio: str) -> bool:
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "16000", output_audio],
            check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError as e:
        log(f"[audio] extraction failed: {e.stderr.decode(errors='replace')[-300:]}")
        return False


def transcribe_audio(audio_path: str) -> Optional[Dict]:
    try:
        import whisper
    except ImportError:
        log("[WARNING] whisper not available, skipping transcription")
        return None
    try:
        model = whisper.load_model("small")
        return model.transcribe(audio_path, language=None, verbose=False,
                                word_timestamps=True, task="transcribe", temperature=0.0)
    except Exception as e:
        log(f"[transcribe] failed: {e}")
        return None


# ==========================================
# IMAGERY SCAN
# ==========================================
def build_nsfw_detector(imagery_cfg: Dict):
    sensitivity = int(imagery_cfg.get("sensitivity", 50))
    # sensitivity 0 -> threshold 0.9 (only the most blatant), 100 -> 0.3 (aggressive)
    threshold = max(0.2, 0.9 - (sensitivity / 100.0) * 0.6)

    categories = imagery_cfg.get("categories", {})
    enabled_classes = []
    for category, on in categories.items():
        if on:
            enabled_classes.extend(NUDENET_CATEGORIES.get(category, []))
    if not enabled_classes:
        enabled_classes = NUDENET_CATEGORIES["explicit"]

    if imagery_cfg.get("regionDetection", True):
        try:
            return RegionNSFWDetector(enabled_classes, threshold), "region"
        except Exception as e:
            log(f"[WARNING] NudeNet unavailable ({e}); falling back to frame classifier")
    try:
        return FrameNSFWClassifier(threshold), "frame"
    except Exception as e:
        log(f"[ERROR] No NSFW detector available: {e}")
        return None, "none"


def scan_imagery(video_path: str, imagery_cfg: Dict) -> Dict:
    detector, mode = build_nsfw_detector(imagery_cfg)
    if detector is None:
        return {"mode": "none", "frames": []}

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        log("[ERROR] could not open video for imagery scan")
        return {"mode": mode, "frames": []}

    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    interval = max(1, int(fps / FRAME_SAMPLE_RATE)) if fps > 0 else 15

    frames = []
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % 30 == 0 and total_frames > 0:
            progress(55 + int((frame_idx / total_frames) * 35))
        if frame_idx % interval == 0:
            timestamp = frame_idx / fps if fps > 0 else 0.0
            try:
                regions = detector.predict(frame)
            except Exception as e:
                log(f"[nsfw] frame {frame_idx} failed: {e}")
                regions = []
            if regions:
                frames.append({"timestamp": timestamp, "frame_idx": frame_idx, "regions": regions})
        frame_idx += 1

    cap.release()
    return {"mode": mode, "frames": frames}


def _union_box(boxes: List[Dict]) -> Dict:
    x1 = min(b["x"] for b in boxes)
    y1 = min(b["y"] for b in boxes)
    x2 = max(b["x"] + b["w"] for b in boxes)
    y2 = max(b["y"] + b["h"] for b in boxes)
    return {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}


def _class_category(cls: str) -> str:
    for category, classes in NUDENET_CATEGORIES.items():
        if cls in classes:
            return category
    return "explicit"


def cluster_scenes(frames: List[Dict], mode: str) -> List[Dict]:
    """Group consecutive flagged frames into scenes. In region mode each scene
    carries merged per-class region boxes plus keyframe tracks for the editor."""
    if not frames:
        return []

    scenes = []
    current = [frames[0]]
    for f in frames[1:]:
        if f["timestamp"] - current[-1]["timestamp"] <= SCENE_GAP_SECONDS:
            current.append(f)
        else:
            scenes.append(_finalize_scene(current, mode))
            current = [f]
    scenes.append(_finalize_scene(current, mode))
    return scenes


def _finalize_scene(scene_frames: List[Dict], mode: str) -> Dict:
    all_scores = [r["score"] for f in scene_frames for r in f["regions"]]
    max_conf = max(all_scores)
    avg_conf = float(np.mean(all_scores))
    start = scene_frames[0]["timestamp"]
    end = scene_frames[-1]["timestamp"]
    # a single-frame scene still needs nonzero duration to censor/cut
    end = max(end, start + 1.0 / FRAME_SAMPLE_RATE)

    scene = {
        "type": "imagery",
        "start": round(start, 3),
        "end": round(end, 3),
        "confidence": round(avg_conf, 4),
        "max_confidence": round(max_conf, 4),
        "severity": "hard" if max_conf > HARD_SEVERITY_SCORE else "soft",
        "frame_count": len(scene_frames),
        "regions": [],
    }

    if mode != "region":
        return scene

    # Build one merged region per detected class across the scene's frames
    by_class: Dict[str, List[Dict]] = {}
    for f in scene_frames:
        for r in f["regions"]:
            if r["box"] is None:
                continue
            by_class.setdefault(r["class"], []).append(
                {"t": f["timestamp"], "box": r["box"], "score": r["score"], "label": r["label"]})

    for cls, hits in by_class.items():
        track = [{"t": round(h["t"], 3), "box": h["box"]} for h in hits]
        scene["regions"].append({
            "class": cls,
            "label": hits[0]["label"],
            "category": _class_category(cls),
            "score": round(max(h["score"] for h in hits), 4),
            "box": _union_box([h["box"] for h in hits]),
            "track": track,
        })

    if scene["regions"]:
        scene["bbox"] = _union_box([r["box"] for r in scene["regions"]])
    return scene


# ==========================================
# CONFIG NORMALIZATION
# ==========================================
def normalize_config(config: Dict) -> Dict:
    """Accept both the new structured config and the legacy flat shape."""
    impurity = config.get("impurityDetection", {}) or {}

    imagery_cfg = impurity.get("imageryDetection")
    if imagery_cfg is None:
        # legacy: {"imagery": {"Pornography": true, "Revealing attire": false, ...}}
        legacy = impurity.get("imagery", {}) or {}
        legacy_map = {"Pornography": "explicit", "Revealing attire": "revealing",
                      "Suggestive": "suggestive"}
        categories = {legacy_map[k]: bool(v) for k, v in legacy.items() if k in legacy_map}
        imagery_cfg = {
            "enabled": any(categories.values()) if categories else False,
            "regionDetection": True,
            "sensitivity": impurity.get("sensitivity", 50),
            "categories": categories or {"explicit": True},
        }

    return {
        "detectSwears": bool(impurity.get("detectSwears", True)),
        "swearList": impurity.get("swearList") or DEFAULT_PROFANITY,
        "sensitivity": int(impurity.get("sensitivity", 65)),
        "imagery": {
            "enabled": bool(imagery_cfg.get("enabled", False)),
            "regionDetection": bool(imagery_cfg.get("regionDetection", True)),
            "sensitivity": int(imagery_cfg.get("sensitivity", 50)),
            "categories": imagery_cfg.get("categories", {"explicit": True}),
        },
    }


# ==========================================
# MAIN PIPELINE
# ==========================================
def process_video(input_path: str, output_path: str, raw_config: Dict) -> Dict:
    cfg = normalize_config(raw_config or {})

    result = {
        "status": "processing", "input": input_path, "output": output_path,
        "config": cfg,
        "transcript": None, "language": None,
        "profanity_detections": [], "imagery_detections": [],
        "imagery_mode": "off",
        "statistics": {"profanity_count": 0, "imagery_count": 0},
        "error": None,
    }

    progress(5)

    # ---- 1. Speech / profanity ----
    if cfg["detectSwears"] and cfg["swearList"]:
        log("[step-1] Extracting audio...")
        audio_fd, temp_audio = tempfile.mkstemp(suffix=".wav", prefix="lucidcut_")
        os.close(audio_fd)
        try:
            if extract_audio(input_path, temp_audio):
                progress(10)
                log("[step-2] Transcribing audio...")
                whisper_result = transcribe_audio(temp_audio)
                if whisper_result:
                    result["transcript"] = whisper_result.get("text")
                    result["language"] = whisper_result.get("language")
                    log("[step-3] Detecting profanity...")
                    progress(50)
                    detector = ProfanityDetector(cfg["swearList"], cfg["sensitivity"])
                    matches = detector.detect_from_whisper(whisper_result.get("segments", []))
                    result["profanity_detections"] = matches
                    result["statistics"]["profanity_count"] = len(matches)
            else:
                log("[step-2] No audio track found, skipping transcription")
        finally:
            try:
                os.remove(temp_audio)
            except OSError:
                pass
    else:
        log("[step-1] Word detection disabled, skipping")

    progress(55)

    # ---- 2. Imagery (beta) ----
    if cfg["imagery"]["enabled"]:
        log("[step-4] Scanning imagery (beta)...")
        scan = scan_imagery(input_path, cfg["imagery"])
        result["imagery_mode"] = scan["mode"]
        scenes = cluster_scenes(scan["frames"], scan["mode"])
        result["imagery_detections"] = scenes
        result["statistics"]["imagery_count"] = len(scenes)
    else:
        log("[step-4] Imagery detection disabled, skipping")

    progress(92)

    # ---- 3. Stage source video into outputs ----
    log("[step-5] Finalizing...")
    try:
        subprocess.run(["ffmpeg", "-y", "-i", input_path, "-c", "copy", output_path],
                       check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        result["status"] = "error"
        result["error"] = f"ffmpeg copy failed: {e.stderr.decode(errors='replace')[-300:]}"
        return result

    progress(100)
    result["status"] = "completed"
    return result


def main():
    if len(sys.argv) < 3:
        print("usage: process_video.py <input> <output> [config-json]", file=sys.__stderr__)
        sys.exit(2)

    input_video, output_path = sys.argv[1], sys.argv[2]
    config = {}
    if len(sys.argv) > 3:
        try:
            config = json.loads(sys.argv[3])
        except Exception as e:
            log(f"[WARNING] invalid config JSON ({e}), using defaults")

    try:
        result = process_video(input_video, output_path, config)
    except Exception as e:
        traceback.print_exc(file=sys.__stderr__)
        result = {"status": "error", "error": str(e),
                  "profanity_detections": [], "imagery_detections": []}

    try:
        with open(output_path + '.results.json', 'w') as f:
            json.dump(result, f, indent=2)
    except Exception as e:
        log(f"[ERROR] failed to write results: {e}")

    sys.exit(0 if result.get("status") == "completed" else 1)


if __name__ == "__main__":
    main()
