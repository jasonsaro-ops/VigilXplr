#!/usr/bin/env python3
"""
VigilXplr data updater — production version
-------------------------------------------
Pulls live investigation data from the official NTSB Public API:

  https://api.ntsb.gov/public/api/Common/v2/GetCasesByDateRange/

Uses the subscription key from:
  1. Environment variable NTSB_SUBSCRIPTION_KEY  (GitHub Actions secret)
  2. Local file secrets/ntsb_key.txt              (for local runs)

Falls back gracefully to the existing seed/events.json so the dashboard
never goes empty.

Schema informed by the official OpenAPI + Aviation Data Dictionary.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "events.json"
KEY_FILE = ROOT / "secrets" / "ntsb_key.txt"

BASE = "https://api.ntsb.gov/public"
V2_URL = f"{BASE}/api/Common/v2/GetCasesByDateRange/"

HEADERS_BASE = {
    "User-Agent": "VigilXplr/1.1 (transportation safety dashboard; GitHub Actions)",
    "Accept": "application/json",
}

# Modes supported by the V2 endpoint
MODES = ["aviation", "railroad", "highway", "marine", "pipeline", "hazmat"]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_key() -> str | None:
    key = os.environ.get("NTSB_SUBSCRIPTION_KEY", "").strip()
    if key:
        return key
    if KEY_FILE.exists():
        return KEY_FILE.read_text(encoding="utf-8").strip()
    return None


def load_existing() -> list[dict[str, Any]]:
    if OUT.exists():
        try:
            data = json.loads(OUT.read_text(encoding="utf-8"))
            return list(data.get("events") or [])
        except Exception:
            pass
    return []


def _first(d: dict, *keys, default=None):
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return default


def normalize_case(raw: dict, mode_hint: str | None = None) -> dict[str, Any]:
    """Map heterogeneous NTSB JSON shapes → VigilXplr event schema."""
    ntsb = _first(
        raw,
        "ntsbNumber", "cm_ntsbNum", "NtsbNo", "accidentNumber",
        "ntsb_number", "caseNumber", default=""
    )
    mkey = _first(raw, "mkey", "MKey", "mKey", "caseKey")

    date = _first(raw, "eventDate", "cm_eventDate", "EventDate", "date", default="")
    if isinstance(date, str) and "T" in date:
        date = date[:10]

    city = _first(raw, "eventCity", "cm_city", "city", "City", default="")
    state = _first(raw, "eventState", "eventStateOrRegion", "cm_state", "state", "State", default="")
    country = _first(raw, "eventCountry", "cm_country", "country", "Country", default="USA")
    lat = _first(raw, "latitude", "lat", "cm_lat", "eventLatitude")
    lon = _first(raw, "longitude", "lon", "cm_lon", "eventLongitude")
    try:
        lat = float(lat) if lat not in (None, "") else None
        lon = float(lon) if lon not in (None, "") else None
    except (TypeError, ValueError):
        lat = lon = None

    injury = _first(
        raw,
        "highestInjuryLevel", "cm_highestInjury", "injuryLevel",
        "HighestInjuryLevel", default="Unknown"
    )
    fatal = int(_first(raw, "totalFatal", "fatal", "FatalInjuryCount", "totalFatalities", default=0) or 0)
    serious = int(_first(raw, "totalSerious", "serious", "SeriousInjuryCount", default=0) or 0)
    minor = int(_first(raw, "totalMinor", "minor", "MinorInjuryCount", default=0) or 0)
    uninjured = int(_first(raw, "totalNone", "totalUninjured", "uninjured", default=0) or 0)

    make = _first(raw, "aircraftMake", "make", "Make")
    model = _first(raw, "aircraftModel", "model", "Model")
    reg = _first(raw, "aircraftRegistrationNumber", "n_number", "registration", "reg", "NNumber")
    operator = _first(raw, "operatorName", "operator", "Operator")
    damage = _first(raw, "damageLevel", "aircraftDamage", "damage")

    status = _first(
        raw,
        "completionStatus", "reportStatus", "status", "caseClosed",
        default="Open"
    )
    if status is True:
        status = "Final"
    elif status is False:
        status = "Open"

    mode = mode_hint or _first(raw, "mode", "Mode", "transportMode", default="Aviation")
    if isinstance(mode, str):
        mode = mode.strip().capitalize()
        ml = mode.lower()
        if ml == "aviation":
            mode = "Aviation"
        elif ml in ("railroad", "rail"):
            mode = "Railroad"
        elif ml == "highway":
            mode = "Highway"
        elif ml == "marine":
            mode = "Marine"
        elif ml == "pipeline":
            mode = "Pipeline"
        elif ml in ("hazmat", "hazardous materials"):
            mode = "Hazmat"

    summary = _first(
        raw,
        "prelimNarrative", "concatenatedFactualNarrative", "analysisNarrative",
        "narrative", "summary", "brief", "description", default=""
    )
    if isinstance(summary, str) and len(summary) > 600:
        summary = summary[:597] + "…"

    cause = _first(raw, "probableCause", "findings", "ProbableCause", default="Under investigation.")
    if isinstance(cause, list):
        cause = "; ".join(str(c) for c in cause[:3])
    if isinstance(cause, str) and len(cause) > 500:
        cause = cause[:497] + "…"

    docket = _first(raw, "DocketPage", "docketUrl", "docket")
    report = _first(raw, "ReportPage", "reportUrl", "report_url", "InvestigationPage")
    if not docket and ntsb:
        docket = f"https://data.ntsb.gov/Docket/?ProjectID={ntsb}"

    phase = _first(raw, "broadPhaseOfFlight", "phaseOfFlight", "phase", "PhaseOfFlight")
    weather = _first(raw, "accidentSiteCondition", "weatherCondition", "weather")

    return {
        "id": ntsb or (f"MKEY-{mkey}" if mkey else f"{mode}-{date}-{city}"),
        "ntsbNum": ntsb or "",
        "mkey": mkey,
        "mode": mode,
        "eventDate": date,
        "eventTime": _first(raw, "eventTime", "EventTime"),
        "city": city,
        "state": state,
        "country": country,
        "lat": lat,
        "lon": lon,
        "highestInjury": injury,
        "fatal": fatal,
        "serious": serious,
        "minor": minor,
        "uninjured": uninjured,
        "aircraftDamage": damage,
        "make": make,
        "model": model,
        "reg": reg,
        "operator": operator,
        "status": str(status),
        "reportStatus": str(status),
        "summary": summary or f"{mode} investigation {ntsb or ''}".strip(),
        "probableCause": cause or "Under investigation.",
        "docketUrl": docket,
        "reportUrl": report,
        "phase": phase,
        "weather": weather,
    }


def fetch_v2_page(
    key: str,
    start: str,
    end: str,
    mode: str | None = None,
    marker: str | None = None,
) -> tuple[list[dict], str | None]:
    params: dict[str, str] = {
        "startDate": start,
        "endDate": end,
    }
    if mode:
        params["mode"] = mode
    if marker:
        params["marker"] = marker

    headers = {**HEADERS_BASE, "Ocp-Apim-Subscription-Key": key}
    r = requests.get(V2_URL, headers=headers, params=params, timeout=60)

    if r.status_code == 204:
        return [], None
    if r.status_code == 401:
        raise RuntimeError("401 Unauthorized — check NTSB_SUBSCRIPTION_KEY")
    if r.status_code != 200:
        print(f"[api] {mode or 'all'} HTTP {r.status_code}: {r.text[:200]}", file=sys.stderr)
        return [], None

    data = r.json()

    if isinstance(data, list):
        items = data
        next_marker = None
    elif isinstance(data, dict):
        items = (
            data.get("value")
            or data.get("data")
            or data.get("cases")
            or data.get("results")
            or data.get("items")
            or []
        )
        next_marker = (
            data.get("marker")
            or data.get("nextMarker")
            or data.get("continuationToken")
        )
    else:
        items = []
        next_marker = None

    return items, next_marker


def fetch_recent_cases(key: str, days: int = 90) -> list[dict[str, Any]]:
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=days)
    start_s = start.isoformat()
    end_s = end.isoformat()

    all_raw: list[dict] = []

    for mode in MODES:
        print(f"[api] fetching mode={mode} {start_s} → {end_s}")
        marker = None
        pages = 0
        while pages < 8:
            try:
                items, marker = fetch_v2_page(key, start_s, end_s, mode=mode, marker=marker)
            except Exception as exc:
                print(f"[api] {mode} error: {exc}", file=sys.stderr)
                break
            if not items:
                break
            for it in items:
                if isinstance(it, dict):
                    it["_mode_hint"] = mode
                    all_raw.append(it)
            pages += 1
            if not marker:
                break
            time.sleep(0.4)
        print(f"[api]   → {sum(1 for x in all_raw if x.get('_mode_hint') == mode)} records")

    print(f"[api] fetching unfiltered window")
    try:
        items, _ = fetch_v2_page(key, start_s, end_s, mode=None)
        for it in items:
            if isinstance(it, dict):
                all_raw.append(it)
    except Exception as exc:
        print(f"[api] unfiltered error: {exc}", file=sys.stderr)

    events = []
    seen = set()
    for raw in all_raw:
        mode_hint = raw.pop("_mode_hint", None)
        ev = normalize_case(raw, mode_hint=mode_hint)
        key_id = ev["id"]
        if key_id and key_id not in seen:
            seen.add(key_id)
            events.append(ev)

    events.sort(key=lambda e: e.get("eventDate") or "", reverse=True)
    return events


def merge_events(existing: list[dict], new: list[dict]) -> list[dict]:
    by_id = {e.get("id") or e.get("ntsbNum"): e for e in existing if e.get("id") or e.get("ntsbNum")}
    for e in new:
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
    out.sort(key=lambda x: x.get("eventDate") or "", reverse=True)
    return out


def main() -> int:
    print(f"[vigil] start {utc_now()}")
    existing = load_existing()
    print(f"[vigil] existing events: {len(existing)}")

    key = load_key()
    if not key:
        print(
            "[vigil] No NTSB_SUBSCRIPTION_KEY found.\n"
            "        Set the GitHub secret or create secrets/ntsb_key.txt\n"
            "        Keeping existing/seed data.",
            file=sys.stderr,
        )
        if not existing:
            print("[vigil] nothing to write", file=sys.stderr)
            return 0
        payload = {
            "meta": {
                "generated": utc_now(),
                "source": "seed / previous snapshot (no API key)",
                "count": len(existing),
            },
            "events": existing,
        }
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return 0

    print("[vigil] subscription key present — calling NTSB Public API V2")
    try:
        fresh = fetch_recent_cases(key, days=120)
    except Exception as exc:
        print(f"[vigil] fatal API error: {exc}", file=sys.stderr)
        fresh = []

    print(f"[vigil] fresh records normalized: {len(fresh)}")
    merged = merge_events(existing, fresh)
    print(f"[vigil] merged total: {len(merged)}")

    payload = {
        "meta": {
            "generated": utc_now(),
            "source": "NTSB Public API GetCasesByDateRangeV2 + seed merge",
            "count": len(merged),
            "note": "Hourly GitHub Action. Key via NTSB_SUBSCRIPTION_KEY secret.",
        },
        "events": merged,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[vigil] wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
