"""Isolation Forest anomaly scoring over HoneyChain's own batch records.

Unsupervised: no labels are needed or invented. The model is fitted fresh on the records
supplied (the current qualifying batches) and scores each one. Below the minimum record
count it returns INSUFFICIENT_DATA and no scores at all.
"""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import RobustScaler

VERSION = "iforest-1"


def score_isolation_forest(records: list[dict], minimum: int) -> dict:
    n = len(records)
    if n < minimum:
        return {"status": "INSUFFICIENT_DATA", "recordCount": n, "minimumRequired": minimum, "scores": [], "modelVersion": VERSION}
    keys = sorted({k for r in records for k in r["features"]})
    X = np.array([[np.nan if r["features"].get(k) is None else float(r["features"][k]) for k in keys] for r in records], dtype=float)
    usable = ~np.all(np.isnan(X), axis=0)  # drop features missing everywhere
    X, keys = X[:, usable], [k for k, u in zip(keys, usable) if u]
    model = make_pipeline(SimpleImputer(strategy="median"), RobustScaler(),
                          IsolationForest(n_estimators=200, contamination="auto", random_state=42))
    model.fit(X)
    raw = -model.score_samples(X)          # higher = more anomalous
    flags = model.predict(X) == -1
    return {
        "status": "SCORED",
        "recordCount": n,
        "minimumRequired": minimum,
        "features": keys,
        "modelVersion": VERSION,
        "scores": [{"id": r["id"], "score": float(s), "isOutlier": bool(f)} for r, s, f in zip(records, raw, flags)],
    }
