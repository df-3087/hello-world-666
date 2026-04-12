# FR24 API Reference — Essential Plan

A feature reference for the Flightradar24 API under the **Essential plan** ($90/month).
Source: [Subscriptions and credits](https://fr24api.flightradar24.com/subscriptions-and-credits) · [Credit overview](https://fr24api.flightradar24.com/docs/credit-overview)

---

## Plan Constraints

| Constraint | Essential |
|---|---|
| Monthly subscription credits | 333,000 (doubles to 666,000 during active promo through May 2026) |
| Response limit per request | 300 rows |
| Rate limit | 30 requests/minute |
| Historic data availability | 2 years rolling |
| Flight summary / flight events data starts | 2022-06-01 |
| Historic positions data starts | 2016-05-11 |

---

## Credit Costs by Endpoint

| Endpoint | Billing unit | Credits |
|---|---|---|
| Flight summary - light | Per live flight returned | 1 |
| Flight summary - light | Per historical flight (≤30 days old) | 2 |
| Flight summary - light | Per historical flight (>30 days old) | 3 |
| Flight summary - full | Per live flight returned | 2 |
| Flight summary - full | Per historical flight (≤30 days old) | 3 |
| Flight summary - full | Per historical flight (>30 days old) | 6 |
| Historic flight events - light | Per event returned (≤30 days old) | 2 |
| Historic flight events - light | Per event returned (>30 days old) | 3 |
| Historic flight events - full | Per event returned (≤30 days old) | 3 |
| Historic flight events - full | Per event returned (>30 days old) | 4 |
| Live flight positions - light | Per flight returned | 6 |
| Live flight positions - full | Per flight returned | 8 |
| Historic flight positions - light | Per position returned | 6 |
| Historic flight positions - full | Per position returned | 8 |
| Flight tracks | Per flight returned | 40 |
| Airports full | Per query | 50 |
| Airports light | Per query | 1 |
| Airlines light | Per query | 1 |
| `/count` endpoints | 15% of corresponding full endpoint (rounded up) | varies |
| Empty response (no results) | Flat fee per call | 1 |

---

## Endpoints

### Static Endpoints

#### `GET /api/static/airports/{code}/light`

Returns minimal airport identification data.

**Fields returned:**

| Field | Type | Description |
|---|---|---|
| `name` | string | Full airport name |
| `iata` | string | IATA code |
| `icao` | string | ICAO code |

**Credit cost:** 1 credit per query  
**Use cases:** Resolve an ICAO/IATA code to a human-readable name; autocomplete.

---

#### `GET /api/static/airports/{code}/full`

Returns comprehensive airport metadata including location, runways, and timezone.

**Fields returned:**

| Field | Type | Description |
|---|---|---|
| `name` | string | Full airport name |
| `iata` | string | IATA code |
| `icao` | string | ICAO code |
| `lat` | float | Latitude |
| `lon` | float | Longitude |
| `elevation` | integer | Elevation in feet |
| `country.code` | string | ISO country code |
| `country.name` | string | Country name |
| `city` | string | City name |
| `state` | string \| null | State/province |
| `timezone.name` | string | IANA timezone name (e.g. `America/Los_Angeles`) |
| `timezone.offset` | integer | UTC offset in seconds |
| `runways[].designator` | string | Runway designator (e.g. `01L`) |
| `runways[].heading` | integer | Magnetic heading |
| `runways[].length` | integer | Length in feet |
| `runways[].width` | integer | Width in feet |
| `runways[].elevation` | integer | Threshold elevation in feet |
| `runways[].thr_coordinates` | [lat, lon] | Threshold coordinates |
| `runways[].surface.type` | string | Surface type code |
| `runways[].surface.description` | string | Surface description (e.g. `Asphalt`) |

**Credit cost:** 50 credits per query  
**Use cases:** Timezone conversion for local time display; runway data; airport geo coordinates for mapping; elevation data.

> **Note:** This endpoint is used by the app on every airport page load. With a 30-minute cache, it costs 50 credits per cold cache hit.

---

#### `GET /api/static/airlines/{code}/light`

Returns airline identification data.

**Fields returned:**

| Field | Type | Description |
|---|---|---|
| `name` | string | Airline full name |
| `iata` | string | IATA code |
| `icao` | string | ICAO code |

**Credit cost:** 1 credit per query  
**Use cases:** Resolve an airline ICAO/IATA to a full name for display in tables.

---

### Live Endpoints

#### `GET /api/live/flight-positions/light`

Returns real-time aircraft positions (location and movement only).

**Fields returned:**

| Field | Type | Description |
|---|---|---|
| `fr24_id` | string | FR24 unique flight ID |
| `hex` | string | ICAO 24-bit transponder address |
| `callsign` | string | ATC callsign |
| `lat` | float | Current latitude |
| `lon` | float | Current longitude |
| `track` | integer | Track/heading in degrees |
| `alt` | integer | Altitude in feet |
| `gspeed` | integer | Ground speed in knots |
| `vspeed` | integer | Vertical speed in ft/min |
| `squawk` | string | Transponder squawk code |
| `timestamp` | string | UTC timestamp of position fix |
| `source` | string | Data source (e.g. `ADSB`, `MLAT`) |

**Credit cost:** 6 credits per returned flight  
**Use cases:** Live traffic map; aircraft count over a bounding box or airport; real-time alerts when a flight enters a zone.

---

#### `GET /api/live/flight-positions/full`

Same as light, with added flight and aircraft identity fields.

**Additional fields over light:**

| Field | Type | Description |
|---|---|---|
| `flight` | string | Commercial flight number (e.g. `AF1463`) |
| `type` | string | Aircraft ICAO type code (e.g. `A321`) |
| `reg` | string | Aircraft registration (e.g. `F-GTAZ`) |
| `painted_as` | string | Airline livery ICAO code |
| `operating_as` | string | Operating airline ICAO code |
| `orig_iata` | string | Origin IATA code |
| `orig_icao` | string | Origin ICAO code |
| `dest_iata` | string | Destination IATA code |
| `dest_icao` | string | Destination ICAO code |
| `eta` | string | Estimated arrival time (UTC) |

**Credit cost:** 8 credits per returned flight  
**Use cases:** Live flight board showing route, aircraft type, registration; inbound/outbound tracking for a specific airline.

---

#### `GET /api/live/flight-positions/count`

Returns total count of live aircraft matching filters without returning position data.

**Fields returned:** `record_count` (integer)

**Credit cost:** 15% of full endpoint cost (rounded up) = 2 credits per call  
**Use cases:** Dashboard summary statistics ("X aircraft airborne over the US right now"); throttle-safe pre-check before a full query.

---

### Historic Endpoints

#### `GET /api/historic/flight-positions/light`

Returns historical aircraft position snapshots (location and movement only). Availability starts 2016-05-11.

**Fields returned:** Same schema as Live flight positions light.

**Credit cost:** 6 credits per returned position  
**Use cases:** Replay a past flight's track on a map; analyse historic traffic density over an area at a specific time.

---

#### `GET /api/historic/flight-positions/full`

Returns historical aircraft positions with full flight and aircraft identity. Availability starts 2016-05-11.

**Fields returned:** Same schema as Live flight positions full.

**Credit cost:** 8 credits per returned position  
**Use cases:** Detailed flight replay with route and aircraft information; identifying which airline/aircraft was at a location at a given time.

---

#### `GET /api/historic/flight-positions/count`

Returns count of historic positions matching filters.

**Fields returned:** `record_count` (integer)

**Credit cost:** 2 credits per call  
**Use cases:** Pre-check query size before pulling full position history.

---

#### `GET /api/historic/flight-events/light`

Returns timestamped event milestones for a completed flight. Batch query up to 10 `fr24_id`s per call. Data available from 2022-06-01.

**Top-level fields:**

| Field | Type | Description |
|---|---|---|
| `fr24_id` | string | FR24 flight ID |
| `callsign` | string | ATC callsign |
| `hex` | string | ICAO transponder hex |
| `events` | array | List of flight events (see below) |

**Event types and their details:**

| `events[].type` | Key detail fields | Description |
|---|---|---|
| `gate_departure` | `gate_ident`, `gate_lat`, `gate_lon` | Aircraft pushes back from gate |
| `takeoff` | `takeoff_runway` | Wheels-off |
| `cruising` | `lat`, `lon`, `alt`, `gspeed` | Aircraft reaches cruise altitude |
| `descent` | `lat`, `lon`, `alt`, `gspeed` | Aircraft begins descent |
| `airspace_transition` | `exited_airspace`, `exited_airspace_id`, `entered_airspace`, `entered_airspace_id`, `lat`, `lon`, `alt`, `gspeed` | Aircraft crosses FIR/airspace boundary |
| `landed` | `landed_icao`, `landed_runway` | Wheels-on |
| `gate_arrival` | `gate_ident`, `gate_lat`, `gate_lon` | Aircraft arrives at gate |

**Credit cost:** 2 credits per event returned (≤30 days old); 3 credits (>30 days old)  
**Use cases (currently used by the app):** Taxi-in time (gate_arrival − landed); taxi-out time (takeoff − gate_departure); runway used on landing/takeoff; airspace crossing data.  
**Other use cases:** Gate identifier for display; precise pushback and block-on times for on-time performance analysis.

---

#### `GET /api/historic/flight-events/full`

Same as light, with added route and operator identity fields on the top-level object.

**Additional top-level fields over light:**

| Field | Type | Description |
|---|---|---|
| `operating_as` | string | Operating airline ICAO |
| `painted_as` | string | Livery airline ICAO |
| `orig_iata` | string | Origin IATA code |
| `orig_icao` | string | Origin ICAO code |
| `dest_iata` | string | Destination IATA code |
| `dest_icao` | string | Destination ICAO code |

**Credit cost:** 3 credits per event (≤30 days); 4 credits (>30 days)  
**Use cases:** Same as light, but without needing a separate lookup to resolve origin/destination.

---

### Summary Endpoints

#### `GET /api/flight-summary/light`

Returns one row per completed or in-progress flight leg with key timing and identity information. Supports querying by flight number, callsign, aircraft registration, airport pair, or bounding box. Data available from 2022-06-01.

**Fields returned:**

| Field | Type | Description |
|---|---|---|
| `fr24_id` | string | FR24 unique flight ID |
| `flight` | string | Commercial flight number |
| `callsign` | string | ATC callsign |
| `operating_as` | string | Operating airline ICAO |
| `painted_as` | string | Livery airline ICAO |
| `type` | string | Aircraft ICAO type code |
| `reg` | string | Aircraft registration |
| `orig_icao` | string | Origin ICAO |
| `dest_icao` | string | Filed destination ICAO |
| `dest_icao_actual` | string | Actual destination ICAO (if diverted) |
| `datetime_takeoff` | string \| null | Wheels-off UTC timestamp |
| `datetime_landed` | string \| null | Wheels-on UTC timestamp |
| `hex` | string | ICAO transponder hex |
| `first_seen` | string | First position fix UTC |
| `last_seen` | string | Last position fix UTC |
| `flight_ended` | boolean | Whether flight is complete |

**Credit cost:** 1 credit/live flight; 2 credits/historical flight (≤30 days); 3 credits (>30 days)  
**Currently used by the app** for airport arrival/departure history tables and bar charts.

---

#### `GET /api/flight-summary/full`

Same as light with additional runway, distance, and timing precision fields.

**Additional fields over light:**

| Field | Type | Description |
|---|---|---|
| `orig_iata` | string | Origin IATA code |
| `dest_iata` | string | Filed destination IATA code |
| `dest_iata_actual` | string | Actual destination IATA (if diverted) |
| `runway_takeoff` | string | Departure runway designator (e.g. `34C`) |
| `runway_landed` | string | Arrival runway designator |
| `flight_time` | integer | Actual flight time in seconds (wheels-off to wheels-on) |
| `actual_distance` | float | Great-circle distance actually flown (km) |
| `circle_distance` | float | Direct great-circle distance origin→destination (km) |
| `category` | string \| null | Flight category |

**Credit cost:** 2 credits/live; 3 credits/historical ≤30 days; 6 credits >30 days  
**Use cases over light:** Runway used on departure/arrival; actual flight duration in seconds; distance flown vs. direct distance (route efficiency); diversion detection (`dest_icao` ≠ `dest_icao_actual`).

---

#### `GET /api/flight-summary/count`

Returns total count of flights matching a flight summary query without returning row data.

**Fields returned:** `record_count` (integer)

**Credit cost:** 15% of full endpoint (rounded up)  
**Use cases:** Quickly check volume before a chunked fetch; dashboard totals without pulling all rows.

---

### Tracks Endpoint

#### `GET /api/flight-tracks/{fr24_id}`

Returns the full positional track for a single completed flight, including altitude, speed, and heading at each recorded position.

**Fields returned:**

| Field | Type | Description |
|---|---|---|
| `fr24_id` | string | FR24 flight ID |
| `tracks[].timestamp` | string | UTC timestamp |
| `tracks[].lat` | float | Latitude |
| `tracks[].lon` | float | Longitude |
| `tracks[].alt` | integer | Altitude in feet |
| `tracks[].gspeed` | integer | Ground speed in knots |
| `tracks[].vspeed` | integer | Vertical speed in ft/min |
| `tracks[].track` | integer | Heading in degrees |
| `tracks[].squawk` | string | Squawk code |
| `tracks[].callsign` | string | Callsign at this point |
| `tracks[].source` | string | Data source (`ADSB`, `MLAT`, etc.) |

**Credit cost:** 40 credits per flight  
**Use cases:** Draw a flight path on a map; altitude profile chart; speed profile over time; identify climb/cruise/descent phases visually.

> **Cost note:** At 40 credits per flight, track queries are the most expensive endpoint on a per-call basis. Use sparingly — cache aggressively.

---

### Reports

#### `GET /api/usage`

Returns a summary of how the API has been used over a given period.

**Fields returned:**

| Field | Type | Description |
|---|---|---|
| `data[].endpoint` | string | Endpoint path queried |
| `data[].request_count` | integer | Number of requests made |
| `data[].credits` | integer | Total credits consumed |

**Rate limit:** 1 call per minute  
**Use cases:** Monitor credit burn rate; identify which endpoints consume the most credits; audit unexpected usage spikes.

---

## Feature Ideas by Data Available

The following new features could be built using data accessible on the Essential plan:

### Airport-level features
- **Runway usage breakdown** — use `flight-summary/full`'s `runway_takeoff` / `runway_landed` fields to show which runways are most active at an airport over a time period
- **Diversion tracking** — detect flights where `dest_icao` ≠ `dest_icao_actual` using `flight-summary/full`
- **Flight distance distribution** — histogram of `circle_distance` values showing short-haul vs. long-haul traffic mix
- **Live inbound/outbound count** — use `live/flight-positions/count` filtered by bounding box around an airport
- **Live traffic map** — render all inbound/outbound aircraft as moving dots using `live/flight-positions/full`
- **Runway occupancy times** — combine `landed` and `gate_arrival` events from `historic/flight-events` to compute total runway-to-gate time
- **Gate pushback times** — use `gate_departure` event timestamps for on-time departure analysis
- **Airspace crossing log** — use `airspace_transition` events to see which FIRs a flight crossed

### Flight-level features
- **Interactive flight track map** — use `flight-tracks` to draw the route on a map with altitude color-coding
- **Altitude and speed profile chart** — plot `tracks[].alt` and `tracks[].gspeed` against time for a single flight
- **Flight efficiency score** — compare `actual_distance` vs. `circle_distance` from `flight-summary/full` to estimate route deviation
- **Actual block time** — use `gate_departure` to `gate_arrival` timestamps from `historic/flight-events` for true block-to-block timing
- **Takeoff/landing runway display** — show `runway_takeoff` and `runway_landed` from `flight-summary/full` on the featured flight history table

### Airline/fleet features
- **Airline lookup enrichment** — use `airlines/light` to display full airline names instead of ICAO codes in tables
- **Fleet activity tracker** — query `flight-summary/light` by aircraft registration to see all recent legs of a specific tail number

---

## What Is NOT Available on Essential

| Feature | Required plan |
|---|---|
| More than 300 rows per API response | Advanced (unlimited) |
| More than 30 requests/minute | Advanced (200/min) |
| Historic data older than 2 years | Advanced |
| Flight summary count endpoint | Essential+ (not on Explorer) |
| Live/historic positions count endpoint | Essential+ (not on Explorer) |

---

## This Project's FR24 Usage

### Endpoints currently in use

| Endpoint | Where used | Purpose |
|---|---|---|
| `GET /api/flight-summary/full` | `api/airport/route.ts` | Bulk fetch of all arrivals/departures for the 24h bar chart and history tables |
| `GET /api/flight-summary/full` | `api/flight/route.ts` | Recent leg history for the featured flight panel |
| `GET /api/historic/flight-events/light` | `api/airport/route.ts` | Gate arrival/departure timestamps for taxi-in and taxi-out calculations |
| `GET /api/static/airports/{code}/full` | `api/airport/route.ts` | Airport name, timezone, and metadata for local time conversion |

### Credit efficiency decisions

- **`flight-summary/full` instead of light** — the Full endpoint provides `orig_iata` and `dest_iata` in addition to ICAO codes, enabling user-friendly 3-letter airport codes in the UI. This costs ~50% more credits per historical row (3 vs 2) but eliminates the need for a static ICAO→IATA mapping.
- **Fetch window** — controlled by `DEV_WINDOW_HOURS` env var (default 24h). Set to 3 locally to reduce credits burned per page reload during development.
- **Cache TTL** — 30 minutes for both the airport route and the flight route. An in-memory `Map` with inflight deduplication prevents parallel requests from triggering double fetches.
- **Gate events scoped to displayed rows** — `historic/flight-events/light` is called only for the 40 most recent arrivals/departures (sorted and sliced before the gate events fetch), not for every flight in the 24h window. This keeps gate event batches at ≤4 per stream instead of potentially 30+.

### Known field name gotcha

`flight-summary/light` and `flight-summary/full` use the **same field names** in practice: `orig_icao` and `dest_icao`. The documentation schema table lists `origin_icao` / `destination_icao` for the Light variant, but actual API responses return the abbreviated names. Always verify field names against a real API response rather than the documentation table alone.

### Required API parameters

The `historic/flight-events/light` endpoint requires the `event_types` parameter (e.g. `event_types=gate_arrival`). Omitting it returns a `400 Validation failed: The event types field is required` error.
