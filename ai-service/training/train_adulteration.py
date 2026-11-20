"""Train and independently evaluate the honey ADULTERATION model (hyperspectral input only).

Task (binary): is a honey jar adulterated with sugar syrup (5-50 %) or not (0 %)?
  * label derived from the dataset's measured adulteration level (Concentration_Class > 0).
    The dataset's own "Adultration" column is NOT used: it marks only the 50 % level as "Yes"
    (5/10/25 % are "No"), which contradicts the concentration ground truth.
  * pure sugar-syrup rows (Brand == "Sugar") are excluded - they are not honey.
Inputs: 128 reflectance bands (399.40-1063.79 nm) of one segmented observation.
Leakage control: every jar contributes 6 acquisitions x 25 segments. A "jar" is identified by
  (Brand, Class, exact Concentration). Evaluation splits by honey PRODUCT (Brand, Class) so the
  model is always tested on honey products it has never seen (strictest, realistic setting).
  A secondary jar-grouped evaluation (product seen, jar unseen) is also reported.
Nested evaluation: outer Leave-One-Product-Out; inner GroupKFold by product chooses among
  candidate models. Outer predictions are therefore never influenced by the test product.

Usage (from ai-service/):  python training/train_adulteration.py
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score, confusion_matrix, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import GroupKFold, LeaveOneGroupOut, cross_val_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import FunctionTransformer, StandardScaler

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.preprocessing import snv, snv_first_derivative  # noqa: E402

DATA = ROOT / "data" / "raw" / "adulteration.csv"
OUT = ROOT / "models" / "honey-adulteration"
SAMPLES = ROOT / "samples"
SEED = 42
THRESHOLD = 0.5
# Two jars are held out of the FINAL model so the demo files are genuine out-of-sample examples
DEMO_JARS = [("C9", "Manuka", 0), ("C9", "Manuka", 25)]


def candidates() -> dict[str, Pipeline]:
    return {
        "logreg_snv_d1": Pipeline([("pre", FunctionTransformer(snv_first_derivative)), ("scale", StandardScaler()),
                                   ("clf", LogisticRegression(C=0.1, class_weight="balanced", max_iter=5000))]),
        "logreg_snv": Pipeline([("pre", FunctionTransformer(snv)), ("scale", StandardScaler()),
                                ("clf", LogisticRegression(C=0.1, class_weight="balanced", max_iter=5000))]),
        "random_forest": Pipeline([("clf", RandomForestClassifier(n_estimators=150, min_samples_leaf=5, class_weight="balanced",
                                                                  n_jobs=-1, random_state=SEED))]),
    }


def load() -> tuple[pd.DataFrame, list[str]]:
    if not DATA.exists():
        raise SystemExit(f"Dataset not found at {DATA}. Run: python training/download_data.py")
    df = pd.read_csv(DATA)
    required = {"Brand", "Class", "Concentration_Class", "Concentration", "Acquisition"}
    if not required.issubset(df.columns):
        raise SystemExit(f"Unexpected columns; need {sorted(required)}")
    bands = [c for c in df.columns if str(c).endswith("nm")]
    if len(bands) != 128:
        raise SystemExit(f"Expected 128 spectral band columns, found {len(bands)}")
    df = df[df["Brand"] != "Sugar"].copy()
    df["product"] = df["Brand"] + "|" + df["Class"]
    df["jar"] = df["product"] + "|" + df["Concentration"].round(4).astype(str)
    df["y"] = (df["Concentration_Class"] > 0).astype(int)
    return df.reset_index(drop=True), bands


def metrics(y, p, prob=None) -> dict:
    tn, fp, fn, tp = confusion_matrix(y, p, labels=[0, 1]).ravel()
    out = {
        "n": int(len(y)), "positives": int(sum(y)), "negatives": int(len(y) - sum(y)),
        "balanced_accuracy": round(balanced_accuracy_score(y, p), 4),
        "precision_adulterated": round(precision_score(y, p, zero_division=0), 4),
        "recall_adulterated": round(recall_score(y, p, zero_division=0), 4),
        "f1_adulterated": round(f1_score(y, p, zero_division=0), 4),
        "specificity_pure": round(tn / (tn + fp), 4) if (tn + fp) else None,
        "confusion_matrix": {"labels": ["pure(0)", "adulterated(1)"], "rows_true_cols_pred": [[int(tn), int(fp)], [int(fn), int(tp)]]},
    }
    if prob is not None and len(set(y)) == 2:
        out["roc_auc"] = round(roc_auc_score(y, prob), 4)
    return out


def jar_level(df: pd.DataFrame, prob: np.ndarray) -> pd.DataFrame:
    j = pd.DataFrame({"jar": df["jar"], "y": df["y"], "conc": df["Concentration_Class"], "prob": prob})
    g = j.groupby("jar").agg(y=("y", "first"), conc=("conc", "first"), prob=("prob", "mean")).reset_index()
    g["pred"] = (g["prob"] >= THRESHOLD).astype(int)
    return g


def nested_lopo(df, X, y, cands) -> tuple[np.ndarray, list]:
    prob = np.zeros(len(y))
    chosen = []
    for tr, te in LeaveOneGroupOut().split(X, y, df["product"]):
        inner_groups = df["product"].values[tr]
        scores = {}
        for name, est in cands.items():
            s = cross_val_score(clone(est), X[tr], y[tr], groups=inner_groups, cv=GroupKFold(4), scoring="balanced_accuracy")
            scores[name] = float(s.mean())
        best = max(scores, key=scores.get)
        chosen.append({"test_product": df["product"].values[te][0], "chosen": best, "inner_scores": {k: round(v, 4) for k, v in scores.items()}})
        m = clone(cands[best]).fit(X[tr], y[tr])
        prob[te] = m.predict_proba(X[te])[:, 1]
        print(f"  outer fold {df['product'].values[te][0]:<22} chose {best:<14} inner={scores[best]:.3f}")
    return prob, chosen


def main() -> int:
    df, bands = load()
    X = df[bands].to_numpy(dtype=float)
    y = df["y"].to_numpy()
    raw_sha = hashlib.sha256(DATA.read_bytes()).hexdigest()
    print(f"Rows {len(df)}, jars {df['jar'].nunique()}, products {df['product'].nunique()}, pure rows {(y == 0).sum()}")
    cands = candidates()

    print("Nested Leave-One-Product-Out evaluation (strict: unseen honey products)...")
    prob_lopo, chosen = nested_lopo(df, X, y, cands)
    pred_lopo = (prob_lopo >= THRESHOLD).astype(int)
    jars_lopo = jar_level(df, prob_lopo)

    print("Selecting the final candidate by GroupKFold(product) on all data...")
    full_scores = {n: float(cross_val_score(clone(e), X, y, groups=df["product"], cv=GroupKFold(4), scoring="balanced_accuracy").mean())
                   for n, e in cands.items()}
    best = max(full_scores, key=full_scores.get)
    print(f"  final candidate: {best} {full_scores}")

    print("Secondary evaluation: GroupKFold by jar (product seen, jar unseen)...")
    prob_jar = np.zeros(len(y))
    for tr, te in GroupKFold(5).split(X, y, df["jar"]):
        prob_jar[te] = clone(cands[best]).fit(X[tr], y[tr]).predict_proba(X[te])[:, 1]
    jars_jar = jar_level(df, prob_jar)

    detection = {int(c): {"jars": int(len(g)), "flagged_as_adulterated": int(g["pred"].sum())}
                 for c, g in jars_lopo.groupby("conc")}

    jl_bal = balanced_accuracy_score(jars_lopo["y"], jars_lopo["pred"])
    n_pure_jars = int((jars_lopo["y"] == 0).sum())
    level = "LOW" if jl_bal < 0.75 else "MODERATE" if jl_bal < 0.9 else "HIGH"
    if n_pure_jars < 20:
        level = "LOW"  # too few pure jars to trust the estimate, whatever the score
    summary = {
        "headline": "Unseen honey products (nested leave-one-product-out), jar level",
        "jar_balanced_accuracy": round(jl_bal, 4),
        "jar_recall_adulterated": round(recall_score(jars_lopo["y"], jars_lopo["pred"]), 4),
        "jar_specificity_pure": round(((jars_lopo["y"] == 0) & (jars_lopo["pred"] == 0)).sum() / (jars_lopo["y"] == 0).sum(), 4),
        "pure_jars": int((jars_lopo["y"] == 0).sum()),
        "adulterated_jars": int((jars_lopo["y"] == 1).sum()),
        "seen_product_jar_balanced_accuracy": round(balanced_accuracy_score(jars_jar["y"], jars_jar["pred"]), 4),
        "note": "Independent HoneyChain evaluation. Not comparable to the >98% accuracy reported by Ahmed (2024), whose split was not product-grouped.",
    }

    # ---------------- final model (all data except the two demo jars)
    # one physical jar per demo level (first jar of that level for the product)
    demo_jars = []
    for brand, cls, conc in DEMO_JARS:
        sub = df[(df["Brand"] == brand) & (df["Class"] == cls) & (df["Concentration_Class"] == conc)]
        demo_jars.append(sorted(sub["jar"].unique())[0])
    demo_mask = df["jar"].isin(demo_jars).to_numpy()
    final = clone(cands[best]).fit(X[~demo_mask], y[~demo_mask])
    OUT.mkdir(parents=True, exist_ok=True)
    joblib.dump(final, OUT / "model.joblib")
    model_sha = hashlib.sha256((OUT / "model.joblib").read_bytes()).hexdigest()

    wavelengths = [float(b.replace("nm", "")) for b in bands]
    manifest = {
        "name": "honey-adulteration",
        "version": datetime.now(timezone.utc).strftime("%Y.%m.%d"),
        "task": "classification",
        "description": "Binary screening for sugar-syrup adulteration from hyperspectral reflectance of a honey jar.",
        "input_modality": "HYPERSPECTRAL_REFLECTANCE",
        "input_requirements": {
            "band_count": len(bands),
            "wavelengths_nm": wavelengths,
            "wavelength_tolerance_nm": 0.05,
            "per_observation": "one segmented, calibrated, pre-processed reflectance spectrum",
            "capture": "SOC-710 hyperspectral imager, 400-1000 nm, processed as in Phillips et al. (2021). Other cameras/pipelines are out of distribution.",
            "aggregation": "jar probability = mean of observation probabilities; threshold 0.5",
        },
        "labels": {"0": "NO_ADULTERATION_DETECTED", "1": "ADULTERATION_SUSPECTED"},
        "threshold": THRESHOLD,
        "estimator": best,
        "candidates_compared": {k: round(v, 4) for k, v in full_scores.items()},
        "dataset": {
            "id": "auckland-hsi-adulterated-honey-2021",
            "title": "Hyperspectral Imaging adulterated honey dataset",
            "creators": "Phillips, Coleman, Takano, Abdulla (University of Auckland)",
            "doi": "10.17608/k6.auckland.16441686.v1",
            "obtained_from": "https://github.com/Esmael-Ahmed12/Adulteration (adulteration.csv, data of Ahmed 2024, PLOS Digit Health 3(6):e0000536)",
            "licence": "CC BY 4.0",
            "sha256": raw_sha,
            "rows_used": int((~demo_mask).sum()),
            "held_out_demo_jars": demo_jars,
        },
        "reliability": {
            "level": level,
            "summary": f"On honey products it has never seen, jar-level balanced accuracy is {jl_bal:.2f} "
                       f"({summary['jar_specificity_pure']:.0%} of pure jars and {summary['jar_recall_adulterated']:.0%} of adulterated jars classified correctly). "
                       f"Estimated from only {n_pure_jars} pure jars, so the uncertainty is large. Treat output as a weak screening signal only.",
        },
        "limitations": [
            "Only valid for spectra captured and processed like the Auckland dataset (same camera, calibration and segmentation).",
            "Trained on 12 New Zealand honey products from 7 brands; only 7 products have pure (0 %) jars.",
            "Adulterant is sugar syrup at 5-50 %; other adulterants were not studied.",
            "Low concentrations (5-10 %) are the hardest to detect.",
            "Decision support only - the laboratory's own adulteration test result is authoritative.",
        ],
        "preprocessing_in_pipeline": "snv + first derivative" if best == "logreg_snv_d1" else ("snv" if best == "logreg_snv" else "none"),
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sklearn_version": __import__("sklearn").__version__,
        "model_sha256": model_sha,
    }
    metrics_out = {
        "summary": summary,
        "nested_leave_one_product_out": {
            "observation_level": metrics(y, pred_lopo, prob_lopo),
            "jar_level": metrics(jars_lopo["y"].to_numpy(), jars_lopo["pred"].to_numpy(), jars_lopo["prob"].to_numpy()),
            "jar_detection_by_concentration_pct": detection,
            "chosen_per_fold": chosen,
        },
        "jar_grouped_seen_products": {
            "jar_level": metrics(jars_jar["y"].to_numpy(), jars_jar["pred"].to_numpy(), jars_jar["prob"].to_numpy()),
        },
        "protocol": "Outer LeaveOneGroupOut(product); inner GroupKFold(4, product) model selection; jar = mean of observation probabilities.",
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (OUT / "metrics.json").write_text(json.dumps(metrics_out, indent=2), encoding="utf-8")
    (OUT / "STATUS.json").unlink(missing_ok=True)

    # ---------------- demo sample files (spectra only - no labels inside the file)
    SAMPLES.mkdir(exist_ok=True)
    for (brand, cls, conc), jar in zip(DEMO_JARS, demo_jars):
        sub = df[df["jar"] == jar]
        name = f"demo_scan_{brand}_{cls}_{conc}pct.csv".lower()
        sub[["Acquisition", *bands]].to_csv(SAMPLES / name, index=False)
        print(f"  wrote samples/{name} ({len(sub)} observations; true level {conc}% - held out of final model)")

    print(json.dumps(summary, indent=2))
    print(f"Saved model to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
