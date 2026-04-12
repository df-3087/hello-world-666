import { NextRequest, NextResponse } from "next/server";
import { apiDt, fr24Get } from "@/lib/fr24";
import { extractIataPrefix, airlineName } from "@/lib/airlines";
import { formatAirportLine } from "@/lib/airport-places";

export const runtime = "nodejs";
export const maxDuration = 120;

type Direction = "dep" | "arr" | "both";

type Fr24Runway = {
  designator?: string;
  /** Physical length in feet (FR24 static airports). */
  length?: number;
  /** Width in feet (FR24 static airports). */
  width?: number;
};

type AirportFull = {
  name?: string;
  iata?: string;
  icao?: string;
  city?: string;
  country?: { name?: string };
  timezone?: { name?: string };
  runways?: Fr24Runway[];
};

type FlightRow = {
  flight?: string;
  callsign?: string;
  orig_icao?: string;
  orig_iata?: string;
  dest_icao?: string;
  dest_iata?: string;
  datetime_takeoff?: string;
  datetime_landed?: string;
  datetime_gate_arrival?: string | null;
  datetime_gate_departure?: string | null;
  fr24_id?: string;
  type?: string;
  painted_as?: string;
  airline_name?: string;
  airline_iata?: string;
  runway_takeoff?: string;
  runway_landed?: string;
  /** Preformatted "ICN (Seoul, KR)" for departure rows (other airport). */
  dest_label?: string;
  /** Preformatted "NRT (Tokyo, JP)" for arrival rows (other airport). */
  orig_label?: string;
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
const MIN_CHUNK_MS = 2 * 3600 * 1000;
const COARSE_CHUNK_MS = 24 * 3600 * 1000;
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

type RunwaySeriesItem = {
  label: string;
  value: number;
  lengthFt: number | null;
  widthFt: number | null;
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
  direction: Direction;
  summary: {
    arrivals24h: number;
    departures24h: number;
  };
  arrivalsSeries: { label: string; value: number }[];
  departuresSeries: { label: string; value: number }[];
  /** Takeoff runway counts in the rolling window (same scope as departuresSeries). */
  departureRunways: RunwaySeriesItem[];
  /** Landing runway counts in the rolling window (same scope as arrivalsSeries). */
  arrivalRunways: RunwaySeriesItem[];
  arrivals: FlightRow[];
  departures: FlightRow[];
};
type CacheEntry = { expiresAt: number; payload: AirportPayload };

const airportCache = new Map<string, CacheEntry>();
const airportInflight = new Map<string, Promise<AirportPayload>>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function airportsParam(icao: string, direction: Direction): string {
  if (direction === "dep") return `outbound:${icao}`;
  if (direction === "arr") return `inbound:${icao}`;
  return `both:${icao}`;
}

async function fetchSlice(icao: string, direction: Direction, from: Date, to: Date, ctx: FetchCtx): Promise<FlightRow[]> {
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
      airports: airportsParam(icao, direction),
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
        airports: airportsParam(icao, direction),
        limit: String(ROW_CAP),
        sort: "asc",
      });
      return retry.data || [];
    }
    throw e;
  }
}

