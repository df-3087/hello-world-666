#!/usr/bin/env bash
# Download major airline logos from Aviasales CDN into web/public/airlines/
# 40x40 retina-ready PNGs displayed at 20x20 in the UI.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/web/public/airlines"
mkdir -p "$DIR"

# ~60 major global carriers + key Asian low-costs visible at ICN/NRT/HND
CODES=(
  AA AC AF AI AM AS AY AZ BA BR CA CI CX CZ
  DL EI EK ET EY GA GF HA HU IB JL KE KL
  LA LH LO LX MH MS MU NH NK NZ OS OZ
  QF QR SA SK SN SQ SV TG TK TP UA VA VN VS WN WS
  7C BX LJ RS TW UO ZE ZH
  B6 DY FR U2 W6
)

echo "Downloading ${#CODES[@]} major airline logos to $DIR ..."

ok=0
fail=0
for code in "${CODES[@]}"; do
  dest="$DIR/${code}.png"
  if [ -f "$dest" ] && [ -s "$dest" ]; then
    ok=$((ok + 1))
    continue
  fi
  if curl -sSfL --max-time 6 -o "$dest" "https://pics.avs.io/40/40/${code}.png" 2>/dev/null; then
    if [ -s "$dest" ]; then
      ok=$((ok + 1))
    else
      rm -f "$dest"
      fail=$((fail + 1))
    fi
  else
    rm -f "$dest"
    fail=$((fail + 1))
  fi
done

echo "Done. OK: $ok  Failed/empty: $fail"
