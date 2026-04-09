import { NextRequest, NextResponse } from "next/server";
import { apiDt, fr24Get } from "@/lib/fr24";

type AirportFull = {
  name?: string;
  iata?: string;
  icao?: string;
  city?: string;
  country?: { name?: string };
  timezone?: { name?: string };
};

type FlightRow = {
  flight?: string;
  callsign?: string;
  orig_icao?: string;
  dest_icao?: string;
  datetime_takeoff?: string;
  datetime_landed?: string;
  fr24_id?: string;
};

const ROW_CAP = 300;
const MIN_CHUNK_MS = 2 * 3600 * 1000; // 2h
const COARSE_CHUNK_MS = 24 * 3600 * 1000; // 24h
const REQ_MIN_GAP_MS = 2100;
const RETRY_429_SLEEP_MS = 62000;

function parseFr24Utc(raw?: string): Date | null {
  if (!raw) return null;
  const iso = raw.endsWith("Z") ? raw : `${raw}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function rowKey(r: FlightRow): string {
  return r.fr24_id || `${r.flight || ""}|${r.callsign || ""}|${r.datetime_takeoff || ""}|${r.datetime_landed || ""}`;
}

function dedupeRows(rows: FlightRow[]): FlightRow[] {
  const seen = new Set<string>();
  const out: FlightRow[] = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

type FetchCtx = { lastReqAt: number };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSliceBoth(icao: string, from: Date, to: Date, ctx: FetchCtx): Promise<FlightRow[]> {
  const now = Date.now();
  const gap = now - ctx.lastReqAt;
  if (ctx.lastReqAt > 0 && gap < REQ_MIN_GAP_MS) {
    await sleep(REQ_MIN_GAP_MS - gap);
  }
  ctx.lastReqAt = Date.now();
  try {
    const res = await fr24Get<{ data?: FlightRow[] }>(`/api/flight-summary/full`, {
      flight_datetime_from: apiDt(from),
      flight_datetime_to: apiDt(to),
      airports: `both:${icao}`,
      limit: String(ROW_CAP),
      sort: "asc",
    });
    return res.data || [];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("429")) {
      await sleep(RETRY_429_SLEEP_MS);
      ctx.lastReqAt = 0;
      const retry = await fr24Get<{ data?: FlightRow[] }>(`/api/flight-summary/full`, {
        flight_datetime_from: apiDt(from),
        flight_datetime_to: apiDt(to),
        airports: `both:${icao}`,
        limit: String(ROW_CAP),
        sort: "asc",
      });
      return retry.data || [];
    }
    throw e;
  }
}

async function fetchRangeMerged(icao: string, from: Date, to: Date, ctx: FetchCtx): Promise<FlightRow[]> {
  if (to.getTime() <= from.getTime()) return [];
  const rows = await fetchSliceBoth(icao, from, to, ctx);
  if (rows.length < ROW_CAP || to.getTime() - from.getTime() <= MIN_CHUNK_MS) {
    return rows;
  }
  const mid = new Date((from.getTime() + to.getTime()) / 2);
  const left = await fetchRangeMerged(icao, from, mid, ctx);
  const right = await fetchRangeMerged(icao, mid, to, ctx);
  return dedupeRows([...left, ...right]);
}

async function fetchAirportRowsMerged(icao: string, from: Date, to: Date): Promise<FlightRow[]> {
  const all: FlightRow[] = [];
  const ctx: FetchCtx = { lastReqAt: 0 };
  let cursor = from.getTime();
  const end = to.getTime();
  while (cursor < end) {
    const next = Math.min(cursor + COARSE_CHUNK_MS, end);
    const chunkRows = await fetchRangeMerged(icao, new Date(cursor), new Date(next), ctx);
    all.push(...chunkRows);
    cursor = next;
  }
  return dedupeRows(all);
}

function toHourSeries(rows: FlightRow[], col: "datetime_landed" | "datetime_takeoff", tz: string, start: Date, end: Date) {
  const byHour = Array.from({ length: 24 }, (_, i) => ({
    label: new Date(start.getTime() + i * 3600 * 1000).toLocaleString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      timeZone: tz,
      hour12: false,
    }),
    value: 0,
  }));

  for (const row of rows) {
    const ts = parseFr24Utc(row[col]);
    if (!ts || ts < start || ts > end) continue;
    const idx = Math.min(23, Math.max(0, Math.floor((ts.getTime() - start.getTime()) / 3600000)));
    byHour[idx].value += 1;
  }
  return byHour;
}

export async function GET(req: NextRequest) {
  try {
    const airport = (req.nextUrl.searchParams.get("airport") || process.env.DEMO_AIRPORT || "SEA")
      .trim()
      .toUpperCase();
    const now = new Date();
    const windowStart = new Date(now.getTime() - 24 * 3600 * 1000);
    const from48h = new Date(now.getTime() - 48 * 3600 * 1000);

    // Static airport endpoint is path-parameter based: /api/static/airports/{code}/full
    // (the prior query-param form returned FR24 404).
    const airportData = await fr24Get<AirportFull>(`/api/static/airports/${airport}/full`, {});
    const icao = (airportData.icao || airport).toUpperCase();
    const tz = airportData.timezone?.name || "UTC";

    const rows = await fetchAirportRowsMerged(icao, from48h, now);
    const inbound = rows.filter((r) => (r.dest_icao || "").toUpperCase() === icao);
    const outbound = rows.filter((r) => (r.orig_icao || "").toUpperCase() === icao);

    const arrivalsInWindow = inbound.filter((r) => {
      const d = parseFr24Utc(r.datetime_landed);
      return !!d && d >= windowStart && d <= now;
    });
    const departuresInWindow = outbound.filter((r) => {
      const d = parseFr24Utc(r.datetime_takeoff);
      return !!d && d >= windowStart && d <= now;
    });

    const arrivalsSeries = toHourSeries(arrivalsInWindow, "datetime_landed", tz, windowStart, now);
    const departuresSeries = toHourSeries(departuresInWindow, "datetime_takeoff", tz, windowStart, now);

    return NextResponse.json({
      airport: {
        name: airportData.name || airport,
        iata: airportData.iata || null,
        icao,
        city: airportData.city || null,
        country: airportData.country?.name || null,
        timezone: tz,
      },
      summary: {
        arrivals24h: arrivalsInWindow.length,
        departures24h: departuresInWindow.length,
      },
      arrivalsSeries,
      departuresSeries,
      arrivals: inbound,
      departures: outbound,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