async function fetchRangeMerged(icao: string, direction: Direction, from: Date, to: Date, ctx: FetchCtx): Promise<FlightRow[]> {
  const pending: TimeRange[] = [{ fromMs: from.getTime(), toMs: to.getTime() }];
  const accepted: FlightRow[] = [];

  while (pending.length > 0) {
    const range = pending.pop();
    if (!range || range.toMs <= range.fromMs) continue;

    const rangeFrom = new Date(range.fromMs);
    const rangeTo = new Date(range.toMs);
    const rows = await fetchSlice(icao, direction, rangeFrom, rangeTo, ctx);

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

async function fetchAirportRowsMerged(icao: string, direction: Direction, from: Date, to: Date): Promise<FlightRow[]> {
  const all: FlightRow[] = [];
  const ctx: FetchCtx = { lastReqAt: 0 };
  let cursor = from.getTime();
  const end = to.getTime();
  while (cursor < end) {
    const next = Math.min(cursor + COARSE_CHUNK_MS, end);
    const chunkRows = await fetchRangeMerged(icao, direction, new Date(cursor), new Date(next), ctx);
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

const EMPTY_SERIES: { label: string; value: number }[] = [];
const EMPTY_RUNWAY_SERIES: RunwaySeriesItem[] = [];

type RunwayMeta = { lengthFt?: number; widthFt?: number };

function runwayLookupFromStatic(runways: Fr24Runway[] | undefined): Map<string, RunwayMeta> {
  const m = new Map<string, RunwayMeta>();
  if (!runways) return m;
  for (const rw of runways) {
    const raw = (rw.designator ?? "").trim().toUpperCase();
    if (!raw) continue;
    const meta: RunwayMeta = { lengthFt: rw.length, widthFt: rw.width };
    m.set(raw, meta);
    for (const part of raw.split("/")) {
      const p = part.trim().toUpperCase();
      if (p) m.set(p, meta);
    }
  }
  return m;
}

function lookupRunwayMeta(lookup: Map<string, RunwayMeta>, used: string): RunwayMeta | undefined {
  const k = used.trim().toUpperCase();
  if (!k) return undefined;
  if (lookup.has(k)) return lookup.get(k);
  let best: RunwayMeta | undefined;
  let bestKeyLen = -1;
  for (const des of lookup.keys()) {
    const match =
      des === k
      || (k.length >= 2 && des.startsWith(k))
      || (des.length >= 2 && k.startsWith(des));
    if (match && des.length > bestKeyLen) {
      best = lookup.get(des);
      bestKeyLen = des.length;
    }
  }
  return best;
}

function aggregateRunwaySeries(
  rows: FlightRow[],
  field: "runway_takeoff" | "runway_landed",
  lookup: Map<string, RunwayMeta>
): RunwaySeriesItem[] {
  const by = new Map<string, number>();
  for (const r of rows) {
    const rw = r[field]?.trim();
    if (!rw) continue;
    by.set(rw, (by.get(rw) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([label, value]) => {
      const meta = lookupRunwayMeta(lookup, label);
      const lenRaw = meta?.lengthFt;
      const len = lenRaw == null ? NaN : Number(lenRaw);
      const wRaw = meta?.widthFt;
      const w = wRaw == null ? NaN : Number(wRaw);
      return {
        label,
        value,
        lengthFt: Number.isFinite(len) && len > 0 ? len : null,
        widthFt: Number.isFinite(w) && w > 0 ? w : null,
      };
    })
    .sort((a, b) => b.value - a.value);
}

function tagAirlineInfo(rows: FlightRow[]): void {
  for (const r of rows) {
    const iata = extractIataPrefix(r.flight);
    if (!iata) continue;
    const name = airlineName(iata);
    if (name) {
      r.airline_name = name;
      r.airline_iata = iata;
    }
  }
}

async function buildAirportPayload(airport: string, direction: Direction): Promise<AirportPayload> {
  const now = new Date();
  const windowHours = Math.min(24, Math.max(1, Number(process.env.DEV_WINDOW_HOURS || "24")));
  const windowStart = new Date(now.getTime() - windowHours * 3600 * 1000);

  const airportData = await fr24Get<AirportFull>(`/api/static/airports/${airport}/full`, {});
  const icao = (airportData.icao || airport).toUpperCase();
  const tz = airportData.timezone?.name || "UTC";
  const runwayLookup = runwayLookupFromStatic(airportData.runways);

  const rows = await fetchAirportRowsMerged(icao, direction, windowStart, now);

  const wantArrivals = direction === "arr" || direction === "both";
  const wantDepartures = direction === "dep" || direction === "both";

  const inbound = wantArrivals ? rows.filter((r) => (r.dest_icao || "").toUpperCase() === icao) : [];
  const outbound = wantDepartures ? rows.filter((r) => (r.orig_icao || "").toUpperCase() === icao) : [];

  const arrivals = inbound.filter((r) => {
    const d = parseFr24Utc(r.datetime_landed);
    return !!d && d >= windowStart && d <= now;
  });
  const departures = outbound.filter((r) => {
    const d = parseFr24Utc(r.datetime_takeoff);
    return !!d && d >= windowStart && d <= now;
  });

  const HISTORY_LIMIT = 40;

  const arrivalsSorted = wantArrivals
    ? [...arrivals]
        .sort((a, b) => {
          const ta = parseFr24Utc(a.datetime_landed)?.getTime() ?? 0;
          const tb = parseFr24Utc(b.datetime_landed)?.getTime() ?? 0;
          return tb - ta;
        })
        .slice(0, HISTORY_LIMIT)
    : [];

  const departuresSorted = wantDepartures
    ? [...departures]
        .sort((a, b) => {
          const ta = parseFr24Utc(a.datetime_takeoff)?.getTime() ?? 0;
          const tb = parseFr24Utc(b.datetime_takeoff)?.getTime() ?? 0;
          return tb - ta;
        })
        .slice(0, HISTORY_LIMIT)
    : [];

  const arrivalFr24Ids = arrivalsSorted.map((r) => r.fr24_id).filter((id): id is string => !!id);
  const departureFr24Ids = departuresSorted.map((r) => r.fr24_id).filter((id): id is string => !!id);

  const [gateArrivalsMap, gateDeparturesMap] = await Promise.all([
    wantArrivals ? fetchGateEvents(arrivalFr24Ids, "gate_arrival") : Promise.resolve(new Map<string, string>()),
    wantDepartures ? fetchGateEvents(departureFr24Ids, "gate_departure") : Promise.resolve(new Map<string, string>()),
  ]);

  const arrivalsWithGate = arrivalsSorted.map((r) => ({
    ...r,
    datetime_gate_arrival: r.fr24_id ? (gateArrivalsMap.get(r.fr24_id) ?? null) : null,
  }));

  const departuresWithGate = departuresSorted.map((r) => ({
    ...r,
    datetime_gate_departure: r.fr24_id ? (gateDeparturesMap.get(r.fr24_id) ?? null) : null,
  }));

  tagAirlineInfo(arrivalsWithGate);
  tagAirlineInfo(departuresWithGate);

  for (const r of departuresWithGate) {
    r.dest_label = formatAirportLine(r.dest_iata, r.dest_icao);
  }
  for (const r of arrivalsWithGate) {
    r.orig_label = formatAirportLine(r.orig_iata, r.orig_icao);
  }

  return {
    airport: {
      name: airportData.name || airport,
      iata: airportData.iata || null,
      icao,
      city: airportData.city || null,
      country: airportData.country?.name || null,
      timezone: tz,
    },
    direction,
    summary: {
      arrivals24h: arrivals.length,
      departures24h: departures.length,
    },
    arrivalsSeries: wantArrivals ? toHourSeries(arrivals, "datetime_landed", tz, windowStart, now) : EMPTY_SERIES,
    departuresSeries: wantDepartures ? toHourSeries(departures, "datetime_takeoff", tz, windowStart, now) : EMPTY_SERIES,
    departureRunways: wantDepartures ? aggregateRunwaySeries(departures, "runway_takeoff", runwayLookup) : EMPTY_RUNWAY_SERIES,
    arrivalRunways: wantArrivals ? aggregateRunwaySeries(arrivals, "runway_landed", runwayLookup) : EMPTY_RUNWAY_SERIES,
    arrivals: arrivalsWithGate,
    departures: departuresWithGate,
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

function parseDirection(raw: string | null): Direction {
  if (raw === "dep" || raw === "arr") return raw;
  return "both";
}

export async function GET(req: NextRequest) {
  try {
    const airport = (req.nextUrl.searchParams.get("airport") || process.env.DEMO_AIRPORT || "SEA")
      .trim()
      .toUpperCase();
    const direction = parseDirection(req.nextUrl.searchParams.get("direction"));
    const cacheKey = `${airport}:${direction}`;

    const cached = getCachedAirportPayload(cacheKey);
    if (cached) return NextResponse.json(cached);

    const inflight = airportInflight.get(cacheKey);
    if (inflight) return NextResponse.json(await inflight);

    const loadPromise = buildAirportPayload(airport, direction);
    airportInflight.set(cacheKey, loadPromise);

    try {
      const payload = await loadPromise;
      airportCache.set(cacheKey, { expiresAt: Date.now() + AIRPORT_CACHE_TTL_MS, payload });
      return NextResponse.json(payload);
    } finally {
      airportInflight.delete(cacheKey);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
