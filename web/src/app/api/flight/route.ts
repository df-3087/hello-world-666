import { NextRequest, NextResponse } from "next/server";
import { apiDt, fr24Get } from "@/lib/fr24";

export const runtime = "nodejs";
export const maxDuration = 60;

type FlightRow = {
  fr24_id?: string;
  flight?: string;
  callsign?: string;
  orig_icao?: string;
  dest_icao?: string;
  datetime_takeoff?: string;
  datetime_landed?: string;
  type?: string;
  reg?: string;
};

type FlightPayload = { flight: string; lookbackDays: number; legs: FlightRow[] };
type CacheEntry = { expiresAt: number; payload: FlightPayload };

const FLIGHT_CACHE_TTL_MS = 30 * 60 * 1000;
const flightCache = new Map<string, CacheEntry>();
const flightInflight = new Map<string, Promise<FlightPayload>>();

function getCachedFlight(key: string): FlightPayload | null {
  const cached = flightCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    flightCache.delete(key);
    return null;
  }
  return cached.payload;
}

async function buildFlightPayload(flight: string, lookbackDays: number): Promise<FlightPayload> {
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * 24 * 3600 * 1000);

  const res = await fr24Get<{ data?: FlightRow[] }>(`/api/flight-summary/light`, {
    flight_datetime_from: apiDt(from),
    flight_datetime_to: apiDt(now),
    flights: flight,
    limit: "20",
    sort: "desc",
  });

  return { flight, lookbackDays, legs: res.data || [] };
}

export async function GET(req: NextRequest) {
  try {
    const flight = (req.nextUrl.searchParams.get("flight") || process.env.DEMO_FLIGHT || "KE41")
      .trim()
      .toUpperCase();
    const lookbackDays = Number(process.env.DEMO_LOOKBACK_DAYS || "7");
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
