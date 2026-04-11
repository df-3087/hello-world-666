import { NextRequest, NextResponse } from "next/server";
import { apiDt, fr24Get } from "@/lib/fr24";

export const runtime = "nodejs";
// FR24 rate limiting can force a retry after about a minute.
export const maxDuration = 120;

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
  datetime_gate_arrival?: string | null;
  datetime_gate_departure?: string | null;
  fr24_id?: string;
};

type FlightEvent = {
  type: string;
  timestamp?: string;
};

type FlightEventsRow = {
  fr24_id: string;
  events?: FlightEvent[];
};

const ROW_CAP = 300;
const MIN_CHUNK_MS = 2 * 3600 * 1000; // 2h
const COARSE_CHUNK_MS = 24 * 3600 * 1000; // 24h
const REQ_MIN_GAP_MS = 400;
const RETRY_429_SLEEP_MS = 62000;
const AIRPORT_CACHE_TTL_MS = 30 * 60 * 1000;

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
type TimeRange = { fromMs: number; toMs: number };
type AirportPayload = {
  airport: {
    name: string;
    iata: string | null;
    icao: string;
    city: string | null;
    country: string | null;
    timezone: string;
  };
  summary: {
    arrivals24h: number;
    departures24h: number;
  };
  arrivalsSeries: { label: string; value: number }[];
  departuresSeries: { label: string; value: number }[];
  arrivals: FlightRow[];
  departures: FlightRow[];
};
type CacheEntry = { expiresAt: number; payload: AirportPayload };

