# Video Censor Editor - Desktop Application

**Version:** 1.0.0  
**Created:** February 20, 2026  
**Status:** MVP with Local Electron Desktop App  
**Distribution:** Standalone executable (macOS, Windows, Linux)

---

> **⚡ NEW:** This project is now a standalone **Electron desktop application** that runs completely locally on your machine without requiring any external servers!
>
> - ✅ Download and run locally
> - ✅ No server costs or dependencies
> - ✅ Process videos offline
> - ✅ Your data stays on your computer
>
> See [ELECTRON_SETUP.md](./ELECTRON_SETUP.md) for build and packaging instructions.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Desktop App Distribution](#desktop-app-distribution)
3. [Core Concept](#core-concept)
4. [Feature Overview](#feature-overview)
5. [Technical Framework](#technical-framework)
6. [System Architecture](#system-architecture)
7. [Installation & Setup](#installation--setup)
8. [Known Limitations & Roadmap](#known-limitations--roadmap)

---

## Quick Start

### For Users (Using Pre-Built App)
Simply download the latest release for your platform:
- **macOS**: Download `Video-Censor-Editor.dmg` → Install like any app
- **Windows**: Download `Video-Censor-Editor-Setup.exe` → Run installer
- **Linux**: Download `Video-Censor-Editor.AppImage` → Run executable

That's it! Everything is bundled inside.

### For Developers (Building from Source)

```bash
# Clone the repo
git clone <repo-url>
cd video-censor-editor

# Run setup
chmod +x setup.sh
./setup.sh

# Start development
cd frontend && npm run dev

# Build for distribution
npm run package
```

See [ELECTRON_SETUP.md](./ELECTRON_SETUP.md) for detailed build instructions.

---

## Desktop App Distribution

The app is now packaged as a standalone Electron application:

| Platform | File | Size | Installation |
|----------|------|------|--------------|
| macOS    | `.dmg` | ~150MB | Drag to Applications |
| Windows  | `.exe` | ~160MB | Run installer |
| Linux    | `.AppImage` | ~155MB | Run executable |

**All dependencies are bundled** - users don't need to install anything else!

---

## Core Concept

### The Problem
- Content creators need to remove profanity and sensitive imagery from videos
- Manual scanning is time-consuming (54-minute episode = hours of work)
- Automated detection is available but often inaccurate
- No feedback loop to improve detection over time

### The Solution: Human-in-the-Loop Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    LucidCut Processing Pipeline                  │
└─────────────────────────────────────────────────────────────────┘

1. VIDEO UPLOAD
   └─ User uploads video + selects detection settings
   └─ Configures: sensitivity, word list, imagery detection

2. AUTOMATIC DETECTION
   └─ Transcription: Whisper (speech-to-text)
   └─ Word Matching: Compare against profanity word list
   └─ Imagery Scan: HSV-based NSFW detection on video frames
   └─ Scene Clustering: Group consecutive detections into segments

3. REVIEW SCREEN ← NEW!
   └─ User sees all detected issues
   └─ Can KEEP (correct), REMOVE (false positive), CHANGE severity
   └─ Can ADD manually detected scenes (missed by AI)
   └─ Feedback submitted to backend

4. CORRECTED RESULTS
   └─ False positives removed
   └─ Severity adjustments applied
   └─ Manual additions included

5. EDITOR
   └─ User applies final edits
   └─ Can blur regions, cut scenes, bleep audio
   └─ Preview changes in real-time

6. EXPORT
   └─ Video processed with applied edits
   └─ Feedback data stored for analysis
```

---

## System Architecture

### Tech Stack

**Frontend:**
- React 18 + TypeScript
- Vite (build tool)
- Modern CSS with Grid/Flexbox
- No external UI framework (custom components)

**Backend:**
- Node.js + Express
- In-memory job queue (PostgreSQL-ready)
- FFmpeg for video processing
- File-based storage (uploadable to S3)

**Python Worker:**
- Whisper (OpenAI's speech recognition)
- NudeNet (ONNX object detector — per-body-part NSFW bounding boxes, beta)
- Falconsai NSFW classifier (whole-frame fallback when region mode is off)
- OpenCV (video frame sampling)
- NumPy (array operations)

**Backend hardening:**
- ffmpeg invoked with discrete argv arrays (no shell — no command injection)
- Upload validation (type/extension/size), UUID-only stored filenames
- In-memory job queue with a concurrency cap; export status tracking
- Unit tests for the export-command builder (`npm test`)

### Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     Frontend (React)                         │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │   Upload    │→ │   Parsing    │→ │   Review     │        │
│  │   Screen    │  │   Progress   │  │   Screen     │        │
│  └─────────────┘  └──────────────┘  └──────────────┘        │
│        ↓                  ↓                  ↓               │
│   POST /upload       GET /jobs/:id     POST /feedback       │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│                Backend (Node.js)                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Job Queue Manager                                  │    │
│  │  - Stores job status                                │    │
│  │  - Captures progress messages                       │    │
│  │  - Serves results to frontend                       │    │
│  └─────────────────────────────────────────────────────┘    │
│        ↓                                                     │
│   Spawn Python Worker Process                               │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│             Python Worker (process_video.py)                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 1. Extract Audio from Video                          │   │
│  │ 2. Transcribe with Whisper                           │   │
│  │ 3. Align to word-level timestamps                    │   │
│  │ 4. Filter words against user's word list             │   │
│  │ 5. Extract frames at 0.5s intervals                  │   │
│  │ 6. Detect NSFW using HSV (with coordinates)          │   │
│  │ 7. Cluster detections into scenes                    │   │
│  │ 8. Copy video (optionally with edits)                │   │
│  │ 9. Write results.json                                │   │
│  └──────────────────────────────────────────────────────┘   │
│        ↓                                                     │
│   results.json + feedback.json (stored on disk)             │
└──────────────────────────────────────────────────────────────┘
```

---

## Feature Overview

### ✅ Implemented

1. **Video Upload & Settings**
   - Choose sensitivity level (0-100%)
   - Add custom swear words
   - Enable/disable imagery detection
   - Real-time backend toggle

2. **Real-time Parsing Progress**
   - WebSocket-like polling (1s interval)
   - Status messages: "🎙️ Transcribing...", "📹 Scanning imagery..."
   - Progress bar with percentage
   - Video preview during processing

3. **Automatic Detection**
   - Profanity detection (word-level timing)
   - Imagery detection with confidence scores
   - Spatial coordinates (bbox) for detected regions
   - Severity classification (hard=cut, soft=blur)
   - Scene clustering (merge consecutive frames)

4. **Review Screen** (NEW)
   - See all 58+ detections in a list
   - Expand each to view details
   - Mark as Keep/Remove/Change Severity (INDEPENDENT per item)
   - Add manual notes
   - **NEW**: Manually add scenes you detected
   - Real-time stat counters
   - Feedback submission to backend

5. **Results Panel**
   - Filterable detection list
   - Color-coded by type/severity
   - Click to seek video to detection time
   - Export detection data

6. **Professional Editor**
   - Timeline with zoom (1x-10x)
   - Video playback controls (speed, volume)
   - Issue markers on timeline
   - Issue list with severity indicators
   - Bleep/blur/cut action buttons
   - Real-time preview (stub)

7. **Feedback System**
   - Collect user corrections
   - Store as JSON for analysis
   - Calculate false positive rates
   - Suggest threshold improvements
   - Ready for ML training data

### 🚧 In Progress

- Actual blur/box rendering in Editor
- ML model integration
- Automatic threshold tuning based on feedback

### ⏳ Roadmap

- Custom ML model training on feedback data
- Scene context awareness (ignore intro sequences)
- Commercial NSFW API integration
- Batch processing
- Database storage (PostgreSQL)
- User accounts & projects

---

## Technical Framework

### Detection Algorithm

#### 1. Profanity Detection

```python
# Input: Video audio
# Process:
  1. Extract audio with ffmpeg
  2. Transcribe to text with Whisper (speech recognition)
  3. Align to word-level timestamps (whisperx)
  4. Filter words against user's word list
  5. Calculate severity based on word category
# Output: List of matched words with timestamps and confidence
```

#### 2. Imagery Detection (ML, beta)

Enabled only when the user ticks **Visual Detection** on the upload screen.
Two modes, selected by the "Map exact regions for censor bars" toggle:

```python
# Region mode (default) — NudeNet object detector
# Input: frames sampled at FRAME_SAMPLE_RATE (2/sec)
# Process:
  1. Run NudeNet on each sampled frame
  2. Keep detections whose class is in an enabled category
     (explicit / revealing / suggestive) and whose score >= threshold
  3. Convert each box to PERCENT coordinates (x,y,w,h) so it is
     resolution-independent and maps straight onto the editor canvas
  4. Cluster consecutive flagged frames into scenes; within a scene,
     merge each body-part class into one union box + a keyframe track
# Output per scene:
  { start, end, confidence, max_confidence, severity,
    regions: [{ class, label, category, score, box, track }], bbox }

# Frame mode (fallback) — Falconsai/nsfw_image_detection classifier
#   Whole-frame NSFW probability only; produces scene flags with no regions.

# Sensitivity (0-100) maps to the score threshold:
#   0   -> 0.90 (only the most blatant)
#   100 -> 0.30 (aggressive)
```

The editor turns each scene's `regions` into one-click censor bars
(pixelate / blur / solid), draggable and resizable on the preview canvas.

#### 3. Scene Clustering

```python
# Input: Per-frame detections [(timestamp, confidence, bbox), ...]
# Process:
  1. Merge frames within 1.0s window
  2. For each segment:
     - Calculate avg_confidence (mean of all frames)
     - Calculate max_confidence (highest frame)
     - Classify severity:
       * Hard (cut): max_confidence > 0.70
       * Soft (blur): 0.10 < max_confidence ≤ 0.70
     - Merge all bboxes: [min_x, min_y, max_w, max_h]
# Output: {start, end, confidence, max_confidence, severity, bbox, type}
```

### Current Thresholds

```python
# In backend/worker/process_video.py

FRAME_SAMPLE_RATE = 2          # frames analyzed per second of video
SCENE_GAP_SECONDS = 3.0        # detections closer than this merge into one scene
HARD_SEVERITY_SCORE = 0.70     # max confidence above this => "hard" (cut) severity
# Per-frame score threshold is derived from the user's sensitivity slider
# (0.90 at sensitivity 0 → 0.30 at sensitivity 100).
```

### Upload config shape

```jsonc
// POST /api/upload  field "impurityDetection"
{
  "detectSwears": true,
  "swearList": ["damn", "shit", "..."],
  "sensitivity": 65,                 // word-match fuzziness 0-100
  "imageryDetection": {              // beta; only scanned when enabled
    "enabled": true,
    "regionDetection": true,         // false => frame-classifier mode
    "sensitivity": 50,
    "categories": { "explicit": true, "revealing": false, "suggestive": false }
  }
}
```

---

## File Structure & Purpose

### Frontend (`/frontend`)

```
frontend/
├── package.json              # Dependencies: React, Vite, TypeScript
├── vite.config.ts           # Vite build config
├── tsconfig.json            # TypeScript config
├── index.html               # Entry point
├── src/
│   ├── main.tsx            # React root
│   ├── App.tsx             # Main app, router (upload→parsing→review→results→editor)
│   ├── App.css             # Global styles
│   └── components/
│       ├── Header.tsx      # Logo + home button
│       ├── VideoUploader.tsx   # Upload form + settings (sensitivity, words, imagery toggle)
│       ├── ParsingView.tsx     # Shows parsing progress + status messages
│       ├── ReviewScreen.tsx    # NEW: Review detected issues + manually add scenes
│       ├── ResultsPanel.tsx    # Display all detections in list
│       ├── Editor.tsx          # Timeline + issue markers + edit buttons
│       ├── DebugConsole.tsx    # In-browser console for logging
│       └── *.css               # Component styles
└── dist/                    # Built output (npm run build)
```

**Key Components:**

| Component | Purpose | Lines |
|-----------|---------|-------|
| `App.tsx` | Navigation flow between screens | 100 |
| `VideoUploader.tsx` | Upload video + configure settings | ~300 |
| `ParsingView.tsx` | Show progress during processing | 170 |
| `ReviewScreen.tsx` | Validate/correct detections + add manual scenes | 640 |
| `Editor.tsx` | Timeline UI + editing controls | 380 |
| `DebugConsole.tsx` | Real-time console logging | ~250 |

### Backend (`/backend`)

```
backend/
├── package.json            # Dependencies: Express, multer, uuid, cors
├── server.js              # HTTP API + job queue manager (245 lines)
├── uploads/               # Temporary video uploads
├── outputs/               # Processed videos + results.json + feedback.json
├── worker/
│   └── process_video.py   # Python worker (468 lines)
│       ├── detect_nsfw_simple()     # Per-frame NSFW detection with bbox
│       ├── detect_unsafe_segments() # Cluster + classify severity
│       ├── process_video()          # Main pipeline
│       └── Whisper integration      # Speech-to-text
├── analyze_feedback.py    # NEW: Analyze collected feedback data
└── FEEDBACK_SYSTEM.md     # Documentation
```

**Key Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness + ffmpeg/python availability |
| POST | `/api/upload` | Accept video file + settings, enqueue job |
| GET | `/api/jobs/:id` | Poll job status (no filesystem paths exposed) |
| GET | `/api/jobs/:id/results` | Fetch results.json |
| POST | `/api/jobs/:id/feedback` | Submit user corrections (saved to disk) |
| POST | `/api/jobs/:id/export` | Apply edits, start async ffmpeg render |
| GET | `/api/jobs/:id/export-status` | Poll render progress/result |
| GET | `/api/download/:id/:type` | Download `original` or `edited` output |

**Job States:**

```
queued → processing → completed
  ↑          ↓
  └─ failed (error)
```

### Python Worker

**File:** `backend/worker/process_video.py` (468 lines)

**Main Functions:**

```python
def detect_nsfw_simple(frame_rgb):
    """
    Per-frame NSFW detection using HSV skin detection.
    Returns: (confidence: float, bbox: [x, y, w, h] | None)
    """

def detect_unsafe_segments(video_path, fps, config):
    """
    Segment detection: cluster frames, classify severity, merge bboxes.
    Returns: [{start, end, confidence, max_confidence, severity, bbox, type}]
    """

def process_video(input_path, output_path, config):
    """
    Full pipeline:
    1. Extract audio
    2. Transcribe (Whisper)
    3. Align (whisperx)
    4. Filter words
    5. Detect imagery
    6. Write results.json
    """
```

---

## Installation & Setup

### Prerequisites

- Python 3.9+ (for worker)
- Node.js 18+ (for frontend + backend)
- FFmpeg (for video processing)
- 2GB+ free disk space

### Install

```bash
# Clone/navigate to project
cd /Users/gusjacobs/CODE

# Install backend
cd backend
npm install
python3 -m pip install -r requirements.txt  # If exists

# Install frontend
cd ../frontend
npm install
```

### Run

```bash
# Terminal 1: Backend (port 4000)
cd backend
node server.js

# Terminal 2: Frontend (port 5173)
cd frontend
npm run dev

# Open browser
open http://localhost:5173
```

Or use the quick-start script:
```bash
bash /Users/gusjacobs/CODE/quick-start.sh
```

---

## Usage Guide

### Basic Workflow

1. **Upload Video**
   - Click "Get Started"
   - Select video file
   - **Settings:**
     - 🔤 Word Sensitivity: 0-100% (lower = more permissive)
     - Add/edit profanity word list
     - ☑️ Detect Imagery: toggle ON/OFF
     - 📹 Imagery Sensitivity: 0-100%

2. **Wait for Parsing**
   - Progress bar shows: 0% → 100%
   - Status messages: "🎙️ Transcribing..." → "📹 Scanning..." → "✅ Complete!"
   - Can cancel anytime

3. **Review Detections** (NEW FEATURE)
   - See all detected issues in a list
   - For EACH detection:
     - Expand to see details
     - ✓ Keep (correct detection)
     - ✕ Remove (false positive)
     - ~ Change Severity (hard ↔ soft)
     - Add notes (optional)
   - **NEW**: Manually add missed scenes
     - Click "+ Add Scene You Detected"
     - Enter start/end time (in seconds)
     - Choose severity (hard/soft)
     - Submit

4. **View Results**
   - See corrected detection list
   - Click any issue to seek video
   - Review severity and timestamps

5. **Edit in Timeline**
   - Zoom timeline (1x-10x)
   - See issue markers
   - Select action per issue:
     - Bleep (audio)
     - Blur (region)
     - Cut (scene)
   - Preview changes (stub)

6. **Export**
   - Click "Export Video"
   - Processing happens server-side
   - Download processed video

### Feedback Analysis

```bash
# After collecting feedback from multiple videos:
cd backend
python3 analyze_feedback.py outputs/*.feedback.json

# Output shows:
# - Action summary (keep/remove/change %)
# - False positive patterns
# - Severity correction trends
# - Recommended threshold adjustments
```

---

## Review & Feedback System

### What Each Action Means

**✓ Keep (Correct)**
- User confirms the detection is accurate
- Builds confidence in model
- Used as training signal

**✕ Remove (False Positive)**
- Detection is wrong (e.g., intro scene, lighting)
- Frame is removed from results
- Signals: threshold too low or HSV needs tuning

**~ Change Severity**
- Detection is correct but classification is wrong
- E.g., "This is suggestive but not explicit" → Soft instead of Hard
- Signals: severity threshold misaligned

**➕ Add Scene (NEW)**
- User detected something AI missed
- Manually specify start/end time and severity
- Directly added to feedback and results
- Helps identify blindspots in model

### Feedback Data Structure

Stored at: `backend/outputs/<jobid>-<filename>.mp4.feedback.json`

```json
{
  "jobId": "d43b8ea6-393d-4855-aa49-9c1714ed7d85",
  "timestamp": "2025-02-20T14:47:23Z",
  "feedback": [
    {
      "id": "unsafe-274.82",
      "type": "unsafe",
      "action": "remove",
      "confidence": 1.0,
      "notes": "Intro sequence with map animation"
    },
    {
      "id": "manual-1613764044000",
      "type": "unsafe",
      "action": "add",
      "newSeverity": "hard",
      "start": 1234.5,
      "end": 1245.3,
      "notes": "Explicit scene AI missed"
    }
  ]
}
```

### Analysis Tool Output

```
📊 Analyzing 3 feedback file(s)...

ACTION SUMMARY
==============
  keep              :  42 ( 72.4%)
  remove            :  12 ( 20.7%)
  change_severity   :   4 (  6.9%)
  add               :   2 (  3.4%)

FALSE POSITIVES
===============
Found 12 false positives
  - Intro sequence with map animation (3x)
  - Character close-up with bright lighting (4x)
  - Battle scene armor reflections (5x)

RECOMMENDATIONS
===============
⚠️  HIGH FALSE POSITIVE RATE: 20.7%

Suggested new confidence threshold: 0.28 (up from 0.10)
```

---

## Known Limitations & Roadmap

### Current Limitations

#### 1. Visual detection is beta
- Uses NudeNet (region) / Falconsai (frame). Good but not perfect — always
  review results before exporting. The Review screen exists for exactly this.
- Sampling is 2 fps, so a body part visible for under ~0.5s may be missed.

#### 2. Censor boxes are static per scene
- Each detected region becomes a single box covering its full motion envelope
  across the scene (the union of every frame's box). It over-covers rather than
  under-covers. Per-keyframe motion tracking data is captured (`region.track`)
  but not yet animated in export.

#### 3. Feedback is collected, not yet auto-applied
- `analyze_feedback.py` summarizes corrections; threshold auto-tuning is future work.

#### 4. In-memory job state
- Jobs live in process memory (the Prisma schema is provided for a future DB).
  Restarting the backend drops job history; output files persist on disk for 24h.

### Testing

```bash
cd backend && npm test     # export-command builder unit tests (node:test)
python3 -m py_compile worker/process_video.py   # worker syntax check
```

### Roadmap

#### Phase 1: Feedback Collection (NOW)
- ✅ Collect false positive patterns
- ✅ Identify confidence distribution
- ✅ Document missed detections
- ⏳ Accumulate 100+ videos of corrections

#### Phase 2: Threshold Optimization (NEXT)
- 🚧 Analyze feedback patterns
- 🚧 Auto-calculate optimal thresholds per content type
- 🚧 A/B test threshold changes
- 🚧 Implement reinforcement learning signal

#### Phase 3: ML Model Training (FUTURE)
- Research commercial NSFW APIs (Clarifai, Content Moderator)
- Or train custom CNN on accumulated feedback data
- Options:
  - Transfer learning from ImageNet
  - Fine-tune YOLOv8 for detection regions
  - Use CLIP embeddings for semantic understanding

#### Phase 4: Production Features (Q3 2026)
- PostgreSQL database
- User accounts + project management
- Batch processing
- Webhook notifications
- API for integrations

---

## Debugging & Troubleshooting

### Frontend Issues

**Problem:** "Cannot GET /api/jobs/..."
- **Cause:** Backend not running
- **Fix:** `cd backend && node server.js`

**Problem:** Styles look broken
- **Cause:** CSS build issue
- **Fix:** `npm run build && npm run dev`

**Problem:** All detections change together when I select one
- **Cause:** State management bug (old version)
- **Fix:** Updated ReviewScreen with independent state per detection
- **Verify:** Check each detection has unique `id`

### Backend Issues

**Problem:** Port 4000 already in use
- **Fix:** `lsof -i :4000 | grep node | awk '{print $2}' | xargs kill -9`

**Problem:** Python worker fails silently
- **Fix:** Check backend logs: `node server.js 2>&1 | grep -A5 "error"`
- **Check:** Python deps: `python3 -c "import cv2, whisper; print('OK')"`

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `SyntaxError in process_video.py` | Python syntax error | `python3 -m py_compile worker/process_video.py` |
| `No module named 'cv2'` | OpenCV not installed | `pip3 install opencv-python` |
| `ffmpeg not found` | FFmpeg not in PATH | `brew install ffmpeg` (macOS) |
| `CORS error` | Frontend calling wrong backend | Edit backend URL in ParsingView.tsx |

---

## Contributing & Future Work

### Code Guidelines
- Use TypeScript for type safety
- Add JSDoc comments for public functions
- Test locally before committing
- Keep components under 500 lines

### Adding Features

1. **New Detection Type?**
   - Add to `process_video.py` worker
   - Return same format as profanity/imagery
   - Update ParsingView to display
   - Test end-to-end

2. **New UI Screen?**
   - Create React component in `src/components/`
   - Update `App.tsx` router/state
   - Add navigation buttons

3. **New Analysis Tool?**
   - Add to `backend/analyze_feedback.py`
   - Python script, run from CLI
   - Output to stdout or file

---

## License & Attribution

- Whisper: OpenAI (MIT)
- FFmpeg: GNU GPL
- OpenCV: BSD
- React: Meta (MIT)
- Express: Node.js Foundation

---

**Questions?** See `FEEDBACK_SYSTEM.md` for more on the review system, or `SOLUTION_SUMMARY.md` for the design rationale.

**Last Updated:** February 20, 2026
