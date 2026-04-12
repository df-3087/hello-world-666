# Vercel Reference — Pro Plan

Deployment and runtime context for this project on Vercel.

---

## Plan Constraints

| Constraint | Pro plan |
|---|---|
| Serverless function max duration | Up to 300 seconds (configured per-function via `maxDuration`) |
| `maxDuration` ceiling | 300 seconds (Hobby plan caps at 60 seconds) |
| Bandwidth | 1 TB/month |
| Serverless function invocations | 1,000,000/month |
| Edge network | Global CDN |
| Preview deployments | Unlimited |

---

## Serverless Function Runtime

All API routes (`/api/airport`, `/api/flight`) use the **Node.js runtime** (`export const runtime = "nodejs"`), not the Edge runtime. This is required because:
- The FR24 fetch logic uses in-memory `Map` caching (not available on Edge)
- The retry/sleep pattern uses `setTimeout` via `async/await`, which works reliably on Node.js

### `maxDuration` setting

`maxDuration = 120` is set on both the airport route (`web/src/app/api/airport/route.ts`) and the flight route (`web/src/app/api/flight/route.ts`). This declares the function's maximum allowed execution time to Vercel. The Pro plan ceiling is 300 seconds; the Hobby plan caps at 60 seconds. **This project requires Pro or higher** — on Hobby, any request that triggers a FR24 429 retry (which sleeps 62s) will exceed the 60s cap and return a timeout error.

The airport route can approach its 120s budget on cold starts at busy airports because it chains multiple FR24 API calls with 400ms rate-limit gaps between them. The gate events fetch is the main variable cost — see `FR24_API_REFERENCE.md` for details on how this is controlled.

---

## In-Memory Cache Behaviour

The airport and flight routes use an in-memory `Map` with a 30-minute TTL to avoid redundant FR24 API calls. **Important limitations:**

- The cache is **per function instance** — Vercel may spin up multiple instances under load, and each starts with an empty cache.
- The cache does **not persist across deployments** — every new deployment starts cold.
- The cache **resets on every cold start** — a function instance that has been idle and is recycled by Vercel will trigger a full FR24 fetch on the next request.

This means the first request after a deployment or a period of inactivity will always make live FR24 API calls and may take longer than subsequent requests.

---

## Environment Variables

All variables must be enabled for all three environments (**Production**, **Preview**, **Development**) in Vercel Project Settings → Environment Variables. Feature branch deployments (Preview) will fail silently if variables are only set for Production.

| Variable | Required | Description |
|---|---|---|
| `FR24_API_TOKEN` | Yes | FR24 API bearer token |
| `SITE_PASSWORD` | No | If set, visitors must enter this shared password before accessing the site |
| `DEMO_AIRPORT` | No | Default airport ICAO code pre-filled in the airport input |
| `DEMO_FLIGHT` | No | Default flight number pre-filled in the flight input |
| `DEMO_LOOKBACK_DAYS` | No | Lookback window override for demo mode |
| `VERCEL_WINDOW_HOURS` | No | Overrides the airport data fetch window (hours) on Vercel deployments. Use to reduce FR24 credit consumption on Preview branches. Set to `6` to limit the airport fetch to 6 hours and stay comfortably within the 60s function timeout on cold starts at busy airports. |
| `DEV_WINDOW_HOURS` | No | Overrides the fetch window for local development. Set to `3` to save credits during testing. Takes effect only if `VERCEL_WINDOW_HOURS` is not set. |

### Window hours precedence

```
VERCEL_WINDOW_HOURS → DEV_WINDOW_HOURS → default (24h)
```

Value is clamped to the range [1, 24].

---

## User-Facing Rate Limiting

Both `/api/flight` and `/api/airport` enforce a **5 requests per minute per IP** limit (implemented in `web/src/lib/rate-limit.ts` using an in-memory `Map`). Requests over the limit receive a `429` response with a `Retry-After` header. The `/api/access` (password gate) endpoint enforces a separate **5 attempts per 15 minutes per IP** limit.

Like the cache, the rate-limit counters are **per function instance** — they reset on cold start and are not shared across Vercel instances. For a small audience this is acceptable; at higher scale, replace the in-memory map with Vercel KV or Upstash Redis.

---

## Deployment Checklist

1. Push the branch to GitHub.
2. Vercel automatically creates a Preview deployment for every pushed branch.
3. Confirm environment variables are set for **all three environments** (Production, Preview, Development) in Project Settings.
4. After adding or changing environment variables, **manually trigger a redeploy** — Vercel does not auto-redeploy on env var changes alone.
5. Verify the deployment by hitting:
   - `/`
   - `/api/airport?airport=KSEA`
   - `/api/flight?flight=AS3`

---

## Diagnosing Timeout Errors

A `504 FUNCTION_INVOCATION_TIMEOUT` error means the serverless function exceeded its `maxDuration` before returning a response. Common causes for this project:

| Cause | Fix |
|---|---|
| Large airport with many flights in the 24h window causing too many FR24 API calls | Set `VERCEL_WINDOW_HOURS=6` in Vercel env vars to reduce the fetch window |
| FR24 returning a `429 Too Many Requests` which triggers a 62-second retry sleep | Reduce concurrent page loads; increase cache TTL |
| Cold start at a busy airport exceeding 60s due to gate events batching | Already addressed — gate events are fetched for top 40 rows only |

Error responses from the airport API surface in the browser as:
```
Airport API returned non-JSON (HTTP 504): An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT ...
```

The `safeJson` helper in `page.tsx` captures and formats this error for display rather than crashing with an unhandled JSON parse error.
