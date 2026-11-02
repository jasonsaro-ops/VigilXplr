# VigilXplr

**National Transportation Safety Intelligence Dashboard**

Ultra high-end interactive explorer for NTSB, FAA, and FRA accident, incident, and investigation data across all transportation modes (Aviation, Railroad, Highway, Marine, Pipeline, Hazmat).

Built for GitHub Pages. Designed for operational monitoring, research, and situational awareness — dark mission-critical aesthetic, map + table + detail drill-down, alert tones, hourly data refresh via GitHub Actions.

---

## Features

- **Multi-mode coverage**: Aviation, Railroad, Highway, Marine, Pipeline, Hazmat
- **Interactive map** (Leaflet + CARTO dark basemap) with color-coded markers
- **Filterable table**: mode, severity, investigation status, date range, free-text search
- **Detail panel**: summary, injuries, probable cause, docket / report links, aircraft/vehicle
- **Alert tones** (Web Audio): distinct fatal / serious / update tones
- **CSV export** of filtered results
- **Hourly automated updates** via GitHub Actions using the official NTSB Public API
- **Official API integration**: `GetCasesByDateRangeV2` + single-case endpoints from [developer.ntsb.gov](https://developer.ntsb.gov/)

## Quick Start (GitHub Pages)

1. Create a new public repository named **`VigilXplr`**
2. Upload / push the contents of this folder to the repo root
3. Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/ (root)`
4. **Add your NTSB API key** (required for live data):
   - Settings → Secrets and variables → Actions → New repository secret
   - Name: `NTSB_SUBSCRIPTION_KEY`
   - Value: the Primary key from your NTSB Developer Portal subscription
5. Actions tab → enable workflows → run **Update VigilXplr Data** once
6. Open `https://<your-user>.github.io/VigilXplr/`

### How to get the NTSB subscription key

1. Sign in at https://developer.ntsb.gov/ with login.gov
2. Subscribe to the **Public** product (if not already)
3. Go to Profile / Subscriptions / Keys
4. Copy the **Primary key**
5. Paste it into the GitHub secret above

You already successfully called the data dictionary, so the key exists — you just need to copy it into the secret.

## Data Pipeline

| Component | Role |
|-----------|------|
| `data/events.json` | Canonical JSON consumed by the static site |
| `scripts/update_data.py` | Calls NTSB Public API V2, normalizes, merges |
| `.github/workflows/update-data.yml` | Hourly + manual trigger; commits refreshed JSON |

The updater:

1. Reads `NTSB_SUBSCRIPTION_KEY` from the environment (GitHub secret)
2. Calls `GET /api/Common/v2/GetCasesByDateRange/` for each mode (aviation, railroad, highway, marine, pipeline, hazmat) over the last ~120 days
3. Handles marker-based pagination
4. Normalizes fields using the official data dictionary shape
5. Merges with the previous `events.json` so historical data is retained
6. Never leaves the dashboard empty (falls back to seed if no key)

## Local Development

```bash
# Serve the static site
python -m http.server 8080
# open http://localhost:8080

# Optional: put your key in secrets/ntsb_key.txt for local runs
mkdir -p secrets
echo "YOUR_PRIMARY_KEY_HERE" > secrets/ntsb_key.txt

# Manually refresh data
pip install requests
python scripts/update_data.py
```

## Project Layout

```
VigilXplr/
├── index.html
├── css/styles.css
├── js/
│   ├── app.js          # UI, map, filters, selection
│   ├── alerts.js       # Web Audio alert tones
│   └── data.js         # Seed fallback
├── data/events.json    # Live snapshot (Action-updated)
├── scripts/update_data.py
├── .github/workflows/update-data.yml
├── assets/
└── README.md
```

## License

MIT for the dashboard code. Underlying investigation data remains U.S. government public domain material; attribute NTSB / FAA / FRA when republishing analyses.

---

**VigilXplr** — Keep watch.
