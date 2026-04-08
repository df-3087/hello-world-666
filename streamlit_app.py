"""
Minimal Streamlit dashboard: one demo airport + one demo flight (scope from .env).

Run from repo root:
    streamlit run streamlit_app.py

Requires .env with FR24_API_TOKEN (see .env.example). Never commit .env.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import streamlit as st
from fr24sdk.client import Client
from fr24sdk.exceptions import Fr24SdkError

from fr24_analytics.settings import api_token, demo_airport, demo_flight, demo_lookback_days

# flight-summary date range filters on first_seen, not takeoff/landed.
# Rolling chart = 24h of *events*; assume no leg is airborne >24h (first_seen → landing).
# => need first_seen back 24h + 24h = 48h before API “now”. (Longer routes may be missing.)
FIRST_SEEN_LOOKBACK_HOURS = 48

# Each API call returns up to `limit` legs; many plans cap well below 20_000 (e.g. 300).
# first_seen slices + merge (by fr24_id) recover full coverage. Larger slices → fewer HTTP calls
# (trade-off: more bisections when a busy slice hits the row cap).
FIRST_SEEN_CHUNK_HOURS = 24
# Reuse merged movement pulls across Streamlit reruns (widget changes, etc.).
MOVEMENT_CACHE_TTL_SEC = 120
MOVEMENT_CACHE_SCHEMA = 3
CHUNK_MIN_SPAN = timedelta(hours=2)
# When a slice returns this many rows, assume the plan cap was hit and subdivide the window.
ROW_SATURATE_COUNT = 300
# Essential tier returns at most 300 rows per response (same number used for saturation detection).
FLIGHT_SUMMARY_PAGE_LIMIT = 300
# Essential: 30 requests **per minute** (see https://fr24api.flightradar24.com/subscriptions-and-credits )
REQ_MIN_INTERVAL_SEC = 2.1
# After HTTP 429, wait before retrying a slice.
RATE_LIMIT_COOLDOWN_SEC = 62.0


def _fmt_api_dt(ts: datetime) -> str:
    """FR24 /flight-summary expects YYYY-MM-DDTHH:MM:SS (UTC, no timezone suffix)."""
    return ts.astimezone(timezone.utc).replace(tzinfo=None, microsecond=0).strftime("%Y-%m-%dT%H:%M:%S")


def _airport_codes_for_api(ap: Any | None, user_code: str) -> list[str]:
    """Prefer ICAO in API filters (e.g. KSEA); FR24 is most reliable with 4-letter codes."""
    out: list[str] = []
    if ap is not None:
        if getattr(ap, "icao", None):
            out.append(str(ap.icao).strip().upper())
        if getattr(ap, "iata", None):
            out.append(str(ap.iata).strip().upper())
    u = user_code.strip().upper()
    if u and u not in out:
        out.append(u)
    seen: set[str] = set()
    uniq: list[str] = []
    for c in out:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def _row_dedupe_key(r: dict[str, Any]) -> str:
    fid = r.get("fr24_id")
    if fid is not None:
        return f"id:{fid}"
    return (
        f"f:{r.get('flight')}|to:{r.get('datetime_takeoff')}|ld:{r.get('datetime_landed')}|h:{r.get('hex')}"
    )


class RequestPacer:
    """Pace HTTP calls so a dashboard refresh stays under FR24 per-minute rate limits."""

    __slots__ = ("_min_interval", "_last")

    def __init__(self, min_interval_sec: float = REQ_MIN_INTERVAL_SEC):
        self._min_interval = min_interval_sec
        self._last = 0.0

    def wait(self) -> None:
        now = time.monotonic()
        if self._last > 0:
            gap = now - self._last
            if gap < self._min_interval:
                time.sleep(self._min_interval - gap)
        self._last = time.monotonic()


def _dedupe_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for r in rows:
        k = _row_dedupe_key(r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def _fetch_flight_summary_slice(
    client: Client,
    *,
    start_api: str,
    end_api: str,
    airport_filter: str,
    pacer: RequestPacer | None = None,
    http_calls: list[int] | None = None,
) -> list[dict[str, Any]]:
    last_err: Fr24SdkError | None = None
    for attempt in range(3):
        if pacer is not None:
            pacer.wait()
        if http_calls is not None:
            http_calls[0] += 1
        try:
            resp = client.transport.request(
                "GET",
                "/api/flight-summary/full",
                params={
                    "flight_datetime_from": start_api,
                    "flight_datetime_to": end_api,
                    "airports": airport_filter,
                    "limit": FLIGHT_SUMMARY_PAGE_LIMIT,
                    "sort": "asc",
                },
            )
            data = resp.json().get("data")
            return data if isinstance(data, list) else []
        except Fr24SdkError as e:
            last_err = e
            if "429" in str(e) and attempt < 2:
                time.sleep(RATE_LIMIT_COOLDOWN_SEC)
                continue
            raise
    assert last_err is not None
    raise last_err


def _fetch_first_seen_range_merged(
    client: Client,
    airport_filter: str,
    t0: datetime,
    t1: datetime,
    *,
    http_calls: list[int],
    pacer: RequestPacer | None = None,
) -> list[dict[str, Any]]:
    """
    Fetch [t0,t1] UTC (first_seen). If the slice hits the plan row cap, bisect until spans
    reach CHUNK_MIN_SPAN or the slice no longer saturates.
    """
    if t0 >= t1:
        return []
    a0, a1 = _fmt_api_dt(t0), _fmt_api_dt(t1)
    rows = _fetch_flight_summary_slice(
        client,
        start_api=a0,
        end_api=a1,
        airport_filter=airport_filter,
        pacer=pacer,
        http_calls=http_calls,
    )
    if len(rows) < ROW_SATURATE_COUNT or (t1 - t0) <= CHUNK_MIN_SPAN:
        return rows
    mid = t0 + (t1 - t0) / 2
    left = _fetch_first_seen_range_merged(client, airport_filter, t0, mid, http_calls=http_calls, pacer=pacer)
    right = _fetch_first_seen_range_merged(client, airport_filter, mid, t1, http_calls=http_calls, pacer=pacer)
    return _dedupe_rows(left + right)


def _iter_coarse_chunks(overall_start: datetime, overall_end: datetime, hours: int):
    cur = overall_start
    while cur < overall_end:
        nxt = min(cur + timedelta(hours=hours), overall_end)
        yield cur, nxt
        cur = nxt


def _split_inbound_outbound(rows: list[dict[str, Any]], icao: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split `both:{icao}` legs into arrivals (dest) vs departures (orig)."""
    icao_u = icao.strip().upper()
    inbound: list[dict[str, Any]] = []
    outbound: list[dict[str, Any]] = []
    for r in rows:
        dest = str(r.get("dest_icao") or r.get("destination_icao") or "").strip().upper()
        orig = str(r.get("orig_icao") or r.get("origin_icao") or "").strip().upper()
        if dest == icao_u:
            inbound.append(r)
        if orig == icao_u:
            outbound.append(r)
    return inbound, outbound


