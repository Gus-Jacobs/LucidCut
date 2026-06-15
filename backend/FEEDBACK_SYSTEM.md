# LucidCut Review & Feedback System

## Overview

The Review & Feedback system is designed to address detection accuracy issues by enabling user feedback to drive continuous improvement. Instead of relying solely on static thresholds, LucidCut now includes:

1. **Review Screen** - Interactive validation of detected issues
2. **Feedback Storage** - Persistent storage of user corrections
3. **Analysis Tools** - Analyze patterns in false positives and corrections
4. **Threshold Optimization** - Data-driven recommendations for tuning

## How It Works

### Phase 1: Video Processing → Review Screen

1. User uploads video with settings (sensitivity, word list, imagery detection)
2. Backend processes video: transcription, word matching, NSFW detection
3. Frontend receives results with detected issues
4. **NEW**: Review screen appears instead of results screen

### Phase 2: User Review & Correction

In the Review Screen, user can:

- ✓ **Keep** - Mark detection as correct (builds confidence)
- ✕ **Remove** - Mark as false positive (helps identify over-detection)
- ~ **Change Severity** - Adjust from "Hard" (cut) to "Soft" (blur) or vice versa
- 📝 **Add Notes** - Document why correction was made

**Example Corrections:**
- "This is intro sequence, not NSFW" → Remove
- "This is cleavage but not explicit" → Change to Soft
- "Hard NSFW scene" → Keep as Hard

### Phase 3: Feedback Submission

- User submits feedback → Stored locally and sent to backend
- False positives are removed from results
- Severity changes update the action recommendations
- User proceeds to Editor or can skip to Results

### Phase 4: Analysis & Optimization

Backend stores feedback as `.feedback.json` alongside results:
```json
{
  "jobId": "abc123",
  "timestamp": "2025-02-20T14:30:00Z",
  "feedback": [
    {
      "id": "unsafe-274.82",
      "type": "unsafe",
      "action": "remove",
      "notes": "Intro sequence with map animation - false positive"
    },
    {
      "id": "unsafe-1945.28",
      "type": "unsafe",
      "action": "keep",
      "newSeverity": null
    }
  ]
}
```

Run analysis tool:
```bash
cd backend
python3 analyze_feedback.py outputs/*.feedback.json
```

**Output shows:**
- False positive rate
- Severity correction patterns
- Recommended threshold adjustments
- Average confidence of false positives

## Current Problem & Solution

### The Challenge

Your logs show:
- 58 detected segments in 54-min GoT S3E1 episode
- Flagging intro map as NSFW (false positive)
- Missing actual NSFW content
- **Root cause**: HSV skin detection can't distinguish clothed vs naked skin

### Why Feedback Helps

1. **Collect Data**: Gather real-world corrections from actual videos
2. **Identify Patterns**: See which scenes are commonly misclassified
3. **Optimize Thresholds**: Find confidence levels that minimize false positives
4. **Train Better Models**: Use feedback to eventually train ML models

### Example Analysis Output

```
======================== FALSE POSITIVES ========================

Found 8 false positives

  UNSAFE (8 items):
    - Intro sequence with map animation
    - Character close-up (face only, bright lighting)
    - Battle scene with armor reflections
    ... and 5 more

RECOMMENDATIONS
================

⚠️  HIGH FALSE POSITIVE RATE: 13.8%

Suggestions:
  - Increase confidence threshold from 0.10 to 0.20
  - Improve HSV ranges to exclude map scenes
  - Add scene context awareness

Average confidence of false positives: 0.18
Suggested new confidence threshold: 0.28
```

## Using Feedback for Improvement

### Short-term (Manual Tuning)

1. Process test videos with current settings
2. Use Review Screen to correct detections
3. Analyze feedback to see patterns
4. Manually adjust thresholds based on suggestions
5. Reprocess videos and iterate

### Medium-term (Threshold Optimization)

```python
# In process_video.py, update confidence thresholds based on feedback analysis
# Current: 0.10
# Suggested: 0.20 (if too many false positives)
# Or: 0.05 (if missing too much content)

CONFIDENCE_THRESHOLD = 0.20  # Adjust based on feedback
```

### Long-term (ML Model Training)

```
Use feedback dataset to train custom model:
- Input: Frames + detection regions
- Ground truth: User corrections from feedback
- Output: Better NSFW detection specifically for your content
```

## File Locations

- **Review Component**: `frontend/src/components/ReviewScreen.tsx`
- **Feedback Endpoint**: `backend/server.js` (POST `/api/jobs/:id/feedback`)
- **Feedback Storage**: `backend/outputs/*.feedback.json`
- **Analysis Tool**: `backend/analyze_feedback.py`

## Next Steps

1. ✅ Test Review Screen with GoT episode
2. ✅ Mark false positives and corrections
3. ✅ Run feedback analysis to see patterns
4. ⏳ Implement threshold adjustments
5. ⏳ Eventually train custom ML model if feedback shows patterns

## Notes

- Feedback is **optional** - can skip review to go straight to results
- All feedback is stored for future analysis
- No data is deleted when submitting feedback
- Backend can be extended to use feedback for automatic threshold tuning
