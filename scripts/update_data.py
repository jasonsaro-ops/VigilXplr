#!/usr/bin/env python3
"""
VigilXplr data updater — resilient
Pulls NTSB Public API GetCasesByDateRangeV2 from 1978 → present incrementally.
Never hard-fails the GitHub Action on API/network issues.
"""
from __future__ import annotations
import json, os, sys, time, traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError:
    print("[vigil] requests not installed", file=sys.stderr)
    raise SystemExit(0)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "events.json"
PROGRESS = ROOT / "data" / "pull_progress.json"
KEY_FILE = ROOT / "secrets" / "ntsb_key.txt"
V2_URL = "https://api.ntsb.gov/public/api/Common/v2/GetCasesByDateRange/"
HEADERS_BASE = {
    "User-Agent": "VigilXplr/1.4 (NTSB historical archive builder)",
    "Accept": "application/json",
}
MAX_EVENTS = 8000
START_YEAR = 1978
SURFACE_MODES = ["railroad", "highway", "marine", "pipeline", "hazmat"]
YEARS_PER_RUN = 3

def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def load_key() -> str | None:
    key = os.environ.get("NTSB_SUBSCRIPTION_KEY", "").strip()
    if key:
        print(f"[vigil] key loaded from env (len={len(key)})")
        return key
    if KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding="utf-8").strip()
        if key:
            print(f"[vigil] key loaded from file (len={len(key)})")
            return key
    print("[vigil] WARNING: no NTSB_SUBSCRIPTION_KEY found", file=sys.stderr)
    return None

def load_existing() -> list[dict[str, Any]]:
    if OUT.exists():
        try:
            data = json.loads(OUT.read_text(encoding="utf-8"))
            return list(data.get("events") or [])
        except Exception as e:
            print(f"[vigil] could not read existing events: {e}", file=sys.stderr)
    return []

def load_progress() -> dict:
    if PROGRESS.exists():
        try:
            return json.loads(PROGRESS.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"completed_years": [], "completed_surface": False}

def save_progress(p: dict):
    PROGRESS.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS.write_text(json.dumps(p, indent=2) + "\n")

def write_events(events: list[dict], meta_extra: dict | None = None):
    meta = {
        "generated": utc_now(),
        "source": "NTSB Public API GetCasesByDateRangeV2",
        "count": len(events),
    }
    if meta_extra:
        meta.update(meta_extra)
    payload = {"meta": meta, "events": events}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[vigil] wrote {len(events)} events → {OUT}")

def _first(d: dict, *keys, default=None):
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return default

