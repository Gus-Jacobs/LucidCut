#!/usr/bin/env python3
"""
Analyze collected feedback to improve detection thresholds.

Usage:
  python3 analyze_feedback.py [feedback_files_pattern]

Example:
  python3 analyze_feedback.py outputs/*.feedback.json
"""

import json
import glob
import sys
from collections import defaultdict

def analyze_feedback():
    pattern = sys.argv[1] if len(sys.argv) > 1 else "outputs/*.feedback.json"
    files = glob.glob(pattern)
    
    if not files:
        print(f"No feedback files found matching '{pattern}'")
        return
    
    print(f"\n📊 Analyzing {len(files)} feedback file(s)...\n")
    
    all_feedback = []
    
    for file_path in files:
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
                all_feedback.extend(data.get('feedback', []))
        except Exception as e:
            print(f"⚠️  Failed to read {file_path}: {e}")
    
    if not all_feedback:
        print("No feedback entries found.")
        return
    
    # Analyze by action
    action_counts = defaultdict(int)
    severity_changes = defaultdict(lambda: defaultdict(int))
    false_positives = []
    corrections = []
    
    for item in all_feedback:
        action = item.get('action', 'unknown')
        action_counts[action] += 1
        
        if action == 'remove':
            false_positives.append(item)
        elif action == 'change_severity':
            old_severity = 'hard' if item.get('type') == 'unsafe' else 'swear'
            new_severity = item.get('newSeverity', old_severity)
            severity_changes[item.get('type', 'unknown')][f"{old_severity} -> {new_severity}"] += 1
            corrections.append(item)
    
    print("=" * 60)
    print("ACTION SUMMARY")
    print("=" * 60)
    for action, count in sorted(action_counts.items(), key=lambda x: x[1], reverse=True):
        pct = (count / len(all_feedback)) * 100
        print(f"  {action:20s}: {count:3d} ({pct:5.1f}%)")
    
    print("\n" + "=" * 60)
    print("FALSE POSITIVES (Remove actions)")
    print("=" * 60)
    if false_positives:
        print(f"\nFound {len(false_positives)} false positives\n")
        
        # Group by type
        fp_by_type = defaultdict(list)
        for fp in false_positives:
            fp_by_type[fp.get('type', 'unknown')].append(fp)
        
        for fp_type, items in fp_by_type.items():
            print(f"\n  {fp_type.upper()} ({len(items)} items):")
            for item in items[:3]:  # Show first 3
                notes = item.get('notes', 'No notes')
                print(f"    - {notes[:60]}")
            if len(items) > 3:
                print(f"    ... and {len(items) - 3} more")
    else:
        print("\n  ✓ No false positives reported!")
    
    print("\n" + "=" * 60)
    print("SEVERITY CORRECTIONS")
    print("=" * 60)
    if corrections:
        print(f"\nFound {len(corrections)} severity adjustments\n")
        for dtype, changes in severity_changes.items():
            print(f"  {dtype.upper()}:")
            for change, count in changes.items():
                print(f"    {change}: {count}")
    else:
        print("\n  ✓ No severity corrections needed!")
    
    print("\n" + "=" * 60)
    print("RECOMMENDATIONS")
    print("=" * 60)
    
    fp_rate = (len(false_positives) / len(all_feedback)) * 100
    if fp_rate > 20:
        print(f"\n⚠️  HIGH FALSE POSITIVE RATE: {fp_rate:.1f}%")
        print("   Suggestions:")
        print("   - Increase confidence threshold for NSFW detection")
        print("   - Improve HSV skin detection ranges (reduce false skin detection)")
        print("   - Add scene context awareness (ignore intro sequences)")
    elif fp_rate > 5:
        print(f"\n⚠️  MODERATE FALSE POSITIVE RATE: {fp_rate:.1f}%")
        print("   Consider slight threshold adjustments")
    else:
        print(f"\n✓ GOOD FALSE POSITIVE RATE: {fp_rate:.1f}%")
    
    # Suggest threshold changes
    if false_positives:
        avg_confidence_fp = sum(fp.get('confidence', 0) for fp in false_positives if 'confidence' in fp) / len(false_positives) if false_positives else 0
        if avg_confidence_fp > 0:
            print(f"\n   Average confidence of false positives: {avg_confidence_fp:.2f}")
            suggested_threshold = avg_confidence_fp + 0.1
            print(f"   Suggested new confidence threshold: {suggested_threshold:.2f}")
    
    print("\n" + "=" * 60)
    print(f"Total feedback items analyzed: {len(all_feedback)}")
    print("=" * 60 + "\n")

if __name__ == '__main__':
    analyze_feedback()
