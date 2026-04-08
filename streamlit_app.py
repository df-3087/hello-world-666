"""
Minimal Streamlit dashboard: one demo airport + one demo flight (scope from .env).

Run from repo root:
    streamlit run streamlit_app.py

Requires .env with FR24_API_TOKEN (see .env.example). Never commit .env.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import streamlit as st
from fr24sdk.client import Client
from fr24sdk.exceptions import Fr24SdkError

from fr24_analytics.settings import api_token, demo_airport, demo_flight, demo_lookback_days

# FR24 flight-summary date range filters on first_seen, not takeoff/landed.
# Long-haul arrivals at SEA can have first_seen many hours before landing — widen the API window.
FIRST_SEEN_LOOKBACK_HOURS = 96


def _fmt_api_dt(ts: datetime) -> str:
    """FR24 /flight-summary expects YYYY-MM-DDTHH:MM:SS (UTC, no timezone suffix)."""
    return ts.astimezone(timezone.utc).replace(tzinfo=None, microsecond=0).strftime("%Y-%m-%dT%H:%M:%S")


def _hourly_counts_in_window(
    df: pd.DataFrame,
    time_col: str,
    airport_tz: str,
    window_start_utc: datetime,
    window_end_utc: datetime,
) -> tuple[pd.Series, int, int, str]:
    """
    Count movements per local clock hour (0-23) for rows whose `time_col` falls in
    [window_start_utc, window_end_utc] (UTC).

    Returns (hourly_series_24, peak_hour, peak_count, tz_label).
    """
    try:
        tz = ZoneInfo(airport_tz)
        tz_label = airport_tz
    except Exception:
        tz = timezone.utc
        tz_label = "UTC"

    if time_col not in df.columns or df.empty:
        z = pd.Series(0, index=range(24), dtype=int)
        return z, 0, 0, tz_label

    t = pd.to_datetime(df[time_col], errors="coerce", utc=True)
    w0 = pd.Timestamp(window_start_utc)
    w1 = pd.Timestamp(window_end_utc)
    mask = t.notna() & (t >= w0) & (t <= w1)
    sub = t[mask]
    if sub.empty:
        z = pd.Series(0, index=range(24), dtype=int)
        return z, 0, 0, tz_label

    local = sub.dt.tz_convert(tz)
    hourly = local.dt.hour.value_counts().reindex(range(24), fill_value=0).astype(int).sort_index()
    peak_hour = int(hourly.idxmax())
    peak_count = int(hourly.max())
    return hourly, peak_hour, peak_count, tz_label


def _show_movement_charts(
    inbound_df: pd.DataFrame,
    outbound_df: pd.DataFrame,
    airport_code: str,
    airport_tz: str,
    window_start_utc: datetime,
    window_end_utc: datetime,
) -> None:
    """Arrivals = landed hour; departures = takeoff hour (local)."""
    st.subheader("Airport traffic — last 24 hours (by event time)")
    st.caption(
        f"**Arrivals** count flights with `datetime_landed` in the last 24 hours (UTC rolling window). "
        f"**Departures** use `datetime_takeoff`. "
        f"Bars are **local clock hours** (`{airport_tz}`): **0 = midnight–00:59**, **20 = 8:00–8:59 PM**. "
        f"The API query uses a longer `first_seen` window ({FIRST_SEEN_LOOKBACK_HOURS}h) so long-haul flights "
        f"are not dropped before we filter by landing/takeoff time."
    )

    arr_h, arr_peak_h, arr_peak_n, tz_l = _hourly_counts_in_window(
        inbound_df, "datetime_landed", airport_tz, window_start_utc, window_end_utc
    )
    dep_h, dep_peak_h, dep_peak_n, _ = _hourly_counts_in_window(
        outbound_df, "datetime_takeoff", airport_tz, window_start_utc, window_end_utc
    )

    c1, c2 = st.columns(2)
    with c1:
        st.markdown(f"**Arrivals by hour landed ({tz_l})**")
        n_arr = int((pd.to_datetime(inbound_df["datetime_landed"], errors="coerce", utc=True).between(
            pd.Timestamp(window_start_utc), pd.Timestamp(window_end_utc), inclusive="both"
        )).sum()) if "datetime_landed" in inbound_df.columns else 0
        st.metric("Peak hour (arrivals)", f"{arr_peak_h:02d}:00", f"{arr_peak_n} landings" if arr_peak_n else "—")
        st.metric("Total landings (in window)", n_arr)
        st.bar_chart(pd.DataFrame({"landings": arr_h}).rename_axis(f"hour_{tz_l}"))

    with c2:
        st.markdown(f"**Departures by hour off blocks ({tz_l})**")
        n_dep = int((pd.to_datetime(outbound_df["datetime_takeoff"], errors="coerce", utc=True).between(
            pd.Timestamp(window_start_utc), pd.Timestamp(window_end_utc), inclusive="both"
        )).sum()) if "datetime_takeoff" in outbound_df.columns else 0
        st.metric("Peak hour (departures)", f"{dep_peak_h:02d}:00", f"{dep_peak_n} departures" if dep_peak_n else "—")
        st.metric("Total departures (in window)", n_dep)
        st.bar_chart(pd.DataFrame({"departures": dep_h}).rename_axis(f"hour_{tz_l}"))

    st.caption(f"Airport code used in API: `inbound:{airport_code}` / `outbound:{airport_code}`.")


def _show_diversion(df: pd.DataFrame, airport_code: str) -> None:
    st.subheader("Diversion snapshot (inbound sample)")
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
    st.metric("Diversion rate (inbound fetch)", f"{diversion_rate:.1f}%", f"{diverted_n}/{denominator} flights")

    if diverted_n > 0:
        show_cols = [
            c
            for c in ["flight", "callsign", "orig_icao", planned_col, actual_col, "datetime_landed"]
            if c in df.columns
        ]
        st.caption("Diverted flights (planned destination vs actual)")
        st.dataframe(df.loc[diverted, show_cols], use_container_width=True, hide_index=True)
    else:
        st.info("No diversions in this inbound sample.")


def main() -> None:
    st.set_page_config(page_title="FR24 demo dashboard", layout="wide")
    st.title("Flightradar24 — demo dashboard")
    st.caption(
        "Single-airport + single-flight scope from `.env` (DEMO_AIRPORT, DEMO_FLIGHT). "
        "Not for operational use."
    )

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
        st.header("Demo configuration")
        st.markdown(
            f"- **Airport:** `{airport_code}`\n"
            f"- **Flight:** `{flight_no}`\n"
            f"- **Flight lookback:** `{lookback}` days (UTC)"
        )
        st.markdown("Edit `.env` to change these values.")

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=lookback)
    start_api = _fmt_api_dt(start)
    end_api = _fmt_api_dt(end)

    window_start_24h = end - timedelta(hours=24)
    window_end_24h = end
    start_wide = end - timedelta(hours=FIRST_SEEN_LOOKBACK_HOURS)
    start_wide_api = _fmt_api_dt(start_wide)

    try:
        with Client(api_token=token) as client:
            airport_tz = "UTC"
            st.subheader(f"Airport — {airport_code}")
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
                if ap.lat is not None and ap.lon is not None:
                    st.map(pd.DataFrame({"lat": [ap.lat], "lon": [ap.lon]}), zoom=8)
            except Fr24SdkError as e:
                st.warning(f"Airport full data unavailable (plan or code): {e}")
                try:
                    light = client.airports.get_light(airport_code)
                    st.write(f"**{light.name}** — IATA `{light.iata or '—'}`, ICAO `{light.icao or '—'}`")
                except Fr24SdkError as e2:
                    st.error(f"Airport lookup failed: {e2}")

            st.divider()

            st.markdown("### Data pulls for charts")
            st.caption(
                f"Wider API window for `first_seen`: `{start_wide_api}` → `{end_api}` UTC "
                f"({FIRST_SEEN_LOOKBACK_HOURS}h). "
                f"Charts filter events to last 24h: `{_fmt_api_dt(window_start_24h)}` → `{end_api}` UTC."
            )

            inbound_rows: list = []
            outbound_rows: list = []
            try:
                in_resp = client.transport.request(
                    "GET",
                    "/api/flight-summary/light",
                    params={
                        "flight_datetime_from": start_wide_api,
                        "flight_datetime_to": end_api,
                        "airports": [f"inbound:{airport_code}"],
                        "limit": 20000,
                        "sort": "asc",
                    },
                )
                inbound_rows = in_resp.json().get("data", []) or []
                st.success(f"Inbound rows fetched: **{len(inbound_rows)}**")
            except Fr24SdkError as e:
                st.error(f"Inbound flight summary failed: {e}")

            try:
                out_resp = client.transport.request(
                    "GET",
                    "/api/flight-summary/light",
                    params={
                        "flight_datetime_from": start_wide_api,
                        "flight_datetime_to": end_api,
                        "airports": [f"outbound:{airport_code}"],
                        "limit": 20000,
                        "sort": "asc",
                    },
                )
                outbound_rows = out_resp.json().get("data", []) or []
                st.success(f"Outbound rows fetched: **{len(outbound_rows)}**")
            except Fr24SdkError as e:
                st.error(f"Outbound flight summary failed: {e}")

            inbound_df = pd.DataFrame(inbound_rows)
            outbound_df = pd.DataFrame(outbound_rows)

            if not inbound_df.empty or not outbound_df.empty:
                _show_movement_charts(
                    inbound_df,
                    outbound_df,
                    airport_code,
                    airport_tz,
                    window_start_24h,
                    window_end_24h,
                )
                st.divider()
                if not inbound_df.empty:
                    _show_diversion(inbound_df, airport_code)

            st.divider()

            st.subheader("Raw inbound rows (sample)")
            if inbound_df.empty:
                st.info("No inbound rows.")
            else:
                st.dataframe(inbound_df, use_container_width=True, hide_index=True)

            st.subheader("Raw outbound rows (sample)")
            if outbound_df.empty:
                st.info("No outbound rows.")
            else:
                st.dataframe(outbound_df, use_container_width=True, hide_index=True)

            st.divider()

            st.subheader(f"Flight number — {flight_no}")
            st.caption(
                f"Flight summary **full**, `{start_api}` → `{end_api}` UTC, `limit=25`."
            )
            try:
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
                st.error(f"Flight summary (flight) failed: {e}")

    except Fr24SdkError as e:
        st.error(f"API error: {e}")

    st.divider()
    st.caption("Data © Flightradar24 (via API). See docs/FR24_AIR_TRAFFIC_BRD.md for product context.")


if __name__ == "__main__":
    main()