def normalize_case(raw: dict, mode_hint: str | None = None) -> dict[str, Any]:
    ntsb = _first(raw, "ntsbNumber", "cm_ntsbNum", "NtsbNo", default="")
    mkey = _first(raw, "mKey", "mkey", "MKey")
    date = _first(raw, "eventDate", "cm_eventDate", default="")
    if isinstance(date, str) and "T" in date:
        date = date[:10]
    city = _first(raw, "eventCity", "cm_city", default="")
    state = _first(raw, "eventStateOrRegion", "eventState", "cm_state", default="")
    country = _first(raw, "eventCountry", "cm_country", default="USA")
    lat = _first(raw, "eventLatitude", "latitude", "lat")
    lon = _first(raw, "eventLongitude", "longitude", "lon")
    try:
        lat = float(lat) if lat not in (None, "") else None
        lon = float(lon) if lon not in (None, "") else None
    except (TypeError, ValueError):
        lat = lon = None
    injury = _first(raw, "highestInjuryLevel", "cm_highestInjury", default="Unknown")
    fatal = int(_first(raw, "totalFatal", "fatal", default=0) or 0)
    serious = int(_first(raw, "totalSerious", "serious", default=0) or 0)
    minor = int(_first(raw, "totalMinor", "minor", default=0) or 0)
    uninjured = int(_first(raw, "totalNone", "totalUninjured", default=0) or 0)
    status_raw = _first(raw, "completionStatus", "reportStatus", "caseClosed", default="Open")
    if status_raw is True:
        status = "Final"
    elif status_raw is False:
        status = "Open"
    else:
        status = str(status_raw)
    mode = mode_hint or _first(raw, "mode", default="Aviation")
    if isinstance(mode, str):
        ml = mode.lower()
        mode = {
            "aviation": "Aviation", "railroad": "Railroad", "rail": "Railroad",
            "highway": "Highway", "marine": "Marine", "pipeline": "Pipeline",
            "hazmat": "Hazmat",
        }.get(ml, mode.capitalize())
    summary = _first(raw, "prelimNarrative", "concatenatedFactualNarrative",
                     "analysisNarrative", "narrative", "summary", default="")
    if not summary:
        et = _first(raw, "eventType", default="")
        summary = f"{mode} {et} — {city}, {state}".strip(" —")
    if isinstance(summary, str) and len(summary) > 400:
        summary = summary[:397] + "…"
    cause = _first(raw, "probableCause", "findings", default="Under investigation.")
    if isinstance(cause, list):
        cause = "; ".join(str(c) for c in cause[:2])
    if isinstance(cause, str) and len(cause) > 300:
        cause = cause[:297] + "…"
    docket = _first(raw, "docketPage", "DocketPage", "docketUrl")
    if not docket and ntsb:
        docket = f"https://data.ntsb.gov/Docket/?ProjectID={ntsb}"
    report = _first(raw, "reportPage", "ReportPage", "investigationPage")
    return {
        "id": ntsb or (f"MKEY-{mkey}" if mkey else f"{mode}-{date}-{city}"),
        "ntsbNum": ntsb or "",
        "mkey": mkey,
        "mode": mode,
        "eventDate": date,
        "eventTime": _first(raw, "eventTimeUtc", "eventTime"),
        "city": city, "state": state, "country": country,
        "lat": lat, "lon": lon,
        "highestInjury": injury,
        "fatal": fatal, "serious": serious, "minor": minor, "uninjured": uninjured,
        "aircraftDamage": _first(raw, "damageLevel", "aircraftDamage", "eventPropertyDamage"),
        "make": _first(raw, "aircraftMake", "make"),
        "model": _first(raw, "aircraftModel", "model"),
        "reg": _first(raw, "aircraftRegistrationNumber", "n_number", "registration"),
        "operator": _first(raw, "operatorName", "operator"),
        "status": status, "reportStatus": status,
        "summary": summary,
        "probableCause": cause or "Under investigation.",
        "docketUrl": docket, "reportUrl": report,
        "phase": _first(raw, "broadPhaseOfFlight", "phaseOfFlight", "phase"),
        "weather": _first(raw, "accidentSiteCondition", "weatherCondition"),
        "eventType": _first(raw, "eventType"),
        "region": _first(raw, "region"),
    }

def fetch_v2(key: str, start: str, end: str, mode: str | None, marker: str | None):
    params = {"startDate": start, "endDate": end}
    if mode:
        params["mode"] = mode
    if marker:
        params["marker"] = marker
    headers = {**HEADERS_BASE, "Ocp-Apim-Subscription-Key": key}
    try:
        r = requests.get(V2_URL, headers=headers, params=params, timeout=90)
    except requests.RequestException as e:
        print(f"[api] network error: {e}", file=sys.stderr)
        return [], False, None
    if r.status_code == 204:
        return [], False, None
    if r.status_code == 401:
        print("[api] 401 Unauthorized — check NTSB_SUBSCRIPTION_KEY secret value", file=sys.stderr)
        return [], False, None
    if r.status_code == 403:
        print(f"[api] 403 forbidden/rate-limit for {mode} {start}-{end}", file=sys.stderr)
        time.sleep(3)
        return [], False, None
    if r.status_code != 200:
        print(f"[api] HTTP {r.status_code} {mode} {start}: {r.text[:150]}", file=sys.stderr)
        return [], False, None
    try:
        d = r.json()
    except Exception:
        print("[api] invalid JSON response", file=sys.stderr)
        return [], False, None
    items = d.get("data") or d.get("value") or []
    return items, bool(d.get("hasMore")), d.get("nextMarker") or d.get("marker")

def fetch_year(key: str, year: int, mode: str = "aviation") -> list[dict]:
    start = f"{year}-01-01"
    end = f"{year}-12-31"
    today = datetime.now(timezone.utc).date()
    if year == today.year:
        end = today.isoformat()
    out = []
    marker = None
    for page in range(30):
        items, has_more, marker = fetch_v2(key, start, end, mode, marker)
        out.extend(items)
        print(f"  {mode} {year} p{page+1}: +{len(items)} year_total={len(out)} more={has_more}")
        if not has_more or not items:
            break
        time.sleep(0.35)
    return out

