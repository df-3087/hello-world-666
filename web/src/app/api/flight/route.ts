import { NextRequest, NextResponse } from "next/server";
import { apiDt, fr24Get } from "@/lib/fr24";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

type FlightRow = {
  fr24_id?: string;
  flight?: string;
  callsign?: string;
  orig_icao?: string;
  orig_iata?: string;
  dest_icao?: string;
  dest_iata?: string;
  datetime_takeoff?: string;
  datetime_landed?: string;
  type?: string;
  reg?: string;
  duration_min?: number | null;
  actual_distance?: number | null;
  taxi_out_min?: number | null;
  taxi_in_min?: number | null;
  runway_takeoff?: string;
  runway_landed?: string;
};

type FlightEvent = { type: string; timestamp?: string };
type FlightEventsRow = { fr24_id: string; events?: FlightEvent[] };

type FlightPayload = {
  flight: string;
  lookbackDays: number;
  route: { orig_icao: string; orig_iata?: string; dest_icao: string; dest_iata?: string } | null;
  summary: {
    medianDurationMin: number | null;
    medianTaxiOutMin: number | null;
    medianTaxiInMin: number | null;
    mostCommonType: string | null;
    routeMode: string | null;
  };
  legs: FlightRow[];
};
type CacheEntry = { expiresAt: number; payload: FlightPayload };

const FLIGHT_CACHE_TTL_MS = 30 * 60 * 1000;
const REQ_MIN_GAP_MS = 400;
const RETRY_429_SLEEP_MS = 62000;
const flightCache = new Map<string, CacheEntry>();
const flightInflight = new Map<string, Promise<FlightPayload>>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCachedFlight(key: string): FlightPayload | null {
  const cached = flightCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    flightCache.delete(key);
    return null;
  }
  return cached.payload;
}

function parseFr24Utc(raw?: string): Date | null {
  if (!raw) return null;
  const iso = raw.endsWith("Z") ? raw : `${raw}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function diffMinutes(startUtc?: string, endUtc?: string): number | null {
  const s = parseFr24Utc(startUtc);
  const e = parseFr24Utc(endUtc);
  if (!s || !e) return null;
  const mins = Math.round((e.getTime() - s.getTime()) / 60000);
  return mins >= 0 && mins < 2880 ? mins : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function mostCommon(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

async function fetchGateEvents(
  fr24Ids: string[],
  eventTypes: string[]
): Promise<Map<string, Map<string, string>>> {
  const result = new Map<string, Map<string, string>>();
  if (fr24Ids.length === 0) return result;

  const BATCH = 10;
  let lastReqAt = 0;

  for (let i = 0; i < fr24Ids.length; i += BATCH) {
    const batch = fr24Ids.slice(i, i + BATCH);
    const now = Date.now();
    const gap = now - lastReqAt;
    if (lastReqAt > 0 && gap < REQ_MIN_GAP_MS) await sleep(REQ_MIN_GAP_MS - gap);
    lastReqAt = Date.now();

    const doFetch = async () => {
      const res = await fr24Get<{ data?: FlightEventsRow[] }>(
        `/api/historic/flight-events/light`,
        { flight_ids: batch.join(","), event_types: eventTypes.join(",") }
      );
      for (const row of res.data ?? []) {
        const evMap = new Map<string, string>();
        for (const ev of row.events ?? []) {
          if (ev.timestamp) evMap.set(ev.type, ev.timestamp);
        }
        if (evMap.size > 0) result.set(row.fr24_id, evMap);
      }
    };

    try {
      await doFetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("429")) {
        await sleep(RETRY_429_SLEEP_MS);
        lastReqAt = 0;
        try { await doFetch(); } catch { /* skip on second failure */ }
      }
    }
  }
  return result;
}

async function buildFlightPayload(flight: string, lookbackDays: number): Promise<FlightPayload> {
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * 24 * 3600 * 1000);

  const res = await fr24Get<{ data?: FlightRow[] }>(`/api/flight-summary/full`, {
    flight_datetime_from: apiDt(from),
    flight_datetime_to: apiDt(now),
    flights: flight,
    limit: "50",
    sort: "desc",
  });

  const legs: FlightRow[] = (res.data || []).map((r) => ({
    ...r,
    duration_min: diffMinutes(r.datetime_takeoff, r.datetime_landed),
    taxi_out_min: null,
    taxi_in_min: null,
  }));

  const fr24Ids = legs.map((r) => r.fr24_id).filter((id): id is string => !!id);
  const eventsMap = await fetchGateEvents(fr24Ids, ["gate_departure", "gate_arrival"]);

  for (const leg of legs) {
    if (!leg.fr24_id) continue;
    const evMap = eventsMap.get(leg.fr24_id);
    if (!evMap) continue;
    const gateDep = evMap.get("gate_departure");
    const gateArr = evMap.get("gate_arrival");
    if (gateDep) leg.taxi_out_min = diffMinutes(gateDep, leg.datetime_takeoff);
    if (gateArr) leg.taxi_in_min = diffMinutes(leg.datetime_landed, gateArr);
  }

  const routeLeg = legs.find((l) => l.orig_icao && l.dest_icao);
  const route = routeLeg
    ? { orig_icao: routeLeg.orig_icao!, orig_iata: routeLeg.orig_iata, dest_icao: routeLeg.dest_icao!, dest_iata: routeLeg.dest_iata }
    : null;

  const durations = legs.map((l) => l.duration_min).filter((d): d is number => d !== null && d !== undefined);
  const taxiOuts = legs.map((l) => l.taxi_out_min).filter((d): d is number => d !== null && d !== undefined);
  const taxiIns = legs.map((l) => l.taxi_in_min).filter((d): d is number => d !== null && d !== undefined);
  const types = legs.map((l) => l.type).filter((t): t is string => !!t);
  const routes = legs
    .filter((l) => l.orig_icao && l.dest_icao)
    .map((l) => `${l.orig_icao}-${l.dest_icao}`);

  return {
    flight,
    lookbackDays,
    route,
    summary: {
      medianDurationMin: median(durations),
      medianTaxiOutMin: median(taxiOuts),
      medianTaxiInMin: median(taxiIns),
      mostCommonType: mostCommon(types),
      routeMode: mostCommon(routes),
    },
    legs,
  };
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed, retryAfterMs } = checkRateLimit(`flight:${ip}`, {
    maxRequests: 5,
    windowMs: 60 * 1000,
  });
  if (!allowed) {
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    return NextResponse.json(
      { error: "Rate limit exceeded. Please wait before making another request." },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  try {
    const flight = (req.nextUrl.searchParams.get("flight") || process.env.DEMO_FLIGHT || "KE41")
      .trim()
      .toUpperCase();
    const lookbackDays = Number(process.env.DEMO_LOOKBACK_DAYS || "14");
    const cacheKey = `${flight}:${lookbackDays}`;

    const cached = getCachedFlight(cacheKey);
    if (cached) return NextResponse.json(cached);

    const inflight = flightInflight.get(cacheKey);
    if (inflight) return NextResponse.json(await inflight);

    const loadPromise = buildFlightPayload(flight, lookbackDays);
    flightInflight.set(cacheKey, loadPromise);

    try {
      const payload = await loadPromise;
      flightCache.set(cacheKey, { expiresAt: Date.now() + FLIGHT_CACHE_TTL_MS, payload });
      return NextResponse.json(payload);
    } finally {
      flightInflight.delete(cacheKey);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
