"""Download MediaPipe vision assets for offline / firewalled use.

Run once from the project root:   python scripts/download_vision_assets.py

The API server also does this automatically at startup when files are missing, so
you normally do not need this script. Files go to frontend/vendor/mediapipe/ and the
browser prefers them over the CDN.

No internet on this machine? See "Manual install" in README.md.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import vision_assets  # noqa: E402


def main() -> int:
    result = vision_assets.ensure_assets(log=print)
    if result["complete"]:
        print(f"\nDone. Assets saved to {vision_assets.DEFAULT_TARGET}")
        return 0
    print("\nStill missing:", ", ".join(result["missing"]))
    print("\nWhat went wrong:")
    for error in result["errors"]:
        print("  -", error)
    print(f"\nManual install: see README.md. Put the files in {vision_assets.DEFAULT_TARGET} and restart.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
