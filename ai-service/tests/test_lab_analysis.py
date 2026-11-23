"""Standards-Based Laboratory Compliance Check, combined report, and Random Forest pipeline tests.
Run from ai-service/:  python -m pytest -q
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

os.environ["AI_SERVICE_KEY"] = os.environ.get("AI_SERVICE_KEY") or "test_key_for_pytest_123"

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.lab_analysis import ml_block  # noqa: E402
from app.registry import load_model  # noqa: E402
from app.standards_engine import check_profile, describe  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
KEY = {"X-Service-Key": main.SERVICE_KEY}
client = TestClient(main.app)

GOOD = {"moisture_pct": 17.5, "hmf_mg_kg": 12.0, "sucrose_g_100g": 2.5, "glucose_g_100g": 31.0, "fructose_g_100g": 38.5,
        "free_acidity_meq_kg": 22.0, "electrical_conductivity_ms_cm": 0.45, "ph": 3.9}


def outcome(res, pid):
    return next(c for c in res["checks"] if c["parameter"] == pid)["outcome"]


# ------------------------------------------------------------------ standards engine
def test_all_mandatory_within_limits_is_all_passed():
    r = check_profile("FSSAI", "BLOSSOM", GOOD)
    assert r["status"] == "ALL_PASSED"
    assert r["title"] == "Standards-Based Laboratory Compliance Check"
    assert all(c["outcome"] == "PASS" for c in r["checks"])
    assert r["version"] and r["reference"] and r["notRecorded"]


def test_missing_mandatory_value_is_incomplete_not_pass():
    m = {**GOOD, "glucose_g_100g": None, "free_acidity_meq_kg": None}
    r = check_profile("FSSAI", "BLOSSOM", m)
    assert r["status"] == "INCOMPLETE"
    assert outcome(r, "fg_sum") == "NOT_PROVIDED" and outcome(r, "fg_ratio") == "NOT_PROVIDED"
    assert "Free acidity" in r["missingTests"]


def test_failed_mandatory_standard_is_failed_even_if_others_missing():
    r = check_profile("FSSAI", "BLOSSOM", {**GOOD, "moisture_pct": 21.4, "electrical_conductivity_ms_cm": None})
    assert r["status"] == "FAILED"
    assert outcome(r, "moisture") == "FAIL"
    assert "above the maximum" in next(c for c in r["checks"] if c["parameter"] == "moisture")["explanation"]


def test_category_exceptions_are_applied_not_one_threshold():
    honeydew = {**GOOD, "sucrose_g_100g": 8.0, "electrical_conductivity_ms_cm": 1.1, "glucose_g_100g": 28.0, "fructose_g_100g": 34.0}
    assert outcome(check_profile("FSSAI", "HONEYDEW", honeydew), "sucrose") == "PASS"          # honeydew max 10
    assert outcome(check_profile("FSSAI", "BLOSSOM", honeydew), "sucrose") == "FAIL"           # blossom max 5
    assert outcome(check_profile("FSSAI", "HONEYDEW", honeydew), "electrical_conductivity") == "PASS"  # honeydew min 0.8
    assert outcome(check_profile("FSSAI", "BLOSSOM", honeydew), "electrical_conductivity") == "FAIL"   # blossom max 0.8
    carvia = {**GOOD, "glucose_g_100g": 28.0, "fructose_g_100g": 34.0}                         # F+G = 62
    assert outcome(check_profile("FSSAI", "CARVIA_CALLOSA", carvia), "fg_sum") == "PASS"       # min 60
    assert outcome(check_profile("FSSAI", "BLOSSOM", carvia), "fg_sum") == "FAIL"              # min 65
    blend = check_profile("FSSAI", "BLEND_HONEYDEW_BLOSSOM", GOOD)
    assert outcome(blend, "electrical_conductivity") == "NOT_APPLICABLE"


def test_codex_reference_differs_from_fssai():
    m = {**GOOD, "hmf_mg_kg": 55.0, "moisture_pct": 22.0}
    assert outcome(check_profile("FSSAI", "BLOSSOM", m), "hmf") == "PASS"         # FSSAI max 80
    assert outcome(check_profile("CODEX", "BLOSSOM", m), "hmf") == "FAIL"         # Codex max 40
    assert outcome(check_profile("CODEX", "TROPICAL_ORIGIN", m), "hmf") == "PASS"  # Codex tropical max 80
    assert outcome(check_profile("CODEX", "HEATHER", m), "moisture") == "PASS"     # Codex heather max 23


def test_unit_mistake_is_flagged_implausible():
    r = check_profile("FSSAI", "BLOSSOM", {**GOOD, "electrical_conductivity_ms_cm": 450})  # uS/cm typed as mS/cm
    assert outcome(r, "electrical_conductivity") == "IMPLAUSIBLE"
    assert r["status"] == "INCOMPLETE"


def test_fg_ratio_range():
    r = check_profile("FSSAI", "BLOSSOM", {**GOOD, "glucose_g_100g": 25.0, "fructose_g_100g": 42.0})  # ratio 1.68
    assert outcome(r, "fg_ratio") == "FAIL"


def test_describe_lists_profiles_and_categories():
    d = describe()
    assert {p["key"] for p in d["profiles"]} == {"FSSAI", "CODEX"}
    assert "HONEYDEW" in {c["key"] for c in d["categories"]}


# ------------------------------------------------------------------ combined report endpoint
def payload(**over):
    base = {"labReportId": 1, "labReportCode": "LAB-2026-000001", "batchId": 1, "batchCode": "HC-2026-000001",
            "honeyType": "Multifloral", "honeyCategory": "BLOSSOM", "profile": "FSSAI", "referenceProfile": "CODEX",
            "measurements": GOOD}
    base.update(over)
    return base


def test_lab_analysis_requires_key():
    assert client.post("/v1/lab-analysis", json=payload()).status_code == 401


def test_lab_analysis_report_with_untrained_model():
    r = client.post("/v1/lab-analysis", headers=KEY, json=payload())
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["standardsStatus"] == "ALL_PASSED"
    assert d["mlStatus"] == "NOT_TRAINED" and d["ml"]["prediction"] is None
    assert d["overall"]["status"] == "COMPLETED"  # an untrained ML model no longer limits the report
    assert d["ml"]["shown"] is False
    assert d["standards"]["reference"]["profile"] == "CODEX"
    assert d["humanReview"]["status"] == "PENDING_REVIEW"
    assert d["recommendations"] and d["warnings"] and d["analysedAt"]
    assert d["batch"]["code"] == "HC-2026-000001" and d["labReport"]["code"] == "LAB-2026-000001"


def test_lab_analysis_incomplete_overall():
    d = client.post("/v1/lab-analysis", headers=KEY, json=payload(measurements={**GOOD, "fructose_g_100g": None})).json()
    assert d["standardsStatus"] == "INCOMPLETE" and d["overall"]["status"] == "INCOMPLETE"
    assert d["missingTests"]


def test_lab_analysis_validation_errors():
    assert client.post("/v1/lab-analysis", headers=KEY, json=payload(honeyCategory="MANUKA")).status_code == 422
    assert client.post("/v1/lab-analysis", headers=KEY, json=payload(profile="EU")).status_code == 422
    assert client.post("/v1/lab-analysis", headers=KEY, json=payload(measurements={"moisture_pct": "abc"})).status_code == 422


def test_report_generation_failure_is_an_error_not_a_fake_report(monkeypatch):
    def boom(**_kw):
        raise RuntimeError("template missing")
    monkeypatch.setattr(main, "build_report", boom)
    r = client.post("/v1/lab-analysis", headers=KEY, json=payload())
    assert r.status_code == 500 and "REPORT_GENERATION_FAILED" in r.json()["detail"]


def test_ml_not_available_when_model_failed_to_load():
    from app.registry import ModelEntry
    d = ml_block(ModelEntry("honey-quality", "LOAD_ERROR", "corrupt file"), GOOD)
    assert d["status"] == "NOT_AVAILABLE" and d["prediction"] is None


# ------------------------------------------------------------------ Random Forest pipeline (SYNTHETIC fixture, test only)
def _synthetic_csv(path: Path):
    """Clearly synthetic rows used ONLY to exercise the training/loading code path in a temp dir.
    They are never written to models/ and the resulting model is never used by the service."""
    rng = np.random.default_rng(0)
    rows = []
    for s in range(40):
        cls = "CLASS_A" if s % 2 else "CLASS_B"
        for rep in range(2):
            shift = 3.0 if cls == "CLASS_A" else 0.0
            rows.append({"sample_id": f"S{s}", "label": cls, "moisture_pct": 17 + shift + rng.normal(0, .3),
                         "hmf_mg_kg": 10 + 5 * shift + rng.normal(0, 1), "sucrose_g_100g": 2 + shift + rng.normal(0, .2),
                         "glucose_g_100g": 31 + rng.normal(0, 1), "fructose_g_100g": 38 + rng.normal(0, 1)})
    pd.DataFrame(rows).to_csv(path, index=False)


def test_training_pipeline_and_trained_inference(tmp_path):
    sys.path.insert(0, str(ROOT / "training"))
    import train_quality
    data = tmp_path / "synthetic.csv"
    _synthetic_csv(data)
    card = tmp_path / "card.md"
    card.write_text("SYNTHETIC TEST FIXTURE - not a real dataset", encoding="utf-8")
    out = tmp_path / "models" / "honey-quality"
    rc = train_quality.main(["--data", str(data), "--label", "label", "--group", "sample_id", "--card", str(card),
                             "--licence", "test-only", "--source", "synthetic", "--out", str(out), "--quick"])
    assert rc == 0
    for f in ("model.joblib", "manifest.json", "metrics.json", "feature_metadata.json", "DATASET_CARD.md", "STATUS.json"):
        assert (out / f).exists(), f
    metrics = json.loads((out / "metrics.json").read_text())
    assert "test_balanced_accuracy" in metrics["summary"] and metrics["detail"]["confusion_matrix"]["rows_true_cols_pred"]
    assert metrics["summary"]["n_test_groups"] > 0
    entry = load_model("honey-quality", out.parent)
    assert entry.status == "TRAINED"
    ok = ml_block(entry, GOOD)
    assert ok["status"] == "PREDICTION_AVAILABLE"
    assert ok["prediction"]["predictedClass"] in {"CLASS_A", "CLASS_B"}
    assert ok["prediction"]["probabilities"] is None  # not calibrated -> withheld
    assert ok["modelTestPerformance"]["test_balanced_accuracy"] is not None
    short = ml_block(entry, {**GOOD, "fructose_g_100g": None})
    assert short["status"] == "INSUFFICIENT_INPUT" and short["prediction"] is None


def test_training_refuses_too_little_data(tmp_path):
    sys.path.insert(0, str(ROOT / "training"))
    import train_quality
    data = tmp_path / "tiny.csv"
    pd.DataFrame({"sample_id": ["a", "b"], "label": ["X", "Y"], "moisture_pct": [17, 18]}).to_csv(data, index=False)
    card = tmp_path / "c.md"
    card.write_text("x")
    rc = train_quality.main(["--data", str(data), "--label", "label", "--group", "sample_id", "--card", str(card),
                             "--licence", "x", "--source", "x", "--out", str(tmp_path / "o")])
    assert rc == 2 and not (tmp_path / "o" / "model.joblib").exists()
