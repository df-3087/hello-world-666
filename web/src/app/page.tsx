"use client";

import { useEffect, useMemo, useState } from "react";
import { extractIataPrefix } from "@/lib/airlines";

type SeriesPoint = { label: string; value: number };

type RunwayChartPoint = {
  label: string;
  value: number;
  lengthFt?: number | null;
  widthFt?: number | null;
};

type AirportPayload = {
  airport: {
    name: string;
    iata: string | null;
    icao: string;
    city: string | null;
    country: string | null;
    timezone: string;
  };
  direction: "dep" | "arr" | "both";
  summary: { arrivals24h: number; departures24h: number };
  arrivalsSeries: SeriesPoint[];
  departuresSeries: SeriesPoint[];
  departureRunways: RunwayChartPoint[];
  arrivalRunways: RunwayChartPoint[];
  arrivals: Record<string, string | null | undefined>[];
  departures: Record<string, string | null | undefined>[];
  error?: string;
};

type FlightLeg = {
  fr24_id?: string | null;
  flight?: string | null;
  callsign?: string | null;
  orig_icao?: string | null;
  orig_iata?: string | null;
  dest_icao?: string | null;
  dest_iata?: string | null;
  datetime_takeoff?: string | null;
  datetime_landed?: string | null;
  type?: string | null;
  reg?: string | null;
  duration_min?: number | null;
  taxi_out_min?: number | null;
  taxi_in_min?: number | null;
  runway_takeoff?: string | null;
  runway_landed?: string | null;
};

type FlightPayload = {
  flight: string;
  lookbackDays: number;
  route: { orig_icao: string; orig_iata?: string; dest_icao: string; dest_iata?: string } | null;
  summary: {
    medianDurationMin: number | null;
    mostCommonType: string | null;
    routeMode: string | null;
  };
  legs: FlightLeg[];
  error?: string;
};

/* ── helpers ─────────────────────────────────────────── */

function extractTime(label: string): string {
  const match = label.match(/\d{2}:\d{2}/);
  return match ? match[0] : label;
}

