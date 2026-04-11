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

export async function GET(req: NextRequest) {
  try {
    const flight = (req.nextUrl.searchParams.get("flight") || process.env.DEMO_FLIGHT || "KE41")
      .trim()
      .toUpperCase();
    const lookbackDays = Number(process.env.DEMO_LOOKBACK_DAYS || "7");
    const now = new Date();
    const from = new Date(now.getTime() - lookbackDays * 24 * 3600 * 1000);

    const payload = await fr24Get<{ data?: FlightRow[] }>(`/api/flight-summary/full`, {
      flight_datetime_from: apiDt(from),
      flight_datetime_to: apiDt(now),
      flights: flight,
      limit: "100",
      sort: "desc",
    });

    return NextResponse.json({
      flight,
      lookbackDays,
      legs: payload.data || [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
