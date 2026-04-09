import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const BASE_URL = "https://fr24api.flightradar24.com";

let dotenvLoaded = false;

function ensureDotenvLoaded() {
  if (dotenvLoaded) return;
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../.env"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      loadDotenv({ path: file, override: false });
    }
  }
  dotenvLoaded = true;
}

function tokenOrThrow() {
  ensureDotenvLoaded();
  const token = process.env.FR24_API_TOKEN;
  if (!token) {
    throw new Error("Missing FR24_API_TOKEN in environment");
  }
  return token;
}

export async function fr24Get<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params);
  const url = qs.toString() ? `${BASE_URL}${path}?${qs.toString()}` : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokenOrThrow()}`,
      Accept: "application/json",
      "Accept-Version": "v1",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FR24 ${res.status}: ${body}`);
  }

  return (await res.json()) as T;
}

export function apiDt(date: Date): string {
  return date.toISOString().slice(0, 19);
}