def merge_events(existing: list[dict], new: list[dict]) -> list[dict]:
    by_id = {}
    for e in existing + new:
        key = e.get("id") or e.get("ntsbNum")
        if not key:
            continue
        if key in by_id:
            merged = {**by_id[key]}
            for k, v in e.items():
                if v not in (None, "", []):
                    merged[k] = v
            by_id[key] = merged
        else:
            by_id[key] = e
    out = list(by_id.values())
    def rank(e):
        sev = (e.get("highestInjury") or "").lower()
        score = 2
        if "fatal" in sev: score = 100
        elif "serious" in sev: score = 50
        elif "minor" in sev: score = 10
        return (score, e.get("eventDate") or "")
    out.sort(key=rank, reverse=True)
    if len(out) > MAX_EVENTS:
        keep = [e for e in out if rank(e)[0] >= 50]
        rest = [e for e in out if rank(e)[0] < 50]
        rest.sort(key=lambda e: e.get("eventDate") or "", reverse=True)
        out = keep + rest[: max(0, MAX_EVENTS - len(keep))]
    out.sort(key=lambda e: e.get("eventDate") or "", reverse=True)
    return out

def main() -> int:
    print(f"[vigil] start {utc_now()}")
    print(f"[vigil] cwd={Path.cwd()} root={ROOT}")
    existing = load_existing()
    progress = load_progress()
    print(f"[vigil] existing events={len(existing)} completed_years={progress.get('completed_years', [])}")

    key = load_key()
    if not key:
        # Don't fail the Action — just keep existing data
        write_events(existing, {"note": "no API key; retained existing data"})
        return 0

    current_year = datetime.now(timezone.utc).year
    all_years = list(range(current_year, START_YEAR - 1, -1))
    done = set(progress.get("completed_years") or [])
    pending = [y for y in all_years if y not in done]
    batch = pending[:YEARS_PER_RUN]

    try:
        if batch:
            print(f"[vigil] aviation years this run: {batch}")
            for year in batch:
                items = fetch_year(key, year, "aviation")
                normalized = []
                for it in items:
                    if isinstance(it, dict):
                        normalized.append(normalize_case(it, mode_hint="Aviation"))
                existing = merge_events(existing, normalized)
                progress.setdefault("completed_years", []).append(year)
                # de-dupe completed years
                progress["completed_years"] = sorted(set(progress["completed_years"]), reverse=True)
                save_progress(progress)
                write_events(existing, {
                    "progress_years": progress["completed_years"],
                    "last_year_pulled": year,
                    "note": "incremental historical backfill",
                })
                print(f"[vigil] checkpoint year {year}: {len(existing)} events")
                time.sleep(0.5)
        else:
            print("[vigil] all aviation years already completed")

        if not progress.get("completed_surface"):
            print("[vigil] pulling surface modes 2010–present")
            end = datetime.now(timezone.utc).date().isoformat()
            surface_new = []
            for mode in SURFACE_MODES:
                label = mode.capitalize() if mode != "hazmat" else "Hazmat"
                marker = None
                for page in range(15):
                    items, has_more, marker = fetch_v2(key, "2010-01-01", end, mode, marker)
                    for it in items:
                        if isinstance(it, dict):
                            surface_new.append(normalize_case(it, mode_hint=label))
                    print(f"  {mode} p{page+1}: +{len(items)} more={has_more}")
                    if not has_more or not items:
                        break
                    time.sleep(0.35)
            existing = merge_events(existing, surface_new)
            progress["completed_surface"] = True
            save_progress(progress)
            write_events(existing, {
                "progress_years": progress.get("completed_years", []),
                "surface_done": True,
            })

        remaining = [y for y in all_years if y not in set(progress.get("completed_years") or [])]
        print(f"[vigil] done. events={len(existing)} years remaining={len(remaining)}")
    except Exception as e:
        print(f"[vigil] unexpected error (non-fatal): {e}", file=sys.stderr)
        traceback.print_exc()
        # still write whatever we have
        try:
            write_events(existing, {"note": f"partial run after error: {e}"})
        except Exception:
            pass
        return 0  # do not fail the Action

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
