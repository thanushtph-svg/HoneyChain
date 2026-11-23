"""Combined laboratory analysis: standards check + Random Forest (only if validated) + report.

The report generator uses fixed, predefined wording. No external LLM is used. Nothing here
approves or rejects a batch: the laboratory tester makes the final decision.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np

from .registry import ModelEntry
from .standards_engine import derived_values, check_profile, load_rules

REPORT_VERSION = "hc-lab-analysis-1"
ML_MODEL_NAME = "honey-quality"
DISCLAIMER = ("The laboratory outcome is assigned automatically by the Standards-Based Laboratory Compliance Check, which "
              "compares the measured values with published limits. It does not prove that honey is pure or adulterated.")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ml_block(entry: Optional[ModelEntry], measurements: dict[str, Any]) -> dict[str, Any]:
    """Random Forest result. Never fabricates a prediction; never fills a missing feature."""
    if entry is None:
        return {"status": "NOT_AVAILABLE", "model": ML_MODEL_NAME, "reason": "Model registry is not available.", "prediction": None}
    if entry.status == "LOAD_ERROR":
        return {"status": "NOT_AVAILABLE", "model": entry.name, "reason": entry.reason, "prediction": None}
    if entry.status != "TRAINED":
        return {"status": "NOT_TRAINED", "model": entry.name, "reason": entry.reason, "prediction": None}
    m = entry.manifest
    feats = m["input_requirements"]["features"]
    values = derived_values(measurements)
    missing = [f for f in feats if values.get(f) is None]
    if missing:
        return {"status": "INSUFFICIENT_INPUT", "model": entry.name, "version": m.get("version"),
                "reason": f"The model needs all of {feats}; missing: {missing}. Missing values are never invented.",
                "requiredFeatures": feats, "missingFeatures": missing, "prediction": None}
    x = np.array([[values[f] for f in feats]], dtype=float)
    try:
        label = str(entry.estimator.predict(x)[0])
        probs = None
        if m.get("probabilities_calibrated") is True:
            p = entry.estimator.predict_proba(x)[0]
            probs = {str(c): round(float(v), 4) for c, v in zip(entry.estimator.classes_, p)}
    except Exception as e:  # noqa: BLE001 - reported, never masked
        return {"status": "NOT_AVAILABLE", "model": entry.name, "version": m.get("version"),
                "reason": f"Model failed during prediction: {e}", "prediction": None}
    return {
        "status": "PREDICTION_AVAILABLE",
        "model": entry.name,
        "version": m.get("version"),
        "predictedAt": now_iso(),
        "features": feats,
        "prediction": {
            "predictedClass": label,
            "classLabels": m.get("labels"),
            "probabilities": probs,
            "probabilitiesNote": None if probs else "Class probabilities are not shown because the model is not calibrated.",
        },
        "modelTestPerformance": entry.metrics.get("summary"),
        "performanceNote": "Test-set performance describes the model in general; it is not the confidence of this prediction.",
        "limitations": m.get("limitations", []),
        "dataset": m.get("dataset"),
    }


def _recommendations(primary: dict, ml: dict) -> list[str]:
    rec = []
    if primary["missingTests"]:
        rec.append(f"Enter the missing mandatory tests before approval: {', '.join(primary['missingTests'])}.")
    if primary["implausibleInputs"]:
        rec.append(f"Re-check the units/values of: {', '.join(primary['implausibleInputs'])} - they are outside the plausible "
                   f"range for honey and were not evaluated.")
    for c in primary["checks"]:
        if c["outcome"] == "FAIL":
            rec.append(f"{c['label']}: {c['explanation']}")
    if primary["status"] == "FAILED":
        rec.append("At least one mandatory standard failed, so the outcome is FAIL. A re-test or confirmatory analysis can be "
                   "requested if a measurement error is suspected.")
    if primary["status"] == "ALL_PASSED":
        rec.append("All HoneyChain-checked mandatory parameters are within limits. Confirm the parameters HoneyChain does not "
                   "record (listed under 'Not recorded by HoneyChain') on the laboratory's full certificate.")
    if ml["status"] == "INSUFFICIENT_INPUT":
        rec.append("Enter the values the ML model needs if a prediction is wanted; it never changes the outcome.")
    return rec


def _warnings(primary: dict, reference: Optional[dict], ml: dict) -> list[str]:
    w = []
    if primary["status"] == "FAILED":
        w.append(f"Mandatory standard(s) failed: {', '.join(primary['failedTests'])}.")
    if primary["status"] == "INCOMPLETE":
        w.append("Standards check is INCOMPLETE - the report must not be read as a pass.")
    if reference and reference["status"] == "FAILED" and primary["status"] != "FAILED":
        w.append(f"The reference standard ({reference['standard']}) is not met for: {', '.join(reference['failedTests'])} "
                 f"(informational; {primary['standard']} is the applicable standard).")
    if ml["status"] == "PREDICTION_AVAILABLE":
        w.append("The ML prediction is a pattern match against its training data. It cannot override a failed standard "
                 "and does not prove purity or adulteration.")
    elif ml["status"] == "NOT_AVAILABLE":
        w.append(f"ML model not available: {ml.get('reason')}")
    w.append(f"HoneyChain records only part of the {primary['standard']}: "
             f"{primary['coverage']['notRecordedByHoneyChain']} parameters are not recorded here.")
    return w


def build_report(*, context: dict[str, Any], measurements: dict[str, Any], category: str, profile: str,
                 reference_profile: Optional[str], ml_entry: Optional[ModelEntry]) -> dict[str, Any]:
    rules = load_rules()
    primary = check_profile(profile, category, measurements, rules)
    reference = check_profile(reference_profile, category, measurements, rules) if reference_profile else None
    ml = ml_block(ml_entry, measurements)
    # The ML model is optional and not part of the outcome: an untrained model does not make the report "limited".
    # Only a trained model that failed or lacked inputs is reported as a limitation.
    ml["shown"] = ml["status"] != "NOT_TRAINED"
    if primary["status"] == "INCOMPLETE":
        overall = "INCOMPLETE"
    elif ml["status"] in ("PREDICTION_AVAILABLE", "NOT_TRAINED"):
        overall = "COMPLETED"
    else:
        overall = "COMPLETED_WITH_LIMITATIONS"
    summary = {
        "ALL_PASSED": "All mandatory parameters checked by HoneyChain are within the applicable limits.",
        "FAILED": f"{len(primary['failedTests'])} mandatory parameter(s) outside the applicable limits.",
        "INCOMPLETE": "Mandatory tests are missing or implausible; the standards result is incomplete.",
    }[primary["status"]]
    vals = derived_values(measurements)
    return {
        "reportVersion": REPORT_VERSION,
        "analysedAt": now_iso(),
        "batch": {"id": context.get("batchId"), "code": context.get("batchCode")},
        "labReport": {"id": context.get("labReportId"), "code": context.get("labReportCode")},
        "honeyType": context.get("honeyType"),
        "honeyCategory": category,
        "measurements": [
            {"field": k, "value": vals[k]} for k in ("moisture_pct", "hmf_mg_kg", "sucrose_g_100g", "glucose_g_100g",
                                                    "fructose_g_100g", "free_acidity_meq_kg", "electrical_conductivity_ms_cm")
        ] + [{"field": k, "value": _f(measurements.get(k))} for k in ("brix", "ph", "water_activity")]
          + [{"field": "fg_sum", "value": vals["fg_sum"], "derived": True}, {"field": "fg_ratio", "value": vals["fg_ratio"], "derived": True}],
        "standards": {"applicable": primary, "reference": reference},
        "standardsStatus": primary["status"],
        "missingTests": primary["missingTests"],
        "ml": ml,
        "mlStatus": ml["status"],
        "overall": {"status": overall, "summary": summary},
        "warnings": _warnings(primary, reference, ml),
        "recommendations": _recommendations(primary, ml),
        "humanReview": {"status": "PENDING_REVIEW", "note": "A laboratory tester must review this report and make the final decision."},
        "disclaimer": DISCLAIMER,
        "engine": {"rulesetVersion": rules["rulesetVersion"], "reportGenerator": "predefined templates (no LLM)"},
    }


def _f(v: Any) -> Optional[float]:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None
