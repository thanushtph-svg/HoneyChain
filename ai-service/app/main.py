"""HoneyChain AI service (FastAPI). Internal only - called by the Express backend.

Endpoints
  GET  /health
  GET  /models
  GET  /v1/standards              rule set used by the Standards-Based Laboratory Compliance Check
  POST /v1/lab-analysis           PRIMARY lab workflow: standards check + Random Forest (if validated) + combined report
  POST /v1/quality/predict        lab measurements  -> quality model (if trained)            [legacy, not in the lab workflow]
  POST /v1/adulteration/predict   spectral observations -> adulteration model (if trained)   [retired from the lab workflow]
  POST /v1/anomaly/score          batch feature records -> Isolation Forest scores (admin anomaly scan only)
Auth: header X-Service-Key must equal AI_SERVICE_KEY from the project-root .env.
"""
from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import standards_engine
from .anomaly import score_isolation_forest
from .lab_analysis import ML_MODEL_NAME, build_report
from .registry import Registry


def _load_env() -> None:
    env_file = Path(__file__).resolve().parents[2] / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env()
SERVICE_KEY = os.environ.get("AI_SERVICE_KEY", "")

app = FastAPI(title="HoneyChain AI service", version="1.0.0")
registry = Registry()


def require_key(x_service_key: str = Header(default="")) -> None:
    if not SERVICE_KEY or not secrets.compare_digest(x_service_key, SERVICE_KEY):
        raise HTTPException(status_code=401, detail="invalid service key")


@app.get("/health")
def health():
    return {"status": "ok", "models": {n: m.status for n, m in registry.models.items()}}


@app.get("/models", dependencies=[Depends(require_key)])
def models():
    return {"models": [m.public() for m in registry.models.values()]}


@app.post("/admin/reload", dependencies=[Depends(require_key)])
def reload_models():
    registry.reload()
    return {"models": {n: m.status for n, m in registry.models.items()}}


def not_trained(entry, task=None):
    return {"model": entry.name, "status": "NOT_TRAINED", "reason": entry.reason, "prediction": None, "task": task}


# ------------------------------------------------------------------ quality
class QualityIn(BaseModel):
    features: dict[str, Optional[float]]


@app.post("/v1/quality/predict", dependencies=[Depends(require_key)])
def predict_quality(body: QualityIn):
    m = registry.get("honey-quality")
    if m.status != "TRAINED":
        return not_trained(m)
    feats = m.manifest["input_requirements"]["features"]
    unknown = [k for k in body.features if k not in feats and body.features[k] is not None]
    if not any(body.features.get(f) is not None for f in feats):
        raise HTTPException(422, f"none of the required features present: {feats}")
    x = np.array([[np.nan if body.features.get(f) is None else float(body.features[f]) for f in feats]])
    task = m.manifest["task"]
    if task == "classification":
        proba = m.estimator.predict_proba(x)[0]
        classes = [str(c) for c in m.estimator.classes_]
        i = int(np.argmax(proba))
        pred = {"label": classes[i], "value": None, "unit": None, "probabilities": dict(zip(classes, map(float, proba))), "confidence": float(proba[i])}
    else:
        pred = {"label": None, "value": float(m.estimator.predict(x)[0]), "unit": None, "probabilities": None, "confidence": None}
    return {"model": m.name, "status": "TRAINED", "version": m.manifest.get("version"), "task": task,
            "datasetId": m.manifest.get("dataset", {}).get("source"), "prediction": pred,
            "reliability": m.manifest.get("reliability"), "details": {"ignoredInputs": unknown}}


# ------------------------------------------------------------------ adulteration
class AdulterationIn(BaseModel):
    wavelengthsNm: list[float] = Field(min_length=1)
    observations: list[list[float]] = Field(min_length=1, max_length=5000)
    preprocessing: Optional[str] = None


