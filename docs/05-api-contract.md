# 05 — REST API Contract

Base URL: `http://localhost:4000/api/v1`. Bodies are JSON unless noted. Authentication uses the `hc_session` **httpOnly cookie** set by `/auth/login`.

## 0. Conventions

**Success envelope**
```json
{ "data": { ... }, "meta": { "page": 1, "pageSize": 20, "total": 57 } }
```
**Error envelope**
```json
{ "error": { "code": "HARVEST_OVER_ALLOCATED", "message": "batches would total 24.00 kg but harvest has only 20.00 kg",
             "details": [ { "path": "batches[1].quantityKg", "message": "..." } ] } }
```

| HTTP | When |
|---|---|
| 200 / 201 | OK / created |
| 400 | Malformed JSON |
| 401 `UNAUTHENTICATED` | No or expired session |
| 403 `FORBIDDEN` | Logged in, wrong role or not the owner |
| 404 `NOT_FOUND` | Record doesn't exist **or** exists but the caller may not see it (no information leak) |
| 409 | Business-rule / lifecycle violation (DB trigger codes, unique violations) |
| 422 `VALIDATION_ERROR` | Body/params fail zod validation |
| 429 | Rate limited |
| 502 / 503 | AI service or blockchain unreachable (never masked as success) |

Lists accept `?page=&pageSize=` (max 100) and filters noted per endpoint. Dates are `YYYY-MM-DD`; quantities are decimal strings (`"12.50"`) to avoid float rounding.

Roles: **A** = ADMIN, **B** = BEEKEEPER, **L** = LAB, **P** = PROCESSOR, **D** = DISTRIBUTOR, **PUB** = no login.

## 1. Health & meta

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health` | PUB | `{ postgres, mongodb, aiService, blockchain }`, each `up`/`down` with a detail message |
| GET | `/meta/enums` | any logged-in | hive types, processing methods, packaging types, statuses (for dropdowns) |

## 2. Authentication

| Method | Path | Role | Body → Result |
|---|---|---|---|
| POST | `/auth/register-beekeeper` | PUB | `{ email, password, fullName, phone?, publicDisplayName, showNamePublicly, cooperativeName?, village?, district, state, registrationNo? }` → 201 user + profile (one transaction) |
| POST | `/auth/login` | PUB | `{ email, password }` → 200 `{ user: { id, fullName, role, org } }` + sets cookie. Rate-limited: 10 / 15 min / IP |
| POST | `/auth/logout` | any | clears cookie |
| GET | `/auth/me` | any | current user, role, organization |
| POST | `/auth/change-password` | any | `{ currentPassword, newPassword }` |

Password rule: at least 8 characters, including a letter and a digit.

## 3. Administration (users, organizations, statistics)

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/admin/users` | A | filters `role, orgId, active, q` |
| POST | `/admin/users` | A | create ADMIN/LAB/PROCESSOR/DISTRIBUTOR user `{ email, fullName, role, orgId?, tempPassword }` |
| PATCH | `/admin/users/:userId` | A | `{ isActive?, fullName?, phone? }` (no self-deactivation) |
| GET | `/admin/organizations` | A | filter `type` |
| POST | `/admin/organizations` | A | `{ name, orgType, city, state, accreditationNo? }` |
| PATCH | `/admin/organizations/:orgId` | A | `{ isActive?, accreditationNo? }` |
| GET | `/admin/stats` | A | counts by status, totals (kg harvested/batched/processed, units shipped), labs pass/fail ratio, anchors by status, verification results, open anomalies. **All computed by SQL/Mongo aggregation, nothing hardcoded** |
| GET | `/admin/batches` | A | `v_batch_trace` with filters `status, beekeeperId, labId, from, to, demo` |
| GET | `/admin/beekeepers` · `/admin/hives` · `/admin/harvests` | A | system-wide read lists |
| GET | `/admin/lab-reports` · `/admin/processing` · `/admin/shipments` | A | system-wide read lists |
| GET | `/admin/activity-logs` | A | MongoDB, filters `userId, action, entityType, from, to` |
| GET | `/admin/outbox` | A | pending/dead MongoDB retries |
| GET | `/lab/reports/:reportCode/spectral-scans` | L, A | uploaded scans (MongoDB) |

## 4. Beekeeper: profile, hives, harvests, batches

