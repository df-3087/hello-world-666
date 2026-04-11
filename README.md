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
- `DEMO_AIRPORT` (optional)
- `DEMO_FLIGHT` (optional)
- `DEMO_LOOKBACK_DAYS` (optional)

The web app reads these values from your local environment. Only commit [`.env.example`](.env.example), never your real token.

### Deploy to Vercel

1. Push this repository to GitHub.
2. In Vercel, import the repo and set the project root directory to `web`.
3. Add these environment variables in Vercel Project Settings:
   - `FR24_API_TOKEN` (required)
   - `DEMO_AIRPORT` (optional)
   - `DEMO_FLIGHT` (optional)
   - `DEMO_LOOKBACK_DAYS` (optional)
4. Deploy and verify:
   - `/`
   - `/api/airport?airport=SEA`
   - `/api/flight?flight=KE41`

Notes:
- The API routes use the Node.js runtime on Vercel.
- `/api/airport` may take longer because it retries after FR24 rate limiting and keeps a short in-memory cache per server instance.
