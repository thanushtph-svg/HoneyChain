# 07 — AI Service & Supply-Chain Validation Design

## 1. Three separate capabilities, never mixed

| Capability | Type | Input | Model trained? (today) |
|---|---|---|---|
| **A. Honey quality assessment** | ML, conditional | Lab measurement fields (only those in the model's manifest) | **No.** Blocked: Aykas 2023 has no per-sample data and no labels (see §3, `models/honey-quality/STATUS.json`) |
| **B. Honey adulteration detection** | ML | Hyperspectral feature vectors (uploaded scan), **never** lab fields | **Yes.** Auckland HSI data; jar-level balanced accuracy 0.81 on unseen products; reliability LOW (see §4) |
| **C. Supply-chain validation** | Rules (always) + Isolation Forest (only above a minimum of genuine records) | PostgreSQL lifecycle records | Rules: always on. IF: insufficient data until the threshold is met |

There is also **standards-based screening** (moisture/HMF/sucrose against configured limits). It's a rule, not AI, and is labelled `RULE_BASED` everywhere.

## 2. Model gating: how "not trained" is guaranteed

Each model lives in `ai-service/models/<model-name>/`. The service treats a model as `TRAINED` **only if all of these exist and are consistent**:

```
models/honey-quality/
  model.joblib          ← fitted sklearn Pipeline (preprocessing + estimator)
  manifest.json         ← task, feature names/order/units, label definitions, preprocessing,
                          dataset id + licence + sha256 of the training file
  metrics.json          ← evaluation on a held-out test set produced by training/evaluate.py
  DATASET_CARD.md       ← source, licence, sample count, columns, missing values, class balance, grouping ids
```

If any file is missing, the SHA-256 in the manifest doesn't match the recorded dataset, or `metrics.json` is absent, `/models` reports `NOT_TRAINED` with the reason, and predict endpoints return `prediction: null`.

There is **no code path that fills in a default, random or rule-derived "prediction"**. Phase 9 will include a unit test that asserts this.

UI wording when untrained: **"Not trained — validated labelled dataset required."**

## 3. Capability A — quality assessment (candidate: Aykas 2023)

> **Phase 9 outcome:** the article's data-availability statement says the data are "contained within the article", but it contains only summary statistics (min/max/mean/SD) and calibration statistics: no per-sample values, no supplementary files, no quality labels. Outcome 1 below applies, so the model stays **NOT_TRAINED**. `training/train_quality.py` is ready for a real dataset.

Facts from the published paper:
- *Determination of Possible Adulteration and Quality Assessment in Commercial Honey*, D. P. Aykas, **Foods 2023, 12(3):523**, open access (MDPI).
- 147 commercial honey samples (Turkey and USA). Reference values were measured for °Brix, pH, free acidity, moisture, water activity, glucose, fructose, sucrose and HMF. Some samples exceeded regulatory limits (HMF n = 11, sucrose n = 21).
- The paper's models predict these traits from **portable FT-IR spectra** and use SIMCA to flag possible adulteration.

Questions Phase 9 must answer before any training:

| Question | Why it matters |
|---|---|
| Are per-sample values (and spectra) actually downloadable (supplementary files / data repository), or "available on request"? | No data → no model |
| What is the licence of the data itself (separate from the article's CC BY)? | Must be reusable |
| Are there any **class labels** (e.g. quality grade)? | If not, a classification task must **not** be invented |
| Which columns would HoneyChain's lab form actually have at prediction time? | The model may only use inputs our users can supply |

Likely outcomes (decided only after inspection):
1. **No downloadable per-sample data** → model stays NOT_TRAINED; documented blocker.
2. **Reference values only, no FT-IR spectra** → a defensible *regression* task, e.g. predicting a costly-to-measure trait from cheaper ones, evaluated with cross-validated MAE/R². Only if the relationships are meaningful and n=147 supports it.
3. **Labels derived from regulatory limits** (e.g. "exceeds HMF limit") would just re-learn the threshold rule. They will **not** be presented as an ML quality classifier; the standards screening already covers them honestly.

Random Forest is evaluated as a baseline **only if** a real classification task exists.

## 4. Capability B — adulteration detection (candidate: Ahmed 2024)

> **Phase 9 outcome:** the file `adulteration.csv` from Ahmed's public repository (derived from the Auckland dataset, CC BY 4.0) was inspected: 8,675 rows, 128 bands 399.40–1063.79 nm, 0 missing values, 58 mixtures (57 honey jars + 1 pure syrup), 12 products, 7 pure jars. The dataset's `Adultration` column is inconsistent ("Yes" only at 50 %), so the label is derived from `Concentration_Class > 0`. The model was trained and evaluated with nested leave-one-product-out: jar balanced accuracy **0.81**, recall 0.90, specificity 0.71, AUC 0.88. Reliability is **LOW** (only 7 pure jars). Details: `ai-service/README.md`.

Facts from the paper and dataset:
- *Detection of honey adulteration using machine learning*, E. Ahmed, **PLOS Digital Health 2024, 3(6):e0000536**. Uses segmented, pre-processed hyperspectral images of adulterated honey (7 brands, 12 botanical origins) and reports >98% accuracy. **That figure is the paper's result, not ours, and will never be shown as HoneyChain's accuracy.**
- A likely underlying source is the University of Auckland figshare *Hyperspectral Imaging adulterated honey dataset*: features with 128 spectral bands and six acquisitions per adulterated sample.
- The same group also published a **generated (VAE-synthetic)** adulteration dataset. It is **not real ground truth and will not be used for training or evaluation.**

Hard requirements:

| Requirement | Implementation |
|---|---|
| Separate model | `models/honey-adulteration/` with its own manifest/metrics |
| Correct input modality | Input = uploaded `spectral_scans` doc whose `bandCount` and `preprocessing` match the manifest. Lab fields (moisture, sucrose …) are rejected with 422 |
| No leakage | `GroupShuffleSplit` / `GroupKFold` on the **original jar/sample id**, so all acquisitions of one jar land in the same split. If the files contain no usable sample id, the model is **not trained** (blocker documented) |
| Independent evaluation | Our own held-out test: precision, recall, F1 per class, confusion matrix, plus regression metrics if adulteration % is modelled as a number |
| Honest scope | Valid only for spectra captured and pre-processed like the dataset (same camera setup). A HoneyChain lab without that equipment sees **"Input modality unavailable"** |

## 5. Capability C — supply-chain validation

### 5.1 Deterministic rules (labelled `RULE_BASED`, never "AI")

| Rule id | Check | Severity |
|---|---|---|
| R01_HARVEST_ALLOCATION | Σ batch kg > harvest kg (DB blocks this; scan catches out-of-band edits) | CRITICAL |
| R02_PROCESS_INPUT | processing input > batch kg | CRITICAL |
| R03_PACKED_MASS | units × unit size > processed output | CRITICAL |
| R04_SHIPPED_UNITS | units shipped (non-cancelled) > units packed | CRITICAL |
| R05_DATE_ORDER | harvest ≤ received ≤ tested ≤ processed ≤ packaged ≤ dispatched ≤ delivered violated | CRITICAL |
| R06_STAGE_WITHOUT_PASS | processing/shipment exists without a SUBMITTED PASS report | CRITICAL |
| R07_LIMIT_VS_DECISION | measurement exceeds configured standard limit but decision is PASS | WARNING |
| R08_PROCESS_LOSS | (input − output)/input > configured % (default 10%) | WARNING |
| R09_STATUS_DRIFT | batch status inconsistent with stage records (e.g. all shipments delivered but status not DELIVERED) | WARNING |
| R10_INTEGRITY | latest verification of any anchor = MISMATCH | CRITICAL |
| R11_DUPLICATE_LAB_VALUES | identical full measurement vector on reports from **different harvests** (suspicious repeated pattern) | WARNING |
| R12_HARVEST_OUTLIER_RULE | single-hive harvest above configured kg (default 60) | INFO |

### 5.2 Isolation Forest (labelled `ML_ISOLATION_FOREST`)

| Item | Design |
|---|---|
| Unit | one batch with a submitted lab report and a processing record |
| Features | process yield (output/input), batch share of harvest, days harvest→test, test→processing, processing→first dispatch, moisture, HMF, sucrose |
| Minimum data | `ANOMALY_MIN_RECORDS` = **50 genuine (non-demo) qualifying batches** (configurable). Below that: `INSUFFICIENT_DATA`, no score |
| Why 50 | With 8 features, fewer points make "outlier" scores mostly noise. 50 is a conservative floor for a small demo system, not a statistical guarantee; documented as a limitation |
| Demo records | **Excluded by default.** `ANOMALY_INCLUDE_DEMO=true` lets them in for a classroom demonstration, and every result is then stamped `containsDemoData: true` and shown with a "computed on demo data" banner |
| Training | fitted fresh on each scan over the current qualifying records (`n_estimators=200`, `contamination="auto"`, fixed `random_state`); stateless |
| Output | anomaly score + outlier flag per batch, stored in `anomaly_reports.mlFindings` |

## 6. Standards screening limits (rule-based, configurable)

Stored in `backend/config/standards.json`. Initial values follow **Codex Stan 12-1981** (general honey): moisture ≤ 20 g/100 g; HMF ≤ 40 mg/kg (≤ 80 for declared tropical origin); sucrose ≤ 5 g/100 g; fructose + glucose ≥ 60 g/100 g. FSSAI (India, default profile): moisture ≤ 20 %, sucrose ≤ 5 g/100 g, HMF ≤ 80 mg/kg (FSSAI advisory of 7 Nov 2025 confirms 80 mg/kg). Checked against published sources in Phase 9; the source is shown next to each check. Switch with `STANDARDS_PROFILE=CODEX`.

## 7. Disclaimers (shown wherever AI output appears)

- Lab view: *"AI output is decision support only. The laboratory's measured results and decision are authoritative."*
- Public page: *"Automated analysis is informational and does not certify this honey."* If untrained: *"No AI model is currently trained for this check."*
