"""Run Moneycontrol morning sentiment scrape + LLM parse (writes daily cache)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from market.morning_sentiment import build_morning_sentiment  # noqa: E402


def main() -> None:
    force = "--refresh" in sys.argv
    payload = build_morning_sentiment(force_refresh=force)
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
