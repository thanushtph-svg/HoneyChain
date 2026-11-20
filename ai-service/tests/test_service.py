"""Tests for the AI service. Run from ai-service/:  python -m pytest -q"""
import json
import os
import shutil
from pathlib import Path

import pandas as pd
import pytest

os.environ["AI_SERVICE_KEY"] = os.environ.get("AI_SERVICE_KEY") or "test_key_for_pytest_123"

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.registry import Registry, load_model  # noqa: E402

KEY = {"X-Service-Key": main.SERVICE_KEY}
ROOT = Path(__file__).resolve().parent.parent
client = TestClient(main.app)


def scan(name):
    df = pd.read_csv(ROOT / "samples" / name)
    bands = [c for c in df.columns if c.endswith("nm")]
    return {"wavelengthsNm": [float(b[:-2]) for b in bands], "observations": df[bands].values.tolist()}


def test_requires_service_key():
    assert client.get("/models").status_code == 401
    assert client.get("/models", headers={"X-Service-Key": "wrong"}).status_code == 401


def test_models_status_is_honest():
    r = client.get("/models", headers=KEY).json()["models"]
    by = {m["name"]: m for m in r}
    assert by["honey-quality"]["status"] == "NOT_TRAINED"
    assert "dataset required" in by["honey-quality"]["reason"]
    assert by["honey-adulteration"]["status"] == "TRAINED"
    assert by["honey-adulteration"]["reliability"]["level"] in {"LOW", "MODERATE", "HIGH"}


def test_untrained_quality_never_predicts():
    r = client.post("/v1/quality/predict", headers=KEY, json={"features": {"moisture_pct": 17.8, "hmf_mg_kg": 9.6, "sucrose_g_100g": 3.1}})
    body = r.json()
    assert r.status_code == 200
    assert body["status"] == "NOT_TRAINED" and body["prediction"] is None


def test_tampered_model_file_is_not_trusted(tmp_path):
    src = ROOT / "models" / "honey-adulteration"
    dst = tmp_path / "honey-adulteration"
    shutil.copytree(src, dst)
    with open(dst / "model.joblib", "ab") as f:
        f.write(b"tamper")
    entry = load_model("honey-adulteration", tmp_path)
    assert entry.status == "NOT_TRAINED" and "sha256" in entry.reason


def test_missing_metrics_means_not_trained(tmp_path):
    shutil.copytree(ROOT / "models" / "honey-adulteration", tmp_path / "honey-adulteration")
    (tmp_path / "honey-adulteration" / "metrics.json").unlink()
    assert load_model("honey-adulteration", tmp_path).status == "NOT_TRAINED"


@pytest.mark.parametrize("name", ["demo_scan_c9_manuka_0pct.csv", "demo_scan_c9_manuka_25pct.csv"])
def test_adulteration_prediction_on_held_out_demo_jars(name):
    r = client.post("/v1/adulteration/predict", headers=KEY, json=scan(name))
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["status"] == "TRAINED"
    assert b["prediction"]["label"] in {"ADULTERATION_SUSPECTED", "NO_ADULTERATION_DETECTED"}
    assert 0 <= b["prediction"]["value"] <= 1
    assert b["details"]["observations"] == 150


def test_adulteration_rejects_lab_fields_and_wrong_bands():
    # lab measurements are not spectral input
    r = client.post("/v1/adulteration/predict", headers=KEY, json={"wavelengthsNm": [1, 2, 3], "observations": [[17.8, 9.6, 3.1]]})
    assert r.status_code == 422
    s = scan("demo_scan_c9_manuka_0pct.csv")
    s["wavelengthsNm"] = [w + 1.0 for w in s["wavelengthsNm"]]
    assert client.post("/v1/adulteration/predict", headers=KEY, json=s).status_code == 422


def test_anomaly_insufficient_data():
    recs = [{"id": f"B{i}", "features": {"a": float(i)}} for i in range(5)]
    b = client.post("/v1/anomaly/score", headers=KEY, json={"minimumRequired": 50, "records": recs}).json()
    assert b["status"] == "INSUFFICIENT_DATA" and b["scores"] == []


def test_anomaly_scores_flag_an_obvious_outlier():
    # algorithm test only (synthetic numbers, not a model claim)
    recs = [{"id": f"B{i}", "features": {"yield": 0.97 + (i % 5) * 0.003, "days": 10 + i % 4}} for i in range(60)]
    recs.append({"id": "ODD", "features": {"yield": 0.40, "days": 90}})
    b = client.post("/v1/anomaly/score", headers=KEY, json={"minimumRequired": 50, "records": recs}).json()
    assert b["status"] == "SCORED"
    odd = next(s for s in b["scores"] if s["id"] == "ODD")
    assert odd["isOutlier"] and odd["score"] == max(s["score"] for s in b["scores"])


def test_manifest_records_dataset_and_licence():
    m = json.loads((ROOT / "models" / "honey-adulteration" / "manifest.json").read_text())
    assert m["dataset"]["licence"] == "CC BY 4.0"
    assert len(m["input_requirements"]["wavelengths_nm"]) == 128
