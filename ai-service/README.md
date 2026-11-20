# HoneyChain AI service

Internal FastAPI service, called only by the Express backend with the `X-Service-Key` header. It binds to 127.0.0.1.

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --host 127.0.0.1 --port 8000
python -m pytest -q          # 11 tests
```

## Model status

| Model | Status | Input | Why |
|---|---|---|---|
| `honey-adulteration` | **TRAINED** (reliability **LOW**) | 128-band hyperspectral reflectance per observation | Real public labelled data with jar/product identifiers: Phillips et al. 2021, CC BY 4.0 |
| `honey-quality` | **NOT TRAINED** | lab measurements | The candidate source (Aykas 2023) publishes only summary statistics and no quality labels; see `models/honey-quality/STATUS.json` |
| Isolation Forest (anomalies) | runs on demand | HoneyChain's own batch records | Returns `INSUFFICIENT_DATA` below `ANOMALY_MIN_RECORDS` (default 50 genuine batches) |

Rule-based standards screening (FSSAI / Codex limits) lives in the **backend**, is labelled `RULE_BASED`, and is not AI.

## Adulteration model: honest evaluation

Protocol: nested **leave-one-product-out**. The model is always tested on a honey product it never saw, and model selection happens only inside the training folds. Jar prediction = mean of its observation probabilities, threshold 0.5.

| Metric (jar level, unseen products) | Value |
|---|---|
| Balanced accuracy | **0.81** |
| Recall, adulterated jars | 0.90 (45/50) |
| Specificity, pure jars | 0.71 (5/7) |
| ROC AUC | 0.88 |
| Detection by level | 5 %: 11/14 · 10 %: 10/11 · 25 %: 12/12 · 50 %: 12/13 |
| Selected estimator | SNV + first derivative → standardise → logistic regression (beat SNV-logistic and Random Forest in inner CV) |

Reliability is set to **LOW** because only **7 pure jars** exist, which makes the specificity estimate very uncertain. The >98 % accuracy reported by Ahmed (2024) comes from a split that was not product-grouped and is **not** HoneyChain's result. On the two held-out demo jars, the model flags the 25 % jar correctly (p = 0.98) and **wrongly** flags the pure jar (p = 0.59), consistent with the measured specificity. The UI shows this as-is.

Full numbers: `models/honey-adulteration/metrics.json`. Dataset: `models/honey-adulteration/DATASET_CARD.md`.

## Retraining (reproducible)

```powershell
python training/download_data.py          # fetches adulteration.csv (13.3 MB) from GitHub
python training/train_adulteration.py     # ~2 min; rewrites model.joblib, manifest.json, metrics.json, demo samples
```

The registry refuses a model whose file hash doesn't match its manifest, or that was trained with a different scikit-learn version.

## Enabling the quality model

Provide a real, licensed, labelled per-sample dataset (see `data/README.md`), then:

```powershell
python training/train_quality.py --data data\raw\quality.csv --label <column> --group <column> --card <DATASET_CARD.md> --licence "<licence>" --source "<url>"
```

The script refuses to run with fewer than 60 rows, fewer than 3 feature columns, or classes with fewer than 10 samples.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + model statuses (no key needed) |
| GET | `/models` | status, inputs, dataset, metrics, reliability, limitations |
| POST | `/v1/quality/predict` | `{features:{moisture_pct,...}}` → `NOT_TRAINED` today |
| POST | `/v1/adulteration/predict` | `{wavelengthsNm:[128], observations:[[128],...]}` → label + probability; 422 on wrong bands/shape |
| POST | `/v1/anomaly/score` | `{minimumRequired, records:[{id, features}]}` → `SCORED` or `INSUFFICIENT_DATA` |
| POST | `/admin/reload` | reload models after retraining |