Ownership rule: a beekeeper only ever sees or changes rows reachable from **their own** `beekeepers.user_id`. Anything else returns **404**.

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET / PATCH | `/beekeeper/profile` | B | editable: `publicDisplayName, showNamePublicly, cooperativeName, village, district, state, phone` |
| GET | `/hives` | B (own), A (all) | filter `status` |
| POST | `/hives` | B | `{ hiveType, beeSpecies, apiaryLocation, district, state, installedOn }` → 201 with `hiveCode` |
| PATCH | `/hives/:hiveCode` | B (own) | `{ status?, apiaryLocation? }` |
| GET | `/harvests` | B (own), A | filters `hiveCode, from, to` |
| POST | `/harvests` | B (own hive) | `{ hiveCode, harvestDate, quantityKg, floralSource, notes? }` → 201 with `harvestCode` |
| GET | `/harvests/:harvestCode` | B (own), A | includes batches and remaining unallocated kg |
| POST | `/harvests/:harvestCode/batches` | B (own) | `{ batches: [ { quantityKg, honeyType } , ... ] }` (1–20). **One transaction**: batches + QR records + BATCH_ORIGIN anchors → 201 list of `batchCode`s |
| GET | `/batches` | B (own), L (assigned), P/D (eligible), A (all) | role-scoped list; filter `status` |
| GET | `/batches/:batchCode` | scoped as above | full internal detail incl. status history |
| POST | `/batches/:batchCode/assign-lab` | B (own) | `{ labOrgId }`, only while CREATED |
| GET | `/labs` | B | active laboratories (for the assign dropdown) |

## 5. Laboratory

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/lab/queue` | L | batches assigned to **my lab** in CREATED/IN_TESTING |
| POST | `/lab/reports` | L | `{ batchCode, sampleCode, receivedOn, testedOn, moisturePct, hmfMgKg, sucroseG100g, glucoseG100g?, fructoseG100g?, brix?, ph?, freeAcidityMeqKg?, waterActivity?, electricalConductivityMsCm?, pollenIdentification, adulterationMethod?, adulterationResult }` → 201 DRAFT; batch → IN_TESTING |
| PATCH | `/lab/reports/:reportCode` | L (own lab, DRAFT only) | same fields, partial |
| POST | `/lab/reports/:reportCode/submit` | L (own lab) | `{ decision: "PASS"|"FAIL", decisionRemarks }` → batch LAB_PASSED/LAB_FAILED, anchor queued |
| GET | `/lab/reports` | L (own lab), A | testing history; filters `from, to, decision` |
| GET | `/lab/reports/:reportCode` | L (own lab), A, and B/P/D for their batch (read-only) | |
| POST | `/lab/reports/:reportCode/spectral-scans` | L | `multipart/form-data` CSV file (+ `instrument`, `preprocessing`) → stored in `spectral_scans` |
| POST | `/lab/reports/:reportCode/ai/quality` | L | runs standards screening + quality model (if trained) → stored, returned |
| POST | `/lab/reports/:reportCode/ai/adulteration` | L | `{ spectralScanId }` → adulteration model (if trained and input compatible) |
| GET | `/lab/reports/:reportCode/ai` | L, A | all analyses for the report |
| PATCH | `/ai/analyses/:analysisId/review` | L (own lab) | `{ note }` → `review.status = REVIEWED` |
| DELETE | `/ai/analyses/:analysisId` | A | delete a superseded analysis (logged) |
| GET | `/ai/models` | any logged-in | status of each model: `TRAINED` / `NOT_TRAINED`, required inputs, dataset, metrics summary |

AI calls can be made while the report is a DRAFT (workflow: enter values → see AI support → submit decision). The decision itself is never set by AI.

## 6. Processing

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/processing/queue` | P | batches in LAB_PASSED, with the submitted lab summary |
| POST | `/processing` | P | `{ batchCode, processingDate, method, methodDetails?, operatorName, operatorStaffId?, inputQuantityKg, outputQuantityKg, packagingDate, packagingType, unitSizeG, unitsPacked, bestBefore }` → batch PROCESSED, anchor queued |
| GET | `/processing` | P (own org), A | history |
| GET | `/processing/:processingCode` | P (own org), A | |

## 7. Distribution

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/distribution/queue` | D | batches PROCESSED or IN_DISTRIBUTION with units remaining |
| POST | `/shipments` | D | `{ batchCode, dispatchDate, originLocation, destinationName, destinationType, destinationCity, destinationState, carrierName?, trackingReference?, unitsShipped }` |
| PATCH | `/shipments/:shipmentCode/status` | D (own org) | `{ status: "IN_TRANSIT"|"DELIVERED"|"CANCELLED", deliveredOn? }`. DELIVERED queues a SHIPMENT anchor; may complete the batch |
| GET | `/shipments` | D (own org), A | history; filter `status` |

## 8. QR codes

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/qr/:batchCode.png` | B (own), A, staff with access | PNG of the stored `public_url`; `?size=` 128–1024 |
| GET | `/qr/:batchCode.svg` | same | print-quality SVG |

QR records are created automatically with each batch. The image only encodes the public URL `PUBLIC_BASE_URL/verify/<batchCode>`, never personal data.

