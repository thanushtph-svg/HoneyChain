"""Model registry with strict gating.

A model is reported as TRAINED only if ALL of these exist in models/<name>/ and agree:
  model.joblib      fitted sklearn pipeline
  manifest.json     task, inputs, labels, dataset id/licence/sha256, model_sha256
  metrics.json      evaluation produced by the training script
  DATASET_CARD.md   human-readable dataset documentation
and the SHA-256 of model.joblib equals manifest["model_sha256"].

Anything else -> NOT_TRAINED with a reason. There is no code path that returns a
default, random or rule-derived "prediction".
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import joblib

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
REQUIRED = ("model.joblib", "manifest.json", "metrics.json", "DATASET_CARD.md")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@dataclass
class ModelEntry:
    name: str
    status: str  # TRAINED | NOT_TRAINED
    reason: str | None = None
    manifest: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)
    estimator: Any = None

    def public(self) -> dict[str, Any]:
        m = self.manifest
        return {
            "name": self.name,
            "status": self.status,
            "reason": self.reason,
            "task": m.get("task"),
            "version": m.get("version"),
            "description": m.get("description"),
            "inputModality": m.get("input_modality"),
            "inputRequirements": m.get("input_requirements"),
            "labels": m.get("labels"),
            "dataset": m.get("dataset"),
            "metricsSummary": self.metrics.get("summary"),
            "reliability": m.get("reliability"),
            "limitations": m.get("limitations"),
            "trainedAt": m.get("trained_at"),
        }


def load_model(name: str, model_dir: Path = MODEL_DIR) -> ModelEntry:
    d = model_dir / name
    status_file = d / "STATUS.json"
    blocker = None
    if status_file.exists():
        blocker = json.loads(status_file.read_text(encoding="utf-8")).get("reason")
    missing = [f for f in REQUIRED if not (d / f).exists()]
    if missing:
        reason = blocker or f"Not trained - validated labelled dataset required (missing: {', '.join(missing)})"
        return ModelEntry(name, "NOT_TRAINED", reason)
    manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    metrics = json.loads((d / "metrics.json").read_text(encoding="utf-8"))
    digest = sha256_file(d / "model.joblib")
    if manifest.get("model_sha256") != digest:
        return ModelEntry(name, "NOT_TRAINED", "Model file does not match its manifest (sha256 mismatch) - retrain", manifest, metrics)
    if not metrics.get("summary"):
        return ModelEntry(name, "NOT_TRAINED", "No evaluation metrics recorded - retrain", manifest, metrics)
    import sklearn

    trained_with = manifest.get("sklearn_version")
    if trained_with and trained_with != sklearn.__version__:
        return ModelEntry(name, "NOT_TRAINED",
                          f"Model was trained with scikit-learn {trained_with} but {sklearn.__version__} is installed - "
                          f"run the training script again (python training/train_adulteration.py)", manifest, metrics)
    estimator = joblib.load(d / "model.joblib")
    return ModelEntry(name, "TRAINED", None, manifest, metrics, estimator)


class Registry:
    NAMES = ("honey-quality", "honey-adulteration")

    def __init__(self, model_dir: Path = MODEL_DIR):
        self.model_dir = model_dir
        self.reload()

    def reload(self) -> None:
        self.models = {n: load_model(n, self.model_dir) for n in self.NAMES}

    def get(self, name: str) -> ModelEntry:
        return self.models[name]
