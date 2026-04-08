# hello-world-666

Product and technical specification: [docs/FR24_AIR_TRAFFIC_BRD.md](docs/FR24_AIR_TRAFFIC_BRD.md) (Flightradar24 air traffic analytics — BRD and design, v1.3).

## Streamlit dashboard (demo)

Scope is intentionally narrow: **one airport** and **one flight number**, configured in a local `.env` file (not committed to Git).

1. Create a virtual environment and install dependencies:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate   # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. Copy [`.env.example`](.env.example) to **`.env`** in the project root and set:

   - **`FR24_API_TOKEN`** — your Flightradar24 API token (required).
   - **`DEMO_AIRPORT`** — IATA (3 letters) or ICAO (4 letters), e.g. `ARN` or `ESSA`.
   - **`DEMO_FLIGHT`** — flight number as used by the API, e.g. `SK1415`.
   - **`DEMO_LOOKBACK_DAYS`** — optional, 1–14 (default `7`).

3. Run the app:

   ```bash
   streamlit run streamlit_app.py
   ```

**Security:** `.env` and [`.streamlit/secrets.toml`](https://docs.streamlit.io/develop/concepts/connections/secrets-management) are listed in [`.gitignore`](.gitignore). Only commit [`.env.example`](.env.example), never your real token.
