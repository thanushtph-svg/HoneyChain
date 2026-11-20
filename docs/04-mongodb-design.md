# 04 — MongoDB Design

Database: `honeychain`. Exact validators and indexes: `backend/db/mongo/collections.json` (applied by the init script in Phase 3).

## 1. Why MongoDB at all (and why only for these)

PostgreSQL holds every record the supply chain depends on. MongoDB holds data that is **supplementary, variable in shape, or high-volume**:

| Collection | Why a document store fits | Why not PostgreSQL |
|---|---|---|
| `ai_analysis_results` | Output shape differs per model, version and status (class probabilities vs. regression value vs. "not trained") | Would need many nullable columns or a JSON column anyway |
| `spectral_scans` | One scan = several acquisitions × 128+ floats | SQL would need a 128-column table or 768 rows per scan |
| `anomaly_reports` | Variable list of rule findings with rule-specific evidence + one ML block | Would need 2–3 child tables for one read-mostly report |
| `activity_logs` | High-volume, append-mostly, varied `details`; old public-scan logs can auto-expire (TTL) | Would bloat the transactional DB |

Nothing here is authoritative. If MongoDB were wiped, the supply chain, QR pages and blockchain verification would still work; only AI history, anomaly history and logs would be lost.

## 2. Linking documents to relational rows

Every document stores stable PostgreSQL identifiers:

```
ai_analysis_results.batchId     ──▶ batches.batch_id
ai_analysis_results.batchCode   ──▶ batches.batch_code   (human-readable, used in UI)
ai_analysis_results.labReportId ──▶ lab_reports.lab_report_id
ai_analysis_results.requestedBy ──▶ users.user_id
spectral_scans.labReportId      ──▶ lab_reports.lab_report_id
anomaly_reports.batchId         ──▶ batches.batch_id
activity_logs.actor.userId      ──▶ users.user_id
```

There are no cross-database foreign keys, so the **backend checks the referenced row exists in PostgreSQL before writing** the document.

## 3. Collections

### 3.1 `ai_analysis_results`

```json
{
  "_id": "ObjectId",
  "analysisType": "QUALITY",
  "batchId": 123, "batchCode": "HC-2026-000123", "labReportId": 45,
  "spectralScanId": null,
  "inputSnapshot": { "moisture_pct": 17.8, "hmf_mg_kg": 9.6, "sucrose_g_100g": 3.1 },
  "standardsScreening": {
    "kind": "RULE_BASED",
    "standard": "Codex Stan 12-1981 (configurable)",
    "checks": [
      { "parameter": "moisture_pct", "value": 17.8, "limit": "<= 20", "unit": "%", "outcome": "WITHIN_LIMIT" }
    ]
  },
  "model": { "name": "honey-quality", "version": null, "status": "NOT_TRAINED",
             "statusReason": "Validated labelled dataset required", "datasetId": null, "task": null },
  "prediction": null,
  "warnings": [],
  "disclaimer": "Decision support only. The laboratory's decision is authoritative. Not a certification.",
  "requestedBy": 7, "createdAt": "ISODate",
  "review": { "status": "UNREVIEWED", "reviewedBy": null, "reviewedAt": null, "note": null },
  "isDemo": false
}
```

The validator allows `prediction` only as an object **or null**, and the API writes it only when `model.status == "TRAINED"`. Rule-based screening and ML output sit in different fields, so the UI can't mix them up.

### 3.2 `spectral_scans`

Created when a lab uploads a hyperspectral feature file for the adulteration model. `bandCount` and `preprocessing` must match the trained model's manifest; otherwise the analysis is stored with `model.status = "INPUT_INCOMPATIBLE"` and no prediction. `sourceFile.sha256` is unique, which stops the same file being uploaded twice.

### 3.3 `anomaly_reports`

```json
{
  "runId": "2026-11-21T10:00:00Z-ab12", "scope": "BATCH", "batchId": 123, "batchCode": "HC-2026-000123",
  "ruleFindings": [
    { "kind": "RULE_BASED", "ruleId": "R07_LIMIT_VS_DECISION", "severity": "WARNING",
      "message": "HMF 52.0 mg/kg exceeds the configured 40 mg/kg limit but the lab decision is PASS",
      "evidence": { "hmf_mg_kg": 52.0, "limit": 40, "decision": "PASS" } }
  ],
  "mlFindings": { "kind": "ML_ISOLATION_FOREST", "status": "INSUFFICIENT_DATA",
                  "recordCount": 14, "minimumRequired": 50, "anomalyScore": null, "isOutlier": null },
  "status": "OPEN", "resolution": null,
  "createdAt": "ISODate", "updatedAt": "ISODate", "containsDemoData": true
}
```

### 3.4 `activity_logs`

```json
{ "at": "ISODate", "actor": { "userId": 7, "role": "LAB" }, "action": "LAB_REPORT_SUBMITTED",
  "entity": { "type": "lab_report", "id": 45, "code": "LAB-2026-000045" },
  "outcome": "SUCCESS", "ip": "127.0.0.1", "details": { "decision": "PASS" } }
```

A **TTL index with a partial filter** deletes only `PUBLIC_QR_SCAN` entries after 90 days. Audit entries for real actions are kept.

## 4. CRUD demonstrated by real features

| Operation | Feature that performs it |
|---|---|
| **Create** | `insertOne` on every AI analysis, scan upload, anomaly scan, logged action |
| **Read** | Lab AI panel (latest analysis per report), admin anomaly list with filters, activity-log viewer with pagination, public page AI summary |
| **Update** | Lab marks an AI analysis **REVIEWED** (`updateOne $set review`); admin moves an anomaly OPEN → ACKNOWLEDGED → RESOLVED/DISMISSED with a note |
| **Delete** | Admin deletes a superseded AI analysis or a dismissed anomaly report (`deleteOne`, itself logged); TTL auto-delete of old scan logs |
| **Aggregate** | Admin dashboard: anomaly counts by severity/rule (`$unwind` + `$group`), actions per day (`$group` on `$dateTrunc`) |

## 5. Failure handling

See doc 01 §3. In short: a MongoDB write that fails after a PostgreSQL commit goes into `mongo_outbox`. A worker retries it with exponential backoff and marks it `DEAD` after 8 attempts; dead rows are listed on the admin dashboard. A user is never told something was saved when it wasn't.

## 6. Testing note

The development workspace used to build this project can't install the MongoDB server binary, so automated tests there run against **FerretDB** (MongoDB wire-compatible). Its support for `$jsonSchema` validators and partial TTL indexes is limited, so those two features will be verified on **MongoDB Community Edition on Windows** with the steps given in Phase 3.
