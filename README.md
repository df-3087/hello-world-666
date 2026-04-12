# FlightSnooper

Snoop on your flight before you board. Enter a flight number to see historical performance, departure airport context, and arrival airport context — powered by Flightradar24.

Product specification: [docs/FR24_AIR_TRAFFIC_BRD.md](docs/FR24_AIR_TRAFFIC_BRD.md)

## Next.js website

The app lives in [`web/`](web/) and uses Next.js (App Router) with server API routes:

- `GET /api/flight` — last 10 legs for a flight number, with taxi-in/out enrichment, duration, route resolution, and summary stats
- `GET /api/airport` — airport arrivals/departures and 24h series; supports `direction` param (`dep`, `arr`, or `both`)

### How it works

1. User enters a flight number (e.g. `KE41`).
2. The app fetches the last 10 legs and resolves the route (origin + destination airports).
3. Two directional airport fetches run in parallel: departures from the origin, arrivals at the destination.
4. Three containers render: flight history, departure airport context, arrival airport context.

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
- `DEMO_FLIGHT` (optional; default flight number shown on load)
- `DEMO_LOOKBACK_DAYS` (optional; how many days of flight history)
- `DEMO_AIRPORT` (optional; default airport ICAO used by `/api/airport` when no `airport` param is supplied)

The web app reads these values from your local environment. Only commit [`.env.example`](.env.example), never your real token.

### Deploy to Vercel

1. Push this repository to GitHub.
2. In Vercel, import the repo and set the project root directory to `web`.
3. Add these environment variables in Vercel Project Settings:
   - `FR24_API_TOKEN` (required)
   - `SITE_PASSWORD` (optional)
   - `DEMO_FLIGHT` (optional)
   - `DEMO_LOOKBACK_DAYS` (optional)
   - `DEMO_AIRPORT` (optional)
4. Deploy and verify:
   - `/`
   - `/api/flight?flight=KE41`
   - `/api/airport?airport=RKSI&direction=dep` (uses FR24 `outbound:` filter)
   - `/api/airport?airport=KJFK&direction=arr` (uses FR24 `inbound:` filter)

Notes:
- The app is titled **"FlightSnooper"**.
- Page view analytics are collected via `@vercel/analytics` and visible in the Vercel dashboard — no additional configuration required after deploy.
- Both `/api/flight` and `/api/airport` enforce a **5 requests per minute per IP** rate limit. `/api/access` (the password gate) allows 5 login attempts per 15 minutes per IP.
- The API routes use the Node.js runtime on Vercel.
- `/api/airport` may take longer because it retries after FR24 rate limiting and keeps a 30-minute in-memory cache per server instance.
- `/api/flight` also enriches legs with gate event data for taxi-in/out, which adds latency.
- Environment variables must be enabled for all three Vercel environments (Production, Preview, Development) — Preview deployments from feature branches will fail silently if variables are only set for Production.
- **Vercel plan requirement:** Both API routes set `maxDuration = 120` seconds. Vercel Hobby plan caps function duration at **60 seconds**; you need the **Pro plan** (or higher) for 120s. If you are on Hobby, the airport route will time out on any request that hits a FR24 429 retry (which sleeps 62s). Verify your plan tier in the Vercel dashboard before going live.

## Infrastructure reference

See [`FR24_API_REFERENCE.md`](FR24_API_REFERENCE.md) for the full FR24 API endpoint menu, credit costs, and project-specific decisions.

See [`VERCEL_REFERENCE.md`](VERCEL_REFERENCE.md) for Vercel plan constraints and deployment notes.
