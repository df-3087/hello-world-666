import places from "@/data/airport-places.json";

type Place = { city: string; country: string };

const PLACES = places as Record<string, Place>;

function sanitizeCity(city: string): string {
  return city.replace(/,/g, " ").replace(/\s+/g, " ").trim() || "?";
}

/**
 * Human-readable airport: `CAN - Guangzhou (Huadu), CN` using OurAirports-derived lookup.
 * Falls back to IATA or ICAO alone when unknown.
 */
export function formatAirportLine(iata?: string | null, icao?: string | null): string {
  const i = (iata ?? "").trim().toUpperCase();
  const ic = (icao ?? "").trim().toUpperCase();
  const displayCode = i.length === 3 ? i : ic || i || "--";
  const place = (i.length === 3 ? PLACES[i] : undefined) ?? (ic ? PLACES[ic] : undefined);
  if (!place) return displayCode;
  const city = sanitizeCity(place.city);
  const country = (place.country || "?").toUpperCase();
  return `${displayCode} - ${city}, ${country}`;
}
