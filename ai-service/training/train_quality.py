"""Train the honey QUALITY model - only from a real, labelled, licensed dataset you supply.

No dataset is bundled (see models/honey-quality/STATUS.json for why). This script refuses to
run unless the data meets minimum requirements, and it never invents labels.

CSV format (one row per honey sample) - columns use HoneyChain lab-form names:
  moisture_pct, hmf_mg_kg, sucrose_g_100g, glucose_g_100g, fructose_g_100g, brix, ph,
  free_acidity_meq_kg, water_activity, electrical_conductivity_ms_cm   (any subset >= 3)
  <label column>   the ground-truth target (class name, or a number for regression)
  <group column>   sample/producer id so related rows never span train and test

Usage:
  python training/train_quality.py --data data/raw/quality.csv --label grade --group sample_id \
         --card path/to/DATASET_CARD.md --licence "CC BY 4.0" --source "https://..."
  (add --task regression for a numeric target)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import balanced_accuracy_score, classification_report, confusion_matrix, mean_absolute_error, r2_score
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import Pipeline

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "models" / "honey-quality"
FEATURES = ["moisture_pct", "hmf_mg_kg", "sucrose_g_100g", "glucose_g_100g", "fructose_g_100g", "brix", "ph",
            "free_acidity_meq_kg", "water_activity", "electrical_conductivity_ms_cm"]
MIN_ROWS = 60
MIN_PER_CLASS = 10


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--group", required=True)
    ap.add_argument("--card", required=True, help="DATASET_CARD.md documenting source, licence, columns, label definitions")
    ap.add_argument("--licence", required=True)
    ap.add_argument("--source", required=True)
    ap.add_argument("--task", choices=["classification", "regression"], default="classification")
    a = ap.parse_args()

    df = pd.read_csv(a.data)
    feats = [f for f in FEATURES if f in df.columns]
    problems = []
    if len(feats) < 3:
        problems.append(f"need >= 3 feature columns from {FEATURES}, found {feats}")
    if a.label not in df.columns:
        problems.append(f"label column '{a.label}' missing")
    if a.group not in df.columns:
        problems.append(f"group column '{a.group}' missing")
    if len(df) < MIN_ROWS:
        problems.append(f"need >= {MIN_ROWS} rows, found {len(df)}")
    if not problems and a.task == "classification":
        counts = df[a.label].value_counts()
        if len(counts) < 2 or counts.min() < MIN_PER_CLASS:
            problems.append(f"need >= 2 classes with >= {MIN_PER_CLASS} rows each, found {counts.to_dict()}")
    if problems:
        print("REFUSING TO TRAIN:\n  - " + "\n  - ".join(problems))
        return 2

    X = df[feats].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    y = df[a.label].to_numpy()
    groups = df[a.group].astype(str).to_numpy()
    if a.task == "classification":
        est = Pipeline([("impute", SimpleImputer(strategy="median")),
                        ("rf", RandomForestClassifier(n_estimators=300, class_weight="balanced", random_state=42))])
    else:
        est = Pipeline([("impute", SimpleImputer(strategy="median")), ("rf", RandomForestRegressor(n_estimators=300, random_state=42))])
        y = y.astype(float)
    k = min(5, len(set(groups)))
    pred = cross_val_predict(est, X, y, groups=groups, cv=GroupKFold(k))
    if a.task == "classification":
        labels = sorted(set(y))
        summary = {"balanced_accuracy": round(balanced_accuracy_score(y, pred), 4), "n": int(len(y)), "classes": [str(l) for l in labels]}
        detail = {"report": classification_report(y, pred, output_dict=True, zero_division=0),
                  "confusion_matrix": {"labels": [str(l) for l in labels], "matrix": confusion_matrix(y, pred, labels=labels).tolist()}}
    else:
        summary = {"mae": round(mean_absolute_error(y, pred), 4), "r2": round(r2_score(y, pred), 4), "n": int(len(y))}
        detail = {}
    est.fit(X, y)
    OUT.mkdir(parents=True, exist_ok=True)
    joblib.dump(est, OUT / "model.joblib")
    shutil.copyfile(a.card, OUT / "DATASET_CARD.md")
    manifest = {
        "name": "honey-quality", "version": datetime.now(timezone.utc).strftime("%Y.%m.%d"), "task": a.task,
        "description": f"Random Forest baseline predicting '{a.label}' from laboratory measurements.",
        "input_modality": "LAB_MEASUREMENTS", "input_requirements": {"features": feats, "missing_values": "median-imputed"},
        "labels": {str(l): str(l) for l in sorted(set(df[a.label]))} if a.task == "classification" else None,
        "dataset": {"source": a.source, "licence": a.licence, "sha256": hashlib.sha256(Path(a.data).read_bytes()).hexdigest(), "rows": int(len(df))},
        "reliability": {"level": "UNRATED", "summary": f"GroupKFold({k}) by {a.group}: {summary}"},
        "limitations": ["Valid only for samples similar to the training data.", "Decision support only."],
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_sha256": hashlib.sha256((OUT / "model.joblib").read_bytes()).hexdigest(),
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (OUT / "metrics.json").write_text(json.dumps({"summary": summary, "detail": detail, "protocol": f"GroupKFold({k}) by {a.group}"}, indent=2, default=str), encoding="utf-8")
    (OUT / "STATUS.json").unlink(missing_ok=True)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
