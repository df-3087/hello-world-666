# hello-world-666

Next.js website for Flightradar24-powered air traffic analytics.

Product and technical specification: [docs/FR24_AIR_TRAFFIC_BRD.md](docs/FR24_AIR_TRAFFIC_BRD.md) (historical planning doc; parts still describe the retired MVP).

## Next.js website

The app lives in [`web/`](web/) and uses Next.js (App Router) with server API routes:

- `GET /api/airport` — airport arrivals/departures and 24h series
- `GET /api/flight` — recent leg history for one flight number

### Prerequisite

Install Node.js 20+ (includes `npm` and `npx`).

### Run locally

```bash
cd web
npm install
npm run dev
```

Copy [`.env.example`](.env.example) to `.env` in the project root and set:

- `FR24_API_TOKEN` (required)
- `SITE_PASSWORD` (optional; if set, visitors must enter this shared password first)
- `DEMO_AIRPORT` (optional)
- `DEMO_FLIGHT` (optional)
- `DEMO_LOOKBACK_DAYS` (optional)

The web app reads these values from your local environment. Only commit [`.env.example`](.env.example), never your real token.

### Deploy to Vercel

1. Push this repository to GitHub.
2. In Vercel, import the repo and set the project root directory to `web`.
3. Add these environment variables in Vercel Project Settings:
   - `FR24_API_TOKEN` (required)
   - `SITE_PASSWORD` (optional)
   - `DEMO_AIRPORT` (optional)
   - `DEMO_FLIGHT` (optional)
   - `DEMO_LOOKBACK_DAYS` (optional)
4. Deploy and verify:
   - `/`
   - `/api/airport?airport=SEA`
   - `/api/flight?flight=KE41`

Notes:
- The API routes use the Node.js runtime on Vercel.
- `/api/airport` may take longer because it retries after FR24 rate limiting and keeps a 30-minute in-memory cache per server instance.
- Environment variables must be enabled for all three Vercel environments (Production, Preview, Development) — Preview deployments from feature branches will fail silently if variables are only set for Production.

## Infrastructure context

### Flightradar24 API — Essential plan
- **Monthly credits:** 333,000 (666,000 with current double-credits promo through May 2026)
- **Response limit per request:** 300 rows
- **Rate limit:** 30 requests/minute
- **Historic data availability:** 2 years
- **Endpoints in use:** `flight-summary/light`, `historic/flight-events/light`, `static/airports/{code}/full`
- **Credit costs:** flight-summary/light = 2 credits/row (recent historic); flight-events/light = 2 credits/row; airports/full = 50 credits/call
- **Key constraint:** `flight-summary/light` and `flight-summary/full` use the same field names in practice (`orig_icao`, `dest_icao`) despite the docs showing `origin_icao`/`destination_icao` for Light — always verify against actual API responses, not just the schema table

### Vercel — Pro plan
- **Serverless function timeout:** 60 seconds max (respects `maxDuration` up to 60s)
- **`maxDuration = 120`** in the airport route targets this ceiling; cold loads at busy airports can approach it
- **In-memory cache** does not persist across function instances or deployments — every cold start triggers a full FR24 fetch

### Credit efficiency decisions
- Airport route uses `flight-summary/light` (not full) — all displayed fields are available on Light
- Fetch window is controlled by `DEV_WINDOW_HOURS` env var (default 24h; set to 3 for local dev to save credits)
- Cache TTL is 30 minutes for both airport and flight routes
- Gate events (`gate_arrival`, `gate_departure`) are fetched via `historic/flight-events/light` with `event_types` parameter — this parameter is required by the API or it returns a 400 validation error
