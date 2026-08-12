#!/usr/bin/env python3
"""
Single frozen entry point for all worker tasks (so PyInstaller produces ONE exe
that bundles the heavy deps once, instead of three).

Usage:
  lucidcut-worker process <input> <output> <config-json>
  lucidcut-worker track   <payload-json>
  lucidcut-worker train
"""

import os
import sys

# make sibling worker modules importable both when frozen and from source
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    if len(sys.argv) < 2:
        print("usage: lucidcut-worker <process|track|train> [args...]", file=sys.stderr)
        sys.exit(2)

    cmd = sys.argv[1]
    # shift the subcommand off so each module sees the argv it already expects
    sys.argv = [sys.argv[0]] + sys.argv[2:]

    if cmd == "process":
        import process_video
        process_video.main()  # calls sys.exit() itself
    elif cmd == "track":
        import track_object
        sys.exit(track_object.main())
    elif cmd == "train":
        import train_model
        sys.exit(train_model.main())
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
