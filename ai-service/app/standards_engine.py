"""Standards-Based Laboratory Compliance Check (deterministic rules, NOT machine learning).

For each configured parameter it reads the measured value, resolves the limit for the honey
category, compares, and returns PASS / FAIL / NOT_PROVIDED / IMPLAUSIBLE / NOT_APPLICABLE with
an explanation. Rules live in standards/honey_standards.json and are versioned.

Status of a profile:
  FAILED      a mandatory parameter is outside its limit
  INCOMPLETE  no failure, but a mandatory value is missing or implausible (never shown as passed)
  ALL_PASSED  every mandatory parameter that applies was measured and is within its limit
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Optional

RULES_FILE = Path(__file__).resolve().parent.parent / "standards" / "honey_standards.json"
TITLE = "Standards-Based Laboratory Compliance Check"
INPUT_FIELDS = ("moisture_pct", "hmf_mg_kg", "sucrose_g_100g", "glucose_g_100g", "fructose_g_100g",
                "free_acidity_meq_kg", "electrical_conductivity_ms_cm")


def load_rules(path: Path = RULES_FILE) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _fmt(x: float) -> str:
    return f"{x:.2f}".rstrip("0").rstrip(".") if x != int(x) else f"{int(x)}"


def _limit_text(rule: dict, unit: str) -> str:
    lo, hi = rule.get("min"), rule.get("max")
    u = "" if unit == "ratio" else f" {unit}"
    if lo is not None and hi is not None:
        return f"{_fmt(lo)} - {_fmt(hi)}{u}"
    if hi is not None:
        return f"<= {_fmt(hi)}{u}"
    return f">= {_fmt(lo)}{u}"


def derived_values(measurements: dict[str, Any]) -> dict[str, Optional[float]]:
    """Measured inputs plus values computed from them (F+G, F/G). Nothing is estimated."""
    v = {k: _num(measurements.get(k)) for k in INPUT_FIELDS}
    f, g = v["fructose_g_100g"], v["glucose_g_100g"]
    v["fg_sum"] = round(f + g, 2) if f is not None and g is not None else None
    v["fg_ratio"] = round(f / g, 3) if f is not None and g is not None and g > 0 else None
    return v


def _plausibility(rules: dict, values: dict[str, Optional[float]]) -> dict[str, str]:
    """Values outside physically plausible ranges usually mean a unit mistake (e.g. uS/cm typed as mS/cm)."""
    issues = {}
    for field, (lo, hi, unit) in rules["plausibleRanges"].items():
        x = values.get(field)
        if x is not None and not (lo <= x <= hi):
            issues[field] = (f"{_fmt(x)} is outside the plausible range {lo}-{hi} {unit} for honey; "
                             f"check the unit and the entry.")
    return issues


def check_profile(profile_key: str, category: str, measurements: dict[str, Any], rules: Optional[dict] = None) -> dict[str, Any]:
    rules = rules or load_rules()
    if profile_key not in rules["profiles"]:
        raise ValueError(f"unknown standards profile {profile_key}")
    if category not in rules["categories"]:
        raise ValueError(f"unknown honey category {category}")
    prof = rules["profiles"][profile_key]
    values = derived_values(measurements)
    implausible = _plausibility(rules, values)
    checks = []
    for p in prof["parameters"]:
        override = p.get("byCategory", {}).get(category)
        rule = override if override is not None else p["rule"]
        rule_source = f"{category} exception" if override is not None else "general limit"
        value = values.get(p["input"])
        base = {"parameter": p["id"], "label": p["label"], "unit": p["unit"], "value": value, "mandatory": p["mandatory"],
                "ruleSource": rule_source, "note": p.get("note")}
        if "notApplicable" in rule:
            checks.append({**base, "limit": "not applicable", "outcome": "NOT_APPLICABLE", "explanation": rule["notApplicable"]})
            continue
        limit = _limit_text(rule, p["unit"])
        sources = [p["input"]] if p["input"] in INPUT_FIELDS else ["fructose_g_100g", "glucose_g_100g"]
        bad_inputs = [s for s in sources if s in implausible]
        if bad_inputs:
            checks.append({**base, "limit": limit, "outcome": "IMPLAUSIBLE",
                           "explanation": " ".join(implausible[s] for s in bad_inputs) + " Not evaluated."})
            continue
        if value is None:
            missing = [s for s in sources if values.get(s) is None]
            checks.append({**base, "limit": limit, "outcome": "NOT_PROVIDED",
                           "explanation": f"Not provided (missing: {', '.join(missing)}). This test must be entered before approval."
                           if p["mandatory"] else "Not provided."})
            continue
        lo, hi = rule.get("min"), rule.get("max")
        fail = (hi is not None and value > hi) or (lo is not None and value < lo)
        shown = _fmt(value) + ("" if p["unit"] == "ratio" else f" {p['unit']}")
        if fail:
            side = "above the maximum" if hi is not None and value > hi else "below the minimum"
            expl = f"{shown} is {side} ({limit}) of the {prof['name']} ({rule_source}). {p.get('failAdvice', '')}".strip()
        else:
            expl = f"{shown} is within the {prof['name']} limit ({limit}, {rule_source})."
        checks.append({**base, "limit": limit, "outcome": "FAIL" if fail else "PASS", "explanation": expl})

    mand = [c for c in checks if c["mandatory"] and c["outcome"] != "NOT_APPLICABLE"]
    if any(c["outcome"] == "FAIL" for c in mand):
        status = "FAILED"
    elif any(c["outcome"] in ("NOT_PROVIDED", "IMPLAUSIBLE") for c in mand):
        status = "INCOMPLETE"
    else:
        status = "ALL_PASSED"
    return {
        "title": TITLE,
        "kind": "RULE_BASED",
        "profile": profile_key,
        "standard": prof["name"],
        "reference": prof["reference"],
        "version": prof["version"],
        "verification": prof["verification"],
        "rulesetVersion": rules["rulesetVersion"],
        "honeyCategory": category,
        "honeyCategoryLabel": rules["categories"][category],
        "status": status,
        "checks": checks,
        "missingTests": [c["label"] for c in mand if c["outcome"] == "NOT_PROVIDED"],
        "implausibleInputs": [c["label"] for c in mand if c["outcome"] == "IMPLAUSIBLE"],
        "failedTests": [c["label"] for c in mand if c["outcome"] == "FAIL"],
        "notRecorded": prof.get("notRecorded", []),
        "coverage": {"checked": len(checks), "notRecordedByHoneyChain": len(prof.get("notRecorded", []))},
    }


def describe(rules: Optional[dict] = None) -> dict[str, Any]:
    rules = rules or load_rules()
    return {
        "title": TITLE,
        "rulesetVersion": rules["rulesetVersion"],
        "categories": [{"key": k, "label": v} for k, v in rules["categories"].items()],
        "profiles": [{"key": k, "name": p["name"], "reference": p["reference"], "version": p["version"],
                      "verification": p["verification"],
                      "parameters": [{"id": x["id"], "label": x["label"], "unit": x["unit"], "mandatory": x["mandatory"],
                                      "limit": _limit_text(x["rule"], x["unit"]),
                                      "exceptions": {c: ("not applicable" if "notApplicable" in r else _limit_text(r, x["unit"]))
                                                     for c, r in x.get("byCategory", {}).items()}}
                                     for x in p["parameters"]],
                      "notRecorded": p.get("notRecorded", [])}
                     for k, p in rules["profiles"].items()],
    }
