"use client";

import { useEffect, useMemo, useState } from "react";

type SeriesPoint = { label: string; value: number };
type AirportPayload = {
  airport: {
    name: string;
    iata: string | null;
    icao: string;
    city: string | null;
    country: string | null;
    timezone: string;
  };
  summary: { arrivals24h: number; departures24h: number };
  arrivalsSeries: SeriesPoint[];
  departuresSeries: SeriesPoint[];
  arrivals: Record<string, string | null | undefined>[];
  departures: Record<string, string | null | undefined>[];
  error?: string;
};

type FlightPayload = {
  flight: string;
  lookbackDays: number;
  legs: Record<string, string | null>[];
  error?: string;
};

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

function elapsedMinutes(startUtc: string | null | undefined, endUtc: string | null | undefined): string {
  if (!startUtc || !endUtc) return "--";
  const start = new Date(startUtc.endsWith("Z") ? startUtc : `${startUtc}Z`);
  const end = new Date(endUtc.endsWith("Z") ? endUtc : `${endUtc}Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return "--";
  const mins = Math.round((end.getTime() - start.getTime()) / 60000);
  if (mins < 0 || mins > 120) return "--";
  return `${mins} min`;
}

function SparkBars({ points }: { points: SeriesPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${points.length}, 1fr)`, gap: 4 }}>
        {points.map((p) => (
          <div key={p.label} title={`${p.label}: ${p.value}`}>
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
          <div key={p.label} style={{ textAlign: "center", fontSize: 10, color: "#6b7280", lineHeight: "14px" }}>
            {i % 3 === 0 ? extractTime(p.label) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  const [airportCode, setAirportCode] = useState("SEA");
  const [flightNo, setFlightNo] = useState("KE41");
  const [airportData, setAirportData] = useState<AirportPayload | null>(null);
  const [flightData, setFlightData] = useState<FlightPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canLoad = airportCode.trim().length > 0 && flightNo.trim().length > 0;

  const load = async () => {
    if (!canLoad) return;
    setLoading(true);
    setError(null);
    try {
      const [airportRes, flightRes] = await Promise.all([
        fetch(`/api/airport?airport=${encodeURIComponent(airportCode)}`),
        fetch(`/api/flight?flight=${encodeURIComponent(flightNo)}`),
      ]);
      const airportJson = (await airportRes.json()) as AirportPayload;
      const flightJson = (await flightRes.json()) as FlightPayload;
      if (!airportRes.ok) throw new Error(airportJson.error || "Airport request failed");
      if (!flightRes.ok) throw new Error(flightJson.error || "Flight request failed");
      setAirportData(airportJson);
      setFlightData(flightJson);
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

  const arrivalsPeak = useMemo(
    () => airportData?.arrivalsSeries.reduce((a, b) => (b.value > a.value ? b : a), { label: "--", value: 0 }),
    [airportData]
  );
  const departuresPeak = useMemo(
    () => airportData?.departuresSeries.reduce((a, b) => (b.value > a.value ? b : a), { label: "--", value: 0 }),
    [airportData]
  );

  return (
    <main className="page">
      <h1 className="title">FR24 Air Traffic Dashboard</h1>
      <p className="subtitle">Industry-style web MVP (Next.js) for airport activity and featured flight history.</p>

      <section className="card">
        <div className="controls">
          <input value={airportCode} onChange={(e) => setAirportCode(e.target.value.toUpperCase())} placeholder="Airport (SEA or KSEA)" />
          <input value={flightNo} onChange={(e) => setFlightNo(e.target.value.toUpperCase())} placeholder="Flight (KE41)" />
          <button onClick={load} disabled={!canLoad || loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
        <div className="help">Data source: Flightradar24 API. Window: rolling 24 hours for airport movements.</div>
      </section>

      {error ? <section className="card" style={{ color: "#b42318" }}>{error}</section> : null}

      <section className="grid" style={{ marginTop: 16 }}>
        <article className="card">
          <h3>Arrivals (Last 24h)</h3>
          <div className="kpi">
            <span>Total</span>
            <span className="metric">{airportData?.summary.arrivals24h ?? "--"}</span>
          </div>
          <div className="help">Peak hour: {arrivalsPeak?.label ?? "--"} ({arrivalsPeak?.value ?? 0})</div>
          <SparkBars points={airportData?.arrivalsSeries ?? []} />
        </article>

        <article className="card">
          <h3>Departures (Last 24h)</h3>
          <div className="kpi">
            <span>Total</span>
            <span className="metric">{airportData?.summary.departures24h ?? "--"}</span>
          </div>
          <div className="help">Peak hour: {departuresPeak?.label ?? "--"} ({departuresPeak?.value ?? 0})</div>
          <SparkBars points={airportData?.departuresSeries ?? []} />
        </article>
      </section>

      <section className="grid" style={{ marginTop: 16 }}>
        <article className="card">
          <h3>Arrival history</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Flight</th>
                  <th>From</th>
                  <th>Landed (local)</th>
                  <th>Taxi-in</th>
                </tr>
              </thead>
              <tbody>
                {(airportData?.arrivals ?? []).map((r, i) => (
                  <tr key={`${r.fr24_id || "a"}-${i}`}>
                    <td>{r.flight || r.callsign || "--"}</td>
                    <td>{r.orig_icao || "--"}</td>
                    <td>{toLocalTime(r.datetime_landed, airportData?.airport.timezone ?? "UTC")}</td>
                    <td>{elapsedMinutes(r.datetime_landed, r.datetime_gate_arrival)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="card">
          <h3>Departure history</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Flight</th>
                  <th>To</th>
                  <th>Takeoff (local)</th>
                  <th>Taxi-out</th>
                </tr>
              </thead>
              <tbody>
                {(airportData?.departures ?? []).map((r, i) => (
                  <tr key={`${r.fr24_id || "d"}-${i}`}>
                    <td>{r.flight || r.callsign || "--"}</td>
                    <td>{r.dest_icao || "--"}</td>
                    <td>{toLocalTime(r.datetime_takeoff, airportData?.airport.timezone ?? "UTC")}</td>
                    <td>{elapsedMinutes(r.datetime_gate_departure, r.datetime_takeoff)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h3>Featured flight: {flightData?.flight || flightNo}</h3>
        <table>
          <thead>
            <tr>
              <th>Flight</th>
              <th>Route</th>
              <th>Takeoff (UTC)</th>
              <th>Landed (UTC)</th>
              <th>Type</th>
              <th>Reg</th>
            </tr>
          </thead>
          <tbody>
            {(flightData?.legs ?? []).map((r, i) => (
              <tr key={`${r.fr24_id || "f"}-${i}`}>
                <td>{r.flight || r.callsign || "--"}</td>
                <td>{`${r.orig_icao || "--"} -> ${r.dest_icao || "--"}`}</td>
                <td>{r.datetime_takeoff || "--"}</td>
                <td>{r.datetime_landed || "--"}</td>
                <td>{r.type || "--"}</td>
                <td>{r.reg || "--"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
