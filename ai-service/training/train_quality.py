"""Train the HoneyChain Random Forest lab-analysis model - ONLY from a real, labelled, licensed dataset.

No dataset is bundled: no genuine per-sample, expert/reference-labelled honey lab dataset could be
verified (see models/honey-quality/STATUS.json and DATASET_INVESTIGATION.md). This script refuses to
run unless the data meets minimum requirements, and it never invents labels or values.

Pipeline
  1. clean        numeric coercion, drop rows without label/group, drop exact duplicates
  2. derive       fg_sum / fg_ratio when fructose and glucose columns exist
  3. select       candidate HoneyChain features present in the data with <= --max-missing missing
  4. split        GroupShuffleSplit by --group (a sample/producer id) -> held-out TEST set
                  (all rows of one original sample stay on one side; no leakage)
  5. impute       median imputation fitted inside the pipeline on training folds only
  6. imbalance    class_weight in {None, "balanced"} chosen by validation, not assumed
  7. tune         GridSearchCV with GroupKFold on the TRAINING set only (validation folds)
  8. evaluate     once, on the untouched TEST set: balanced accuracy, per-class precision/recall/F1,
                  macro averages, confusion matrix. Training accuracy is never reported as test accuracy.
  9. save         model.joblib, manifest.json (sha256, sklearn version, features), metrics.json,
                  feature_metadata.json, DATASET_CARD.md, STATUS.json

At inference the model requires ALL selected features; missing inputs are reported as
INSUFFICIENT_INPUT and are never imputed. Probabilities are withheld (not calibrated).

Usage:
  python training/train_quality.py --data data/raw/quality.csv --label grade --group sample_id \
         --card path/to/DATASET_CARD.md --licence "CC BY 4.0" --source "https://..."
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
import sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import balanced_accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import GridSearchCV, GroupKFold, GroupShuffleSplit
from sklearn.pipeline import Pipeline

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "models" / "honey-quality"
CANDIDATES = ["moisture_pct", "hmf_mg_kg", "sucrose_g_100g", "glucose_g_100g", "fructose_g_100g", "fg_sum", "fg_ratio",
              "free_acidity_meq_kg", "electrical_conductivity_ms_cm", "ph", "brix", "water_activity"]
MIN_ROWS = 60
MIN_PER_CLASS = 10
MIN_GROUPS = 10
MIN_FEATURES = 3


def refuse(problems: list[str]) -> int:
    print("REFUSING TO TRAIN:\n  - " + "\n  - ".join(problems))
    return 2


def prepare(df: pd.DataFrame, label: str, group: str, max_missing: float, only: list[str] | None):
    df = df.copy()
    df = df[df[label].notna() & df[group].notna()].drop_duplicates()
    for c in CANDIDATES:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    if {"fructose_g_100g", "glucose_g_100g"} <= set(df.columns):
        df["fg_sum"] = df["fructose_g_100g"] + df["glucose_g_100g"]
        df["fg_ratio"] = df["fructose_g_100g"] / df["glucose_g_100g"].where(df["glucose_g_100g"] > 0)
    pool = [c for c in CANDIDATES if c in df.columns and (only is None or c in only)]
    missing_frac = {c: float(df[c].isna().mean()) for c in pool}
    feats = [c for c in pool if missing_frac[c] <= max_missing]
    dropped = {c: round(missing_frac[c], 3) for c in pool if c not in feats}
    return df, feats, missing_frac, dropped


def split(y, groups, test_size: float, seed: int):
    classes = set(y)
    for s in range(seed, seed + 50):
        tr, te = next(GroupShuffleSplit(n_splits=1, test_size=test_size, random_state=s).split(np.zeros(len(y)), y, groups))
        if set(y[tr]) == classes and set(y[te]) == classes:
            return tr, te, s
    return None


def train(a) -> int:
    df0 = pd.read_csv(a.data)
    problems = [f"column '{c}' missing" for c in (a.label, a.group) if c not in df0.columns]
    if problems:
        return refuse(problems)
    df, feats, missing_frac, dropped = prepare(df0, a.label, a.group, a.max_missing, a.features)
    y = df[a.label].astype(str).to_numpy()
    groups = df[a.group].astype(str).to_numpy()
    counts = pd.Series(y).value_counts()
    if len(feats) < MIN_FEATURES:
        problems.append(f"need >= {MIN_FEATURES} usable features from {CANDIDATES}, found {feats} (dropped for missingness: {dropped})")
    if len(df) < MIN_ROWS:
        problems.append(f"need >= {MIN_ROWS} rows after cleaning, found {len(df)}")
    if len(counts) < 2 or counts.min() < MIN_PER_CLASS:
        problems.append(f"need >= 2 classes with >= {MIN_PER_CLASS} rows each, found {counts.to_dict()}")
    if len(set(groups)) < MIN_GROUPS:
        problems.append(f"need >= {MIN_GROUPS} distinct '{a.group}' values, found {len(set(groups))}")
    if problems:
        return refuse(problems)

    sp = split(y, groups, a.test_size, a.seed)
    if sp is None:
        return refuse(["could not make a grouped train/test split that contains every class on both sides"])
    tr, te, split_seed = sp
    X = df[feats].to_numpy(dtype=float)
    n_train_groups = len(set(groups[tr]))
    k = min(5, n_train_groups)
    pipe = Pipeline([("impute", SimpleImputer(strategy="median")), ("rf", RandomForestClassifier(random_state=a.seed))])
    grid = {
        "rf__n_estimators": [200, 400],
        "rf__max_depth": [None, 4, 8],
        "rf__min_samples_leaf": [1, 3, 5],
        "rf__class_weight": [None, "balanced"],
    }
    if a.quick:  # pipeline smoke test only - not for a model that will be used
        grid = {"rf__n_estimators": [50], "rf__max_depth": [None, 4], "rf__class_weight": [None, "balanced"]}
    search = GridSearchCV(pipe, grid, scoring="balanced_accuracy", cv=GroupKFold(n_splits=k), n_jobs=1, refit=True)
    search.fit(X[tr], y[tr], groups=groups[tr])
    model = search.best_estimator_

    pred = model.predict(X[te])
    labels = sorted(set(y))
    report = classification_report(y[te], pred, labels=labels, output_dict=True, zero_division=0)
    summary = {
        "headline": "Held-out grouped TEST set (never used for training or tuning)",
        "test_balanced_accuracy": round(float(balanced_accuracy_score(y[te], pred)), 4),
        "test_macro_precision": round(report["macro avg"]["precision"], 4),
        "test_macro_recall": round(report["macro avg"]["recall"], 4),
        "test_macro_f1": round(report["macro avg"]["f1-score"], 4),
        "validation_balanced_accuracy": round(float(search.best_score_), 4),
        "n_train": int(len(tr)), "n_test": int(len(te)),
        "n_train_groups": n_train_groups, "n_test_groups": int(len(set(groups[te]))),
        "classes": labels,
    }
    detail = {
        "per_class": {l: {k2: round(v, 4) for k2, v in report[l].items()} for l in labels},
        "confusion_matrix": {"labels": labels, "rows_true_cols_pred": confusion_matrix(y[te], pred, labels=labels).tolist()},
        "best_params": search.best_params_,
        "protocol": f"GroupShuffleSplit(test_size={a.test_size}, seed={split_seed}) by '{a.group}'; "
                    f"GridSearchCV(GroupKFold({k})) on the training part only; scoring=balanced_accuracy",
        "class_counts_total": counts.to_dict(),
    }

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, out / "model.joblib")
    shutil.copyfile(a.card, out / "DATASET_CARD.md")
    version = datetime.now(timezone.utc).strftime("%Y.%m.%d")
    feature_meta = {
        "features": feats,
        "units": {"moisture_pct": "% by mass", "hmf_mg_kg": "mg/kg", "sucrose_g_100g": "g/100 g", "glucose_g_100g": "g/100 g",
                  "fructose_g_100g": "g/100 g", "fg_sum": "g/100 g", "fg_ratio": "ratio", "free_acidity_meq_kg": "meq/kg",
                  "electrical_conductivity_ms_cm": "mS/cm", "ph": "-", "brix": "degrees Brix", "water_activity": "aw"},
        "training_missing_fraction": {f: round(missing_frac[f], 3) for f in feats},
        "dropped_for_missingness": dropped,
        "inference_rule": "all features required; missing inputs are never imputed at inference",
    }
    (out / "feature_metadata.json").write_text(json.dumps(feature_meta, indent=2), encoding="utf-8")
    manifest = {
        "name": "honey-quality", "version": version, "task": "classification",
        "description": f"Random Forest classifier: does the sample resemble the '{a.label}' classes of the training data.",
        "input_modality": "LAB_MEASUREMENTS",
        "input_requirements": {"features": feats, "missing_values": "not allowed at inference"},
        "labels": {l: l for l in labels},
        "probabilities_calibrated": False,
        "dataset": {"source": a.source, "licence": a.licence, "sha256": hashlib.sha256(Path(a.data).read_bytes()).hexdigest(),
                    "rows": int(len(df)), "label_column": a.label, "group_column": a.group},
        "reliability": {"level": "UNRATED", "summary": f"Held-out test balanced accuracy {summary['test_balanced_accuracy']} "
                                                     f"on {summary['n_test']} rows / {summary['n_test_groups']} groups."},
        "limitations": [
            "Valid only for honeys similar to the training data (origin, botanical source, methods).",
            "A predicted class is a pattern match, not proof of purity or adulteration.",
            "It never overrides a failed mandatory standard; the laboratory tester decides.",
            "Class probabilities are not reported because the model is not calibrated.",
        ],
        "sklearn_version": sklearn.__version__,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_sha256": hashlib.sha256((out / "model.joblib").read_bytes()).hexdigest(),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (out / "metrics.json").write_text(json.dumps({"summary": summary, "detail": detail}, indent=2, default=str), encoding="utf-8")
    (out / "STATUS.json").write_text(json.dumps({"status": "TRAINED", "version": version, "trained_at": manifest["trained_at"],
                                                 "dataset": manifest["dataset"]}, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--label", required=True, help="ground-truth class column from reference lab results or expert classification")
    ap.add_argument("--group", required=True, help="original sample/producer id; rows of one sample never span train and test")
    ap.add_argument("--card", required=True, help="DATASET_CARD.md documenting source, licence, columns, units, label definitions")
    ap.add_argument("--licence", required=True)
    ap.add_argument("--source", required=True)
    ap.add_argument("--features", nargs="*", default=None, help="restrict to these candidate features")
    ap.add_argument("--max-missing", type=float, default=0.3, help="drop a feature missing in more than this fraction of rows")
    ap.add_argument("--test-size", type=float, default=0.25)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--quick", action="store_true", help="tiny grid for pipeline smoke tests only")
    return train(ap.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