def _fetch_movement_dataset(
    client: Client,
    direction: str,
    codes: list[str],
    overall_start_utc: datetime,
    overall_end_utc: datetime,
    pacer: RequestPacer | None = None,
    chunk_hours: int = FIRST_SEEN_CHUNK_HOURS,
) -> tuple[list[dict[str, Any]], str, int]:
    """
    Merge legs across coarse time chunks + recursive refinement when a chunk saturates.
    Returns (rows, airport_filter_used, http_call_count).
    """
    pref = "inbound" if direction == "inbound" else "outbound"
    http_calls = [0]
    for code in codes:
        filt = f"{pref}:{code}"
        acc: list[dict[str, Any]] = []
        for c0, c1 in _iter_coarse_chunks(overall_start_utc, overall_end_utc, chunk_hours):
            part = _fetch_first_seen_range_merged(client, filt, c0, c1, http_calls=http_calls, pacer=pacer)
            acc.extend(part)
        acc = _dedupe_rows(acc)
        if acc:
            return acc, filt, http_calls[0]
    return [], f"{pref}:{codes[0] if codes else '?'}", http_calls[0]


def _fetch_airport_movements(
    client: Client,
    codes: list[str],
    overall_start_utc: datetime,
    overall_end_utc: datetime,
    pacer: RequestPacer,
    chunk_hours: int = FIRST_SEEN_CHUNK_HOURS,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """
    One `both:ICAO` query per first_seen slice, split client-side into arrivals vs departures.
    """
    if not codes:
        return [], []

    primary = codes[0]
    both_filt = f"both:{primary}"
    http_calls = [0]
    acc: list[dict[str, Any]] = []
    for c0, c1 in _iter_coarse_chunks(overall_start_utc, overall_end_utc, chunk_hours):
        part = _fetch_first_seen_range_merged(
            client, both_filt, c0, c1, http_calls=http_calls, pacer=pacer
        )
        acc.extend(part)
    acc = _dedupe_rows(acc)
    ins, outs = _split_inbound_outbound(acc, primary)
    return ins, outs


def _parse_api_dt_utc(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


@st.cache_data(
    ttl=MOVEMENT_CACHE_TTL_SEC,
    show_spinner="Fetching airport movements from Flightradar24…",
)
def _cached_airport_movements(
    api_token: str,
    primary_icao: str,
    start_wide_api: str,
    end_api: str,
    chunk_hours: int,
    cache_schema: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Disk-cached merged `both:` pulls."""
    _ = cache_schema  # bump MOVEMENT_CACHE_SCHEMA to invalidate cached pulls after logic changes
    start_wide = _parse_api_dt_utc(start_wide_api)
    end_utc = _parse_api_dt_utc(end_api)
    pacer = RequestPacer()
    with Client(api_token=api_token) as client:
        return _fetch_airport_movements(
            client, [primary_icao], start_wide, end_utc, pacer, chunk_hours=chunk_hours
        )


def _local_rolling_bounds(airport_tz: str) -> tuple[pd.Timestamp, pd.Timestamp, str]:
    try:
        tz = ZoneInfo(airport_tz)
        label = airport_tz
    except Exception:
        tz = timezone.utc
        label = "UTC"
    end_local = pd.Timestamp.now(tz)
    start_local = end_local - pd.Timedelta(hours=24)
    return start_local, end_local, label


def _rolling_hour_bins(
    start_local: pd.Timestamp,
    end_local: pd.Timestamp,
) -> tuple[list[str], pd.Timestamp, pd.Timestamp]:
    """24 one-hour bins from start_local (inclusive) to end_local (inclusive). Labels = left edge."""
    labels: list[str] = []
    for i in range(24):
        left = start_local + pd.Timedelta(hours=i)
        labels.append(left.strftime("%a %H:%M"))
    return labels, start_local, end_local


def _event_bin_index(ts_utc: pd.Timestamp, start_local: pd.Timestamp, end_local: pd.Timestamp) -> int | None:
    if ts_utc is pd.NaT:
        return None
    tl = ts_utc.tz_convert(start_local.tz)
    if tl < start_local or tl > end_local:
        return None
    secs = (tl - start_local).total_seconds()
    if secs < 0:
        return None
    idx = int(secs // 3600)
    if idx > 23:
        idx = 23
    return idx


def _rolling_hourly_counts(
    df: pd.DataFrame,
    time_col: str,
    start_local: pd.Timestamp,
    end_local: pd.Timestamp,
) -> tuple[pd.Series, str, int, int]:
    """
    Hourly counts for events in [start_local, end_local] using 24 rolling hour bins.
    Returns (series indexed by labels, peak_label, peak_count, events_in_window).
    """
    labels, _, _ = _rolling_hour_bins(start_local, end_local)
    counts = [0] * 24
    if time_col not in df.columns or df.empty:
        z = pd.Series(counts, index=labels, dtype=int)
        return z, "—", 0, 0

    t = pd.to_datetime(df[time_col], errors="coerce", utc=True)
    w0 = start_local.tz_convert("UTC")
    w1 = end_local.tz_convert("UTC")
    mask = t.notna() & (t >= w0) & (t <= w1)
    t_win = t[mask]
    in_window = int(t_win.shape[0])

    for ts in t_win:
        idx = _event_bin_index(ts, start_local, end_local)
        if idx is not None:
            counts[idx] += 1

    ser = pd.Series(counts, index=labels, dtype=int)
    peak_count = int(ser.max())
    if peak_count == 0:
        return ser, "—", 0, in_window
    peak_label = str(ser.idxmax())
    return ser, peak_label, peak_count, in_window


def _count_in_rolling(df: pd.DataFrame, col: str, start_local: pd.Timestamp, end_local: pd.Timestamp) -> int:
    if col not in df.columns or df.empty:
        return 0
    t = pd.to_datetime(df[col], errors="coerce", utc=True)
    w0 = start_local.tz_convert("UTC")
    w1 = end_local.tz_convert("UTC")
    return int(((t >= w0) & (t <= w1)).sum())


def _show_movement_charts(
    inbound_df: pd.DataFrame,
    outbound_df: pd.DataFrame,
    tz_l: str,
    start_local: pd.Timestamp,
    end_local: pd.Timestamp,
) -> None:
    st.subheader("Arrivals and departures — last 24 hours (local time)")
    win_str = f"{start_local.strftime('%Y-%m-%d %H:%M')} → {end_local.strftime('%Y-%m-%d %H:%M')} ({tz_l})"
    st.caption(
        f"**Time window:** {win_str}. "
        f"**Arrivals** are **landings** in that period; **departures** are **takeoffs**. "
        f"Each bar is one hour (**left → earlier**, **right → later**); the last bar ends at the current time."
    )

    arr_h, arr_peak_lbl, arr_peak_n, _ = _rolling_hourly_counts(
        inbound_df, "datetime_landed", start_local, end_local
    )
    dep_h, dep_peak_lbl, dep_peak_n, _ = _rolling_hourly_counts(
        outbound_df, "datetime_takeoff", start_local, end_local
    )

    c1, c2 = st.columns(2)
    with c1:
        st.markdown(f"**Arrivals by hour landed** ({tz_l})")
        n_arr = _count_in_rolling(inbound_df, "datetime_landed", start_local, end_local)
        st.metric("Peak hour (arrivals)", arr_peak_lbl, f"{arr_peak_n} landings" if arr_peak_n else "—")
        st.metric("Total landings (in window)", n_arr)
        st.bar_chart(pd.DataFrame({"landings": arr_h}))

    with c2:
        st.markdown(f"**Departures by hour off** ({tz_l})")
        n_dep = _count_in_rolling(outbound_df, "datetime_takeoff", start_local, end_local)
        st.metric("Peak hour (departures)", dep_peak_lbl, f"{dep_peak_n} departures" if dep_peak_n else "—")
        st.metric("Total departures (in window)", n_dep)
        st.bar_chart(pd.DataFrame({"departures": dep_h}))


def _show_diversion(df: pd.DataFrame) -> None:
    st.subheader("Diversions — flights that landed somewhere other than planned")
    planned_col = "dest_icao" if "dest_icao" in df.columns else "destination_icao"
    actual_col = "dest_icao_actual" if "dest_icao_actual" in df.columns else "destination_icao_actual"

    if planned_col not in df.columns or actual_col not in df.columns:
        st.info("Diversion fields are not available in the current payload.")
        return

    planned = df[planned_col].fillna("")
    actual = df[actual_col].fillna("")
    has_planned = planned != ""
    diverted = has_planned & (actual != "") & (planned != actual)

    denominator = int(has_planned.sum())
    diverted_n = int(diverted.sum())
    diversion_rate = (diverted_n / denominator * 100) if denominator else 0.0
    st.metric("Diversion rate (sample)", f"{diversion_rate:.1f}%", f"{diverted_n}/{denominator} flights")

    if diverted_n > 0:
        show_cols = [
            c
            for c in ["flight", "callsign", "orig_icao", planned_col, actual_col, "datetime_landed"]
            if c in df.columns
        ]
        st.caption("Diverted flights (planned destination vs actual)")
        st.dataframe(df.loc[diverted, show_cols], use_container_width=True, hide_index=True)
    else:
        st.info("No diversions in this sample.")


def main() -> None:
    st.set_page_config(page_title="FR24 demo dashboard", layout="wide")
    st.title("Flightradar24 — demo dashboard")

    try:
        token = api_token()
    except RuntimeError as e:
        st.error(str(e))
        st.info("Copy `.env.example` to `.env` in this folder and set `FR24_API_TOKEN`.")
        st.stop()

    airport_code = demo_airport()
    flight_no = demo_flight()
    lookback = demo_lookback_days()

    with st.sidebar:
        st.header("What you’re exploring")
        st.markdown(
            f"- **Airport:** `{airport_code}`\n"
            f"- **Featured flight:** `{flight_no}`\n"
            f"- **History length:** `{lookback}` days (UTC)"
        )
        st.markdown("Change these in your `.env` file and reload the page.")

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=lookback)
    start_api = _fmt_api_dt(start)
    end_api = _fmt_api_dt(end)

    # Minute-rounded API window for movement pulls: stable cache key + aligns captions.
    end_movement = end.replace(second=0, microsecond=0)
    start_wide = end_movement - timedelta(hours=FIRST_SEEN_LOOKBACK_HOURS)
    start_wide_api = _fmt_api_dt(start_wide)
    end_movement_api = _fmt_api_dt(end_movement)

    try:
        with Client(api_token=token) as client:
            airport_tz = "UTC"
            ap: Any | None = None
            st.subheader(f"Selected airport ({airport_code})")
            try:
                ap = client.airports.get_full(airport_code)
                airport_tz = ap.timezone.name if getattr(ap, "timezone", None) else "UTC"
                st.metric("Name", ap.name or "—")
                c1, c2, c3 = st.columns(3)
                with c1:
                    st.write(f"**IATA:** {ap.iata or '—'}")
                with c2:
                    st.write(f"**ICAO:** {ap.icao or '—'}")
                with c3:
                    st.write(f"**City / country:** {ap.city or '—'}, {ap.country.name}")
            except Fr24SdkError as e:
                st.warning(f"Airport full data unavailable (plan or code): {e}")
                ap = None
                try:
                    light = client.airports.get_light(airport_code)
                    st.write(f"**{light.name}** — IATA `{light.iata or '—'}`, ICAO `{light.icao or '—'}`")
                except Fr24SdkError as e2:
                    st.error(f"Airport lookup failed: {e2}")

            start_local, end_local, _tz_label = _local_rolling_bounds(airport_tz)

            codes = _airport_codes_for_api(ap, airport_code)

            st.divider()

            st.markdown("### Arrivals and departures")
            st.caption(
                f"Charts use a rolling local window ending now. "
                f"Underlying data is refreshed from Flightradar24 when this page loads (recent loads may reuse a saved copy)."
            )

            inbound_rows: list = []
            outbound_rows: list = []
            try:
                if not codes:
                    st.error("No airport code available for movement fetch.")
                else:
                    # Must match `_cached_airport_movements` return arity (currently two lists only).
                    inbound_rows, outbound_rows = _cached_airport_movements(
                        token,
                        codes[0],
                        start_wide_api,
                        end_movement_api,
                        FIRST_SEEN_CHUNK_HOURS,
                        MOVEMENT_CACHE_SCHEMA,
                    )
                    st.success(
                        f"Loaded **{len(inbound_rows)}** arrivals and **{len(outbound_rows)}** departures from Flightradar24."
                    )
            except Fr24SdkError as e:
                st.error(f"Could not load arrival and departure data: {e}")

            inbound_df = pd.DataFrame(inbound_rows)
            outbound_df = pd.DataFrame(outbound_rows)

            if inbound_df.empty and outbound_df.empty:
                st.warning(
                    "No arrival or departure data came back. Check your subscription, airport code, or try again later."
                )
            else:
                _show_movement_charts(
                    inbound_df,
                    outbound_df,
                    _tz_label,
                    start_local,
                    end_local,
                )
                st.divider()
                if not inbound_df.empty:
                    _show_diversion(inbound_df)

            st.divider()

            st.subheader("Arrival history")
            if inbound_df.empty:
                st.info("No arrival records to show.")
            else:
                st.dataframe(inbound_df, use_container_width=True, hide_index=True)

            st.subheader("Departure history")
            if outbound_df.empty:
                st.info("No departure records to show.")
            else:
                st.dataframe(outbound_df, use_container_width=True, hide_index=True)

            st.divider()

            st.subheader(f"Featured flight: {flight_no}")
            st.caption(f"Recent trips for **{flight_no}** over the history length set in your `.env`.")
            try:
                RequestPacer().wait()
                flight_resp = client.transport.request(
                    "GET",
                    "/api/flight-summary/full",
                    params={
                        "flight_datetime_from": start_api,
                        "flight_datetime_to": end_api,
                        "flights": flight_no,
                        "limit": 25,
                        "sort": "desc",
                    },
                )
                fdata = flight_resp.json().get("data", [])
                if fdata:
                    flight_df = pd.DataFrame(fdata)
                    st.dataframe(flight_df, use_container_width=True, hide_index=True)
                    st.metric("Legs returned", len(flight_df))
                else:
                    st.info("No legs for this flight number in the selected window.")
            except Fr24SdkError as e:
                st.error(f"Could not load this flight: {e}")

    except Fr24SdkError as e:
        st.error(f"API error: {e}")

    st.divider()
    st.caption("Data © Flightradar24 (via API). See docs/FR24_AIR_TRAFFIC_BRD.md for product context.")


if __name__ == "__main__":
    main()