const airportCache = new Map<string, CacheEntry>();
const airportInflight = new Map<string, Promise<AirportPayload>>();

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
    const res = await fr24Get<{ data?: FlightRow[] }>(`/api/flight-summary/light`, {
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
      const retry = await fr24Get<{ data?: FlightRow[] }>(`/api/flight-summary/light`, {
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
  const pending: TimeRange[] = [{ fromMs: from.getTime(), toMs: to.getTime() }];
  const accepted: FlightRow[] = [];

  while (pending.length > 0) {
    const range = pending.pop();
    if (!range || range.toMs <= range.fromMs) continue;

    const rangeFrom = new Date(range.fromMs);
    const rangeTo = new Date(range.toMs);
    const rows = await fetchSliceBoth(icao, rangeFrom, rangeTo, ctx);

    if (rows.length < ROW_CAP || range.toMs - range.fromMs <= MIN_CHUNK_MS) {
      accepted.push(...rows);
      continue;
    }

    const midMs = Math.floor((range.fromMs + range.toMs) / 2);
    pending.push({ fromMs: midMs, toMs: range.toMs });
    pending.push({ fromMs: range.fromMs, toMs: midMs });
  }

  return dedupeRows(accepted);
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

function getCachedAirportPayload(cacheKey: string): AirportPayload | null {
  const cached = airportCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    airportCache.delete(cacheKey);
    return null;
  }
  return cached.payload;
}

async function fetchGateEvents(fr24Ids: string[], eventType: "gate_arrival" | "gate_departure"): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (fr24Ids.length === 0) return result;

  const BATCH = 10;
  const ctx: FetchCtx = { lastReqAt: 0 };

  for (let i = 0; i < fr24Ids.length; i += BATCH) {
    const batch = fr24Ids.slice(i, i + BATCH);
    const now = Date.now();
    const gap = now - ctx.lastReqAt;
    if (ctx.lastReqAt > 0 && gap < REQ_MIN_GAP_MS) {
      await sleep(REQ_MIN_GAP_MS - gap);
    }
    ctx.lastReqAt = Date.now();

    const doFetch = async () => {
      const res = await fr24Get<{ data?: FlightEventsRow[] }>(
        `/api/historic/flight-events/light`,
        { flight_ids: batch.join(","), event_types: eventType }
      );
      for (const row of res.data ?? []) {
        const ev = (row.events ?? []).find((e) => e.type === eventType);
        if (ev?.timestamp) result.set(row.fr24_id, ev.timestamp);
      }
    };

    try {
      await doFetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("429")) {
        await sleep(RETRY_429_SLEEP_MS);
        ctx.lastReqAt = 0;
        try { await doFetch(); } catch (retryErr) {
          console.error(`[fetchGateEvents:${eventType}] retry failed:`, retryErr);
        }
      } else {
        console.error(`[fetchGateEvents:${eventType}] batch failed (ids:`, batch.join(","), "):", msg);
      }
    }
  }

  return result;
}

async function buildAirportPayload(airport: string): Promise<AirportPayload> {
  const now = new Date();
  const windowHours = Math.min(24, Math.max(1, Number(process.env.DEV_WINDOW_HOURS || "24")));
  const windowStart = new Date(now.getTime() - windowHours * 3600 * 1000);

  const airportData = await fr24Get<AirportFull>(`/api/static/airports/${airport}/full`, {});
  const icao = (airportData.icao || airport).toUpperCase();
  const tz = airportData.timezone?.name || "UTC";

  const rows = await fetchAirportRowsMerged(icao, windowStart, now);
  const inbound = rows.filter((r) => (r.dest_icao || "").toUpperCase() === icao);
  const outbound = rows.filter((r) => (r.orig_icao || "").toUpperCase() === icao);

  const arrivals = inbound.filter((r) => {
    const d = parseFr24Utc(r.datetime_landed);
    return !!d && d >= windowStart && d <= now;
  });
  const departures = outbound.filter((r) => {
    const d = parseFr24Utc(r.datetime_takeoff);
    return !!d && d >= windowStart && d <= now;
  });

  const arrivalFr24Ids = arrivals.map((r) => r.fr24_id).filter((id): id is string => !!id);
  const departureFr24Ids = departures.map((r) => r.fr24_id).filter((id): id is string => !!id);

  const [gateArrivalsMap, gateDeparturesMap] = await Promise.all([
    fetchGateEvents(arrivalFr24Ids, "gate_arrival"),
    fetchGateEvents(departureFr24Ids, "gate_departure"),
  ]);

  const arrivalsWithGate = arrivals
    .map((r) => ({
      ...r,
      datetime_gate_arrival: r.fr24_id ? (gateArrivalsMap.get(r.fr24_id) ?? null) : null,
    }))
    .sort((a, b) => {
      const ta = parseFr24Utc(a.datetime_landed)?.getTime() ?? 0;
      const tb = parseFr24Utc(b.datetime_landed)?.getTime() ?? 0;
      return tb - ta;
    });

  const departuresSorted = [...departures]
    .map((r) => ({
      ...r,
      datetime_gate_departure: r.fr24_id ? (gateDeparturesMap.get(r.fr24_id) ?? null) : null,
    }))
    .sort((a, b) => {
      const ta = parseFr24Utc(a.datetime_takeoff)?.getTime() ?? 0;
      const tb = parseFr24Utc(b.datetime_takeoff)?.getTime() ?? 0;
      return tb - ta;
    });

  return {
    airport: {
      name: airportData.name || airport,
      iata: airportData.iata || null,
      icao,
      city: airportData.city || null,
      country: airportData.country?.name || null,
      timezone: tz,
    },
    summary: {
      arrivals24h: arrivals.length,
      departures24h: departures.length,
    },
    arrivalsSeries: toHourSeries(arrivals, "datetime_landed", tz, windowStart, now),
    departuresSeries: toHourSeries(departures, "datetime_takeoff", tz, windowStart, now),
    arrivals: arrivalsWithGate,
    departures: departuresSorted,
  };
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
    const cached = getCachedAirportPayload(airport);
    if (cached) {
      return NextResponse.json(cached);
    }

    const inflight = airportInflight.get(airport);
    if (inflight) {
      return NextResponse.json(await inflight);
    }

    const loadPromise = buildAirportPayload(airport);
    airportInflight.set(airport, loadPromise);

    try {
      const payload = await loadPromise;
      airportCache.set(airport, {
        expiresAt: Date.now() + AIRPORT_CACHE_TTL_MS,
        payload,
      });
      return NextResponse.json(payload);
    } finally {
      airportInflight.delete(airport);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