function toLocalTime(utcStr: string | null | undefined, tz: string): string {
  if (!utcStr) return "--";
  const iso = utcStr.endsWith("Z") ? utcStr : `${utcStr}Z`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "--";
  return d.toLocaleString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined) return "--";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function elapsedMinutes(startUtc: string | null | undefined, endUtc: string | null | undefined): string {
  if (!startUtc || !endUtc) return "--";
  const start = new Date(startUtc.endsWith("Z") ? startUtc : `${startUtc}Z`);
  const end = new Date(endUtc.endsWith("Z") ? endUtc : `${endUtc}Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return "--";
  const mins = Math.round((end.getTime() - start.getTime()) / 60000);
  if (mins < 0 || mins > 120) return "--";
  return `${mins} min`;
}

/** Native `title` tooltips for column headers and chart captions. */
const COLUMN_HELP = {
  flightHistory: {
    date: "Calendar date for this leg (from the takeoff timestamp).",
    route: "Origin and destination airports for this leg (IATA when available, else ICAO).",
    takeoff: "Wheels-up time at the departure airport, shown in that airport’s local time.",
    landing: "Wheels-on time at the arrival airport, shown in that airport’s local time.",
    depRwy: "Dep RWY: runway the flight took off from on this leg (from FR24).",
    arrRwy: "Arr RWY: runway the flight landed on for this leg (from FR24).",
    duration: "Gate-to-gate block time for this leg (wheels-off to wheels-on), when both times exist.",
    type: "ICAO aircraft type designator (e.g. B78X, A321).",
    reg: "Aircraft registration (tail number) for this leg.",
    taxiOut: "Taxi-out: minutes from gate departure to takeoff, when gate and takeoff times exist.",
    taxiIn: "Taxi-in: minutes from landing to gate arrival, when landing and gate times exist.",
  },
  departures: {
    flight: "Airline name and flight number for this movement.",
    to: "Destination airport for this departure (code, city, and country).",
    gateDep: "Gate departure time (pushback / off-block) in this airport’s local time, when reported.",
    takeoff: "Takeoff (wheels-up) time in this airport’s local time.",
    depRwy: "Dep RWY: runway this flight used for takeoff at this airport.",
    taxiOut: "Taxi-out: time from gate departure to wheels-up for this flight.",
    type: "ICAO aircraft type designator.",
  },
  arrivals: {
    flight: "Airline name and flight number for this movement.",
    from: "Origin airport for this arrival (code, city, and country).",
    landed: "Landing (wheels-on) time in this airport’s local time.",
    gateArr: "Gate arrival time (on-block) in this airport’s local time, when reported.",
    arrRwy: "Arr RWY: runway this flight used for landing at this airport.",
    taxiIn: "Taxi-in: time from wheels-down to gate arrival for this flight.",
    type: "ICAO aircraft type designator.",
  },
  charts: {
    hourlyDep: "Departures in each local hour during the rolling window (count of takeoffs per hour bucket).",
    hourlyArr: "Arrivals in each local hour during the rolling window (count of landings per hour bucket).",
    runwayTakeoff: "Takeoff runway (24h): how many departures used each runway at this airport in the window. Bar length is relative to the busiest runway.",
    runwayLanding: "Landing runway (24h): how many arrivals used each runway at this airport in the window. Bar length is relative to the busiest runway.",
  },
  summary: {
    medianDuration: "Median block time (wheels-off to wheels-on) across legs in the lookback window.",
    typicalAircraft: "Most common ICAO aircraft type across legs in the lookback window.",
  },
} as const;

/* ── SparkBars ───────────────────────────────────────── */

function SparkBars({ points }: { points: SeriesPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${points.length}, 1fr)`, gap: 4 }}>
        {points.map((p) => (
          <div key={p.label} title={`${p.value} flight(s) in this local hour bucket. (${p.label})`}>
            <div
              style={{
                height: 70,
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
                borderRadius: 6,
                background: "#eef3ff",
              }}
            >
              <div style={{ width: "70%", height: `${(p.value / max) * 100}%`, background: "#0b63f6", borderRadius: 6 }} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${points.length}, 1fr)`, gap: 4, marginTop: 4 }}>
        {points.map((p, i) => (
          <div
            key={p.label}
            style={{ textAlign: "center", fontSize: 10, color: "#6b7280", lineHeight: "14px" }}
            title={i % 3 === 0 ? `Hour label for this column (${p.label}).` : undefined}
          >
            {i % 3 === 0 ? extractTime(p.label) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function runwayMetaInline(p: RunwayChartPoint): string | null {
  const labeled: string[] = [];
  if (p.lengthFt != null && p.lengthFt > 0) {
    labeled.push(`length: ${Math.round(p.lengthFt).toLocaleString()} ft`);
  }
  if (p.widthFt != null && p.widthFt > 0) {
    labeled.push(`width: ${Math.round(p.widthFt).toLocaleString()} ft`);
  }
  return labeled.length ? labeled.join(", ") : null;
}

function RunwayBars({ title, points, headerTitle }: { title: string; points: RunwayChartPoint[]; headerTitle?: string }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className="runway-chart">
      <div className="runway-chart-title" title={headerTitle}>{title}</div>
      {points.length === 0 ? (
        <div className="runway-chart-empty">No runway data in this window.</div>
      ) : (
        <ul className="runway-chart-list">
          {points.map((p) => {
            const meta = runwayMetaInline(p);
            const tip = meta ? `${p.label} — ${meta} — ${p.value} flights` : `${p.label}: ${p.value}`;
            return (
              <li key={p.label} className="runway-chart-row">
                <span className="runway-chart-label" title={tip}>{p.label}</span>
                <span className="runway-chart-meta" title={meta ? tip : undefined}>
                  {meta ?? "\u00a0"}
                </span>
                <div
                  className="runway-chart-bar-slot"
                  title="Bar length is proportional to flight count versus the busiest runway on this chart (not a share of all airport traffic)."
                >
                  <div className="runway-chart-bar-wrap">
                    <div
                      className="runway-chart-bar"
                      style={{ width: `${(p.value / max) * 100}%` }}
                      title={tip}
                    />
                  </div>
                </div>
                <span className="runway-chart-count" title={`${p.value} flight(s) on this runway in the window.`}>{p.value}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── airline flight cell ──────────────────────────────── */

function FlightCell({ row }: { row: Record<string, string | null | undefined> }) {
  const flight = row.flight || row.callsign || "--";
  const name = row.airline_name;

  if (!name) return <>{flight}</>;

  return (
    <span className="airline-cell">
      <span className="airline-name">{name}</span>
      <span>{flight}</span>
    </span>
  );
}

/* ── safe JSON parse ─────────────────────────────────── */

async function safeJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

/* ── page ────────────────────────────────────────────── */

export default function HomePage() {
  const [flightNo, setFlightNo] = useState("KE41");
  const [flightData, setFlightData] = useState<FlightPayload | null>(null);
  const [depAirportData, setDepAirportData] = useState<AirportPayload | null>(null);
  const [arrAirportData, setArrAirportData] = useState<AirportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canLoad = flightNo.trim().length > 0;

  const load = async () => {
    if (!canLoad) return;
    setLoading(true);
    setError(null);
    try {
      const flightRes = await fetch(`/api/flight?flight=${encodeURIComponent(flightNo)}`);
      const flightJson = await safeJson<FlightPayload>(flightRes, "Flight API");
      if (!flightRes.ok) throw new Error(flightJson.error || "Flight request failed");
      setFlightData(flightJson);

      if (flightJson.route) {
        const { orig_icao, dest_icao } = flightJson.route;
        const [depRes, arrRes] = await Promise.all([
          fetch(`/api/airport?airport=${encodeURIComponent(orig_icao)}&direction=dep`),
          fetch(`/api/airport?airport=${encodeURIComponent(dest_icao)}&direction=arr`),
        ]);
        const depJson = await safeJson<AirportPayload>(depRes, "Departure airport API");
        const arrJson = await safeJson<AirportPayload>(arrRes, "Arrival airport API");
        if (!depRes.ok) throw new Error(depJson.error || "Departure airport request failed");
        if (!arrRes.ok) throw new Error(arrJson.error || "Arrival airport request failed");
        setDepAirportData(depJson);
        setArrAirportData(arrJson);
      } else {
        setDepAirportData(null);
        setArrAirportData(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── derived values ─────────────────── */

  const depPeak = useMemo(
    () => depAirportData?.departuresSeries.reduce((a, b) => (b.value > a.value ? b : a), { label: "--", value: 0 }),
    [depAirportData]
  );
  const arrPeak = useMemo(
    () => arrAirportData?.arrivalsSeries.reduce((a, b) => (b.value > a.value ? b : a), { label: "--", value: 0 }),
    [arrAirportData]
  );

  /* ── airport display helpers ─────────── */

  function airportShort(a: AirportPayload) {
    const code = a.airport.iata || a.airport.icao;
    return `${a.airport.name} (${code})`;
  }

  function airportFull(a: AirportPayload) {
    const parts = [airportShort(a)];
    if (a.airport.city || a.airport.country) {
      parts.push([a.airport.city, a.airport.country].filter(Boolean).join(", "));
    }
    return parts.join(" — ");
  }

  const routeLabel = depAirportData && arrAirportData
    ? `${airportShort(depAirportData)} → ${airportShort(arrAirportData)}`
    : flightData?.route
      ? `${flightData.route.orig_iata || flightData.route.orig_icao} → ${flightData.route.dest_iata || flightData.route.dest_icao}`
      : null;

  /* ── render ─────────────────────────── */

  return (
    <main className="page">
      <h1 className="title">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/plane-top.png" alt="aircraft" className="title-plane-img" />
        <span className="title-gradient">Know Your Flight</span>
        {" "}
        <span className="title-plain">Before You Fly</span>
      </h1>
      <p className="subtitle">Drop in your flight number. We'll show you how it's been behaving, what aircraft to expect, which runways it favours, and the live pulse of both airports — all in one place.</p>

      {/* ── Search ─────────────────────── */}
      <section className="card">
        <div className="controls">
          <input
            value={flightNo}
            onChange={(e) => setFlightNo(e.target.value.toUpperCase())}
            placeholder="Flight number (e.g. KE41)"
            onKeyDown={(e) => { if (e.key === "Enter") load(); }}
          />
          <button onClick={load} disabled={!canLoad || loading}>
            {loading ? "Loading…" : "Search"}
          </button>
        </div>
        <div className="help">Flight history: last {flightData?.lookbackDays ?? 7} days · Airport context: rolling 24 hours.</div>
      </section>

      {error && <section className="card" style={{ color: "#b42318" }}>{error}</section>}

      {/* ── Container 1: Flight history ── */}
      {flightData && (
        <section className="card" style={{ marginTop: 16 }}>
          <h3 className="airline-cell">
            {(() => {
              const iata = extractIataPrefix(flightData.flight);
              return iata ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/airlines/${iata}.png`}
                  width={36}
                  height={36}
                  alt={iata}
                  style={{ borderRadius: 4, flexShrink: 0 }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : null;
            })()}
            <span>{flightData.flight}</span>
            {routeLabel && <span style={{ fontWeight: 400, color: "var(--muted)", marginLeft: 8 }}>{routeLabel}</span>}
          </h3>

          <div className="summary-strip">
            <div className="summary-tile" title={COLUMN_HELP.summary.medianDuration}>
              <span className="summary-label">Median duration</span>
              <span className="summary-value">{fmtMinutes(flightData.summary.medianDurationMin)}</span>
            </div>
            <div className="summary-tile" title={COLUMN_HELP.summary.typicalAircraft}>
              <span className="summary-label">Typical aircraft</span>
              <span className="summary-value">{flightData.summary.mostCommonType || "--"}</span>
            </div>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th title={COLUMN_HELP.flightHistory.date}>Date</th>
                  <th title={COLUMN_HELP.flightHistory.route}>Route</th>
                  <th title={COLUMN_HELP.flightHistory.takeoff}>Takeoff</th>
                  <th title={COLUMN_HELP.flightHistory.landing}>Landing</th>
                  <th title={COLUMN_HELP.flightHistory.depRwy}>Dep RWY</th>
                  <th title={COLUMN_HELP.flightHistory.arrRwy}>Arr RWY</th>
                  <th title={COLUMN_HELP.flightHistory.duration}>Duration</th>
                  <th title={COLUMN_HELP.flightHistory.type}>Type</th>
                  <th title={COLUMN_HELP.flightHistory.reg}>Reg</th>
                  <th title={COLUMN_HELP.flightHistory.taxiOut}>Taxi-out</th>
                  <th title={COLUMN_HELP.flightHistory.taxiIn}>Taxi-in</th>
                </tr>
              </thead>
              <tbody>
                {flightData.legs.map((leg, i) => {
                  const tz = depAirportData?.airport.timezone ?? "UTC";
                  const arrTz = arrAirportData?.airport.timezone ?? "UTC";
                  return (
                    <tr key={`${leg.fr24_id || "f"}-${i}`}>
                      <td>{leg.datetime_takeoff ? new Date(leg.datetime_takeoff.endsWith("Z") ? leg.datetime_takeoff : `${leg.datetime_takeoff}Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "--"}</td>
                      <td>{`${leg.orig_iata || leg.orig_icao || "?"} → ${leg.dest_iata || leg.dest_icao || "?"}`}</td>
                      <td>{toLocalTime(leg.datetime_takeoff, tz)}</td>
                      <td>{toLocalTime(leg.datetime_landed, arrTz)}</td>
                      <td>{leg.runway_takeoff || "--"}</td>
                      <td>{leg.runway_landed || "--"}</td>
                      <td>{fmtMinutes(leg.duration_min)}</td>
                      <td>{leg.type || "--"}</td>
                      <td>{leg.reg || "--"}</td>
                      <td>{leg.taxi_out_min != null ? `${leg.taxi_out_min}m` : "--"}</td>
                      <td>{leg.taxi_in_min != null ? `${leg.taxi_in_min}m` : "--"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="coverage-footer">
            Showing {flightData.legs.length} leg{flightData.legs.length !== 1 ? "s" : ""} from the last {flightData.lookbackDays} days.
            Taxi times depend on gate event coverage from FR24.
          </div>
        </section>
      )}

      {/* ── Container 2: Departure airport ── */}
      {depAirportData && (
        <section className="card" style={{ marginTop: 16 }}>
          <h3>Departures from {airportFull(depAirportData)}</h3>

          <div className="kpi-row">
            <div className="kpi" title="Count of takeoffs from this airport in the rolling 24-hour window (same scope as the hourly chart).">
              <span>Total departures (24h)</span>
              <span className="metric">{depAirportData.summary.departures24h}</span>
            </div>
            <div className="kpi" title="Local hour with the most departures in the rolling window; number in parentheses is the count for that hour.">
              <span>Peak hour</span>
              <span className="metric">{depPeak?.label ?? "--"} ({depPeak?.value ?? 0})</span>
            </div>
          </div>

          <div className="chart-pair">
            <div>
              <div className="chart-pair-caption" title={COLUMN_HELP.charts.hourlyDep}>By hour (local)</div>
              <SparkBars points={depAirportData.departuresSeries} />
            </div>
            <RunwayBars title="Takeoff runway (24h)" headerTitle={COLUMN_HELP.charts.runwayTakeoff} points={depAirportData.departureRunways ?? []} />
          </div>

          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th className="col-flight" title={COLUMN_HELP.departures.flight}>Flight</th>
                  <th title={COLUMN_HELP.departures.to}>To</th>
                  <th title={COLUMN_HELP.departures.gateDep}>Gate Dep (local)</th>
                  <th title={COLUMN_HELP.departures.takeoff}>Takeoff (local)</th>
                  <th title={COLUMN_HELP.departures.depRwy}>Dep RWY</th>
                  <th title={COLUMN_HELP.departures.taxiOut}>Taxi-out</th>
                  <th title={COLUMN_HELP.departures.type}>Type</th>
                </tr>
              </thead>
              <tbody>
                {depAirportData.departures.map((r, i) => (
                  <tr key={`${r.fr24_id || "d"}-${i}`}>
                    <td className="col-flight"><FlightCell row={r} /></td>
                    <td>{r.dest_label || r.dest_iata || r.dest_icao || "--"}</td>
                    <td>{toLocalTime(r.datetime_gate_departure, depAirportData.airport.timezone)}</td>
                    <td>{toLocalTime(r.datetime_takeoff, depAirportData.airport.timezone)}</td>
                    <td>{r.runway_takeoff || "--"}</td>
                    <td>{elapsedMinutes(r.datetime_gate_departure, r.datetime_takeoff)}</td>
                    <td>{r.type || "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="coverage-footer">
            {depAirportData.departures.length} recent departure{depAirportData.departures.length !== 1 ? "s" : ""} shown.
            Window: rolling 24 hours. Timezone: {depAirportData.airport.timezone}.
          </div>
        </section>
      )}

      {/* ── Container 3: Arrival airport ── */}
      {arrAirportData && (
        <section className="card" style={{ marginTop: 16 }}>
          <h3>Arrivals at {airportFull(arrAirportData)}</h3>

          <div className="kpi-row">
            <div className="kpi" title="Count of landings at this airport in the rolling 24-hour window (same scope as the hourly chart).">
              <span>Total arrivals (24h)</span>
              <span className="metric">{arrAirportData.summary.arrivals24h}</span>
            </div>
            <div className="kpi" title="Local hour with the most arrivals in the rolling window; number in parentheses is the count for that hour.">
              <span>Peak hour</span>
              <span className="metric">{arrPeak?.label ?? "--"} ({arrPeak?.value ?? 0})</span>
            </div>
          </div>

          <div className="chart-pair">
            <div>
              <div className="chart-pair-caption" title={COLUMN_HELP.charts.hourlyArr}>By hour (local)</div>
              <SparkBars points={arrAirportData.arrivalsSeries} />
            </div>
            <RunwayBars title="Landing runway (24h)" headerTitle={COLUMN_HELP.charts.runwayLanding} points={arrAirportData.arrivalRunways ?? []} />
          </div>

          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th className="col-flight" title={COLUMN_HELP.arrivals.flight}>Flight</th>
                  <th title={COLUMN_HELP.arrivals.from}>From</th>
                  <th title={COLUMN_HELP.arrivals.landed}>Landed (local)</th>
                  <th title={COLUMN_HELP.arrivals.gateArr}>Gate Arr (local)</th>
                  <th title={COLUMN_HELP.arrivals.arrRwy}>Arr RWY</th>
                  <th title={COLUMN_HELP.arrivals.taxiIn}>Taxi-in</th>
                  <th title={COLUMN_HELP.arrivals.type}>Type</th>
                </tr>
              </thead>
              <tbody>
                {arrAirportData.arrivals.map((r, i) => (
                  <tr key={`${r.fr24_id || "a"}-${i}`}>
                    <td className="col-flight"><FlightCell row={r} /></td>
                    <td>{r.orig_label || r.orig_iata || r.orig_icao || "--"}</td>
                    <td>{toLocalTime(r.datetime_landed, arrAirportData.airport.timezone)}</td>
                    <td>{toLocalTime(r.datetime_gate_arrival, arrAirportData.airport.timezone)}</td>
                    <td>{r.runway_landed || "--"}</td>
                    <td>{elapsedMinutes(r.datetime_landed, r.datetime_gate_arrival)}</td>
                    <td>{r.type || "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="coverage-footer">
            {arrAirportData.arrivals.length} recent arrival{arrAirportData.arrivals.length !== 1 ? "s" : ""} shown.
            Window: rolling 24 hours. Timezone: {arrAirportData.airport.timezone}.
          </div>
        </section>
      )}
    </main>
  );
}