## 9. Blockchain

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/blockchain/status` | A | network, chainId, contract address, signer balance, latest block, connected? |
| GET | `/admin/anchors` | A | `v_anchor_status`; filters `batchCode, status, entityType` |
| POST | `/admin/anchors` | A | manual anchor `{ entityType, entityCode }` |
| POST | `/admin/anchors/:anchorId/retry` | A | for FAILED, or anchors of a wiped local chain (creates a new attempt) |
| POST | `/admin/anchors/:anchorId/verify` | A | recompute → compare with chain → stores and returns a `verification_checks` row |
| POST | `/admin/batches/:batchCode/verify` | A | verify every anchor of a batch |
| GET | `/admin/verifications` | A | verification history; filter `result` |
| GET | `/admin/anchors/:anchorId` | A | anchor row + its last 20 checks |
| POST | `/admin/anchors/anchor-missing` | A | anchor every eligible record with no live anchor on the current contract (refuses records whose data differs from an earlier anchored hash) |
| POST | `/admin/anchors/process` | A | run the anchor worker once now |

## 10. Supply-chain anomalies

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/admin/anomalies/scan` | A | `{ batchCode? }` (omit = whole system). Runs all rules, then Isolation Forest if the genuine-record minimum is met |
| GET | `/admin/anomalies` | A | filters `status, severity, ruleId, batchCode` |
| PATCH | `/admin/anomalies/:id` | A | `{ status, note }` |
| DELETE | `/admin/anomalies/:id` | A | only DISMISSED or RESOLVED reports |

## 11. Public (consumer)

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/public/batches/:batchCode` | PUB | rate-limited 60/min/IP. Returns `v_public_batch` + `v_public_shipments` + per-record integrity status + latest AI summary (status + disclaimer) + `isDemo`. Unknown code → 404. Re-verifies on-chain if the last check is older than `PUBLIC_REVERIFY_MINUTES` |

Response sketch:
```json
{ "data": {
  "batchCode": "HC-2026-000123", "isDemo": true, "status": "DELIVERED",
  "origin":     { "producerName": "Registered beekeeper", "cooperative": "…", "district": "…", "state": "…" },
  "harvest":    { "harvestCode": "…", "date": "…", "floralSource": "…" },
  "laboratory": { "labName": "…", "testedOn": "…", "moisturePct": "17.80", "hmfMgKg": "9.60", "sucroseG100g": "3.10",
                  "pollenIdentification": "…", "adulterationResult": "NOT_DETECTED", "decision": "PASS" },
  "processing": { "processorName": "…", "date": "…", "method": "FILTRATION", "packagingType": "GLASS_JAR", "unitSizeG": 500, "bestBefore": "…" },
  "journey":    [ { "dispatchDate": "…", "destinationType": "RETAILER", "destinationCity": "…", "status": "DELIVERED", "deliveredOn": "…" } ],
  "integrity":  [ { "record": "LAB_REPORT", "anchorStatus": "CONFIRMED", "result": "VERIFIED", "checkedAt": "…",
                    "network": "hardhat", "txHash": "0x…", "blockNumber": 42 } ],
  "ai":         { "quality": { "modelStatus": "NOT_TRAINED", "disclaimer": "…" }, "adulteration": { "modelStatus": "NOT_TRAINED" } },
  "notices":    [ "Blockchain verification shows whether these records changed after anchoring. It does not prove the honey is genuine." ]
} }
```

| GET | `/public/demo-batches` | PUB | batches flagged `is_demo` for the public home page |

The **React** route `/verify/:batchCode` renders this. The `/verify/<code>` URL pattern from the old prototype is kept.

## 12. Internal AI service (FastAPI, `127.0.0.1:8000`, header `X-Service-Key`)

Called only by Express, never by the browser.

| Method | Path | Body → Result |
|---|---|---|
| GET | `/health` | `{ status: "ok" }` |
| GET | `/models` | `[ { name, status: "TRAINED"|"NOT_TRAINED", task, version, dataset, inputManifest, metrics, limitations } ]` |
| POST | `/v1/quality/predict` | `{ features: { ... } }` → `{ status, prediction|null, reason }`. 422 if features don't match the manifest |
| POST | `/v1/adulteration/predict` | `{ bandCount, preprocessing, acquisitions: [[...]] }` → `{ status, prediction|null, perAcquisition, reason }` |
| POST | `/v1/anomaly/score` | `{ minimumRequired, records: [ {batchId, features…} ] }` → `{ status: "SCORED"|"INSUFFICIENT_DATA", scores: [...] }` |

When a model is not trained, the service answers **HTTP 200** with `status: "NOT_TRAINED"` and `prediction: null`. That's a normal, expected state, not an error, and the UI shows it as a badge.
