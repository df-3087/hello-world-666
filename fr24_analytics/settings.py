"""Load configuration from environment (.env is optional; never commit .env)."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT / ".env")


def api_token() -> str:
    token = (os.environ.get("FR24_API_TOKEN") or "").strip()
    if not token:
        raise RuntimeError(
            "FR24_API_TOKEN is not set. Copy .env.example to .env and add your token."
        )
    return token


def demo_airport() -> str:
    return (os.environ.get("DEMO_AIRPORT") or "ESSA").strip().upper()


def demo_flight() -> str:
    return (os.environ.get("DEMO_FLIGHT") or "SK1415").strip().upper()


def demo_lookback_days() -> int:
    raw = (os.environ.get("DEMO_LOOKBACK_DAYS") or "7").strip()
    try:
        days = int(raw)
    except ValueError:
        return 7
    return max(1, min(days, 14))