@app.post("/v1/adulteration/predict", dependencies=[Depends(require_key)])
def predict_adulteration(body: AdulterationIn):
    m = registry.get("honey-adulteration")
    if m.status != "TRAINED":
        return not_trained(m)
    req = m.manifest["input_requirements"]
    expected = req["wavelengths_nm"]
    if len(body.wavelengthsNm) != req["band_count"]:
        raise HTTPException(422, f"input has {len(body.wavelengthsNm)} bands; model requires {req['band_count']} bands ({expected[0]}-{expected[-1]} nm)")
    worst = max(abs(a - b) for a, b in zip(body.wavelengthsNm, expected))
    if worst > req["wavelength_tolerance_nm"]:
        raise HTTPException(422, f"band wavelengths differ from the training data by up to {worst:.2f} nm (tolerance {req['wavelength_tolerance_nm']} nm)")
    X = np.asarray(body.observations, dtype=float)
    if X.ndim != 2 or X.shape[1] != req["band_count"] or not np.isfinite(X).all():
        raise HTTPException(422, "observations must be a rectangular array of finite numbers, one row per observation")
    proba = m.estimator.predict_proba(X)[:, 1]
    jar_p = float(proba.mean())
    thr = float(m.manifest["threshold"])
    label = m.manifest["labels"]["1" if jar_p >= thr else "0"]
    return {
        "model": m.name, "status": "TRAINED", "version": m.manifest.get("version"), "task": "classification",
        "datasetId": m.manifest["dataset"]["id"],
        "prediction": {
            "label": label,
            "value": jar_p,
            "unit": "probability of adulteration",
            "probabilities": {"ADULTERATION_SUSPECTED": jar_p, "NO_ADULTERATION_DETECTED": 1 - jar_p},
            "confidence": float(max(jar_p, 1 - jar_p)),
        },
        "details": {
            "observations": int(len(proba)),
            "observationsAboveThreshold": int((proba >= thr).sum()),
            "observationProbability": {"min": float(proba.min()), "median": float(np.median(proba)), "max": float(proba.max())},
            "threshold": thr,
            "evaluation": m.metrics.get("summary"),
        },
        "reliability": m.manifest.get("reliability"),
    }


# ------------------------------------------------------------------ combined lab analysis (primary workflow)
class LabAnalysisIn(BaseModel):
    labReportId: int = Field(ge=1)
    labReportCode: str = Field(min_length=1, max_length=40)
    batchId: int = Field(ge=1)
    batchCode: str = Field(min_length=1, max_length=40)
    honeyType: Optional[str] = Field(default=None, max_length=120)
    honeyCategory: str
    profile: str
    referenceProfile: Optional[str] = None
    measurements: dict[str, Optional[float]]


@app.get("/v1/standards", dependencies=[Depends(require_key)])
def standards():
    return standards_engine.describe()


@app.post("/v1/lab-analysis", dependencies=[Depends(require_key)])
def lab_analysis(body: LabAnalysisIn):
    rules = standards_engine.load_rules()
    if body.profile not in rules["profiles"] or (body.referenceProfile and body.referenceProfile not in rules["profiles"]):
        raise HTTPException(422, f"unknown standards profile; allowed: {sorted(rules['profiles'])}")
    if body.honeyCategory not in rules["categories"]:
        raise HTTPException(422, f"unknown honey category; allowed: {sorted(rules['categories'])}")
    bad = [k for k, v in body.measurements.items() if v is not None and not np.isfinite(v)]
    if bad:
        raise HTTPException(422, f"non-finite measurement values: {bad}")
    try:
        return build_report(
            context=body.model_dump(include={"labReportId", "labReportCode", "batchId", "batchCode", "honeyType"}),
            measurements=body.measurements, category=body.honeyCategory, profile=body.profile,
            reference_profile=body.referenceProfile if body.referenceProfile != body.profile else None,
            ml_entry=registry.models.get(ML_MODEL_NAME),
        )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - never return a partial or fake report
        raise HTTPException(500, f"REPORT_GENERATION_FAILED: {e}") from e


# ------------------------------------------------------------------ anomaly
class AnomalyRecord(BaseModel):
    id: str
    features: dict[str, Optional[float]]


class AnomalyIn(BaseModel):
    minimumRequired: int = Field(ge=10)
    records: list[AnomalyRecord]


@app.post("/v1/anomaly/score", dependencies=[Depends(require_key)])
def anomaly_score(body: AnomalyIn):
    return score_isolation_forest([r.model_dump() for r in body.records], body.minimumRequired)
