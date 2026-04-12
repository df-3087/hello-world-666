#!/usr/bin/env python3
"""Regenerate web/src/data/airport-places.json from OurAirports (CC0)."""
import csv
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "src" / "data" / "airport-places.json"
URL = "https://ourairports.com/data/airports.csv"


def main() -> None:
    print("Fetching", URL, flush=True)
    raw = urlopen(URL, timeout=180).read().decode("utf-8")
    reader = csv.DictReader(raw.splitlines())
    out: dict[str, dict[str, str]] = {}
    for row in reader:
        iata = (row.get("iata_code") or "").strip().upper()
        icao = (row.get("icao_code") or "").strip().upper()
        ident = (row.get("ident") or "").strip().upper()
        city = (row.get("municipality") or "").strip()
        if not city:
            city = (row.get("name") or "").strip() or "?"
        iso = (row.get("iso_country") or "").strip().upper() or "?"
        rec = {"city": city, "country": iso}
        if len(iata) == 3:
            out[iata] = rec
        for code in (icao, ident):
            if len(code) == 4 and code.isalnum():
                out[code.upper()] = rec
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print("Wrote", len(out), "keys to", OUT)


if __name__ == "__main__":
    main()
