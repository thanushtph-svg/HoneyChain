# Testing

## 1. Test inventory and latest results

| Suite | Command (from project root) | Tests | Result | What it proves |
|---|---|---|---|---|
| PostgreSQL schema | `psql -U postgres -d honeychain_test -v ON_ERROR_STOP=1 -o NUL -f backenddb	estsschema_tests.sql` | 78 checks | ✅ 78/78 | Six roles, constraints, triggers, **custody transfers (accept/reject with reason)**, testing requests, the 12-stage lifecycle, quantity rules, immutability, correction-only lab changes, admin-only review, settings / role-change audit, privacy of public views (rolls back) |
| Concurrency (manual) | see §3 | 1 | ✅ | Row lock stops two sessions over-allocating one harvest |
| Smart contract | `cd blockchain; npx hardhat test` | 8 | ✅ 8/8 | Anchoring, append-only history, access control, documented test vector |
| AI service | `cd ai-service; python -m pytest -q` | 11 | ✅ 11/11 | Service key, model gating (untrained → no prediction, tampered/mismatched model refused), adulteration I/O validation, Isolation Forest minimum data |
| Backend unit | `cd backend; npm run test:unit` | 5 | ✅ 5/5 | Canonical JSON + SHA-256 reproduce the documented test vector |
| Backend end-to-end | `cd backend; npm test` | 36 (incl. unit) | ✅ 36/36 | Login + home path for all six roles, **403 RBAC matrix for every role** (incl. admin cannot write business records, consumer cannot read internal APIs), ACCESS_DENIED audit, row-level isolation across organizations, private-field stripping, **full beekeeper → processor → lab → distributor → consumer workflow with rejections**, INCONCLUSIVE re-test, DB-level defences, lab documents, **audited corrections**, user/role/settings management, QR, public privacy + honest verdict, on-chain verify + tamper → MISMATCH, AI gating, anomaly rules, live statistics |
| Frontend views & pages | `cd frontend; npm run test:ui` | 96 | ✅ 96/96 | For each of the six roles: correct dashboard, sidebar shows **exactly** that role's navigation, every navigation page renders with live data without errors; every role is refused (403 page, no foreign navigation) in all five other views; anonymous users are sent to login; detail and public pages render |
| Frontend UI workflow | (same command) | 12 | ✅ 12/12 | Through the real React forms of each view: hive → harvest → split → transfer → processor rejects one (reason) / accepts one → processing with loss → testing request → lab accept → results → PASS → transfer → distributor accept → dispatch → delivered → public page journey (no private data) → beekeeper sees the rejection reason |
| QR decoding (manual) | §4 | 3 | ✅ | Decoded QR images point to `/verify/<their own batch>`, which shows different batch data |

Latest run (2026-11-22, Windows): **PostgreSQL 18, MongoDB 9 (frontend suites and seed against the real server; backend suite with the in-memory double), a live Hardhat node with the deployed contract, and the live AI service** - nothing skipped. The frontend suites ran against a second backend on port 4100 with separate `honeychain_ui` databases (`API_BASE=http://localhost:4100`), so the main database was not touched. `node tests/seed-smoke.mjs` (backend) resets and seeds only the test database.

## 2. Where the tests ran, and an honest limitation

The project was built and tested on a Linux build machine. A MongoDB **server** could not be installed there (binary downloads were blocked), so the automated tests used `MONGODB_URI=memory://`, a small in-memory **test double** of the MongoDB driver (`backend/src/db/memoryMongo.js`). It is never used for real deployments, and `/api/v1/health` reports it.

**On Windows with real MongoDB Community, please run once** to confirm validators and indexes against the real server:

```powershell
cd backend
npm run db:mongo-init
$env:TEST_MONGODB_URI = "mongodb://127.0.0.1:27017"
npm test
Remove-Item Env:TEST_MONGODB_URI
```

and in `mongosh`:

```javascript
use honeychain
db.getCollectionInfos({ name: "ai_analysis_results" })[0].options.validator   // $jsonSchema present
db.activity_logs.getIndexes()                                                  // includes public_scan_ttl
db.ai_analysis_results.insertOne({ analysisType: "WRONG" })                     // must FAIL validation
```

The UI was verified by rendering the real React pages in jsdom against the live backend, not by clicking through a desktop browser. Please also click through the five-minute demo in the README on your machine.

## 3. Concurrency test (two psql windows)

Window A:
```sql
BEGIN;
INSERT INTO batches (harvest_id, quantity_kg, honey_type, created_by)
SELECT harvest_id, quantity_kg * 0.6, 'race A', 1 FROM harvests WHERE harvest_code = 'HRV-2026-000003';
-- do not commit yet
```
Window B (blocks, waiting for A's lock):
```sql
INSERT INTO batches (harvest_id, quantity_kg, honey_type, created_by)
SELECT harvest_id, quantity_kg * 0.6, 'race B', 1 FROM harvests WHERE harvest_code = 'HRV-2026-000003';
```
Window A: `COMMIT;`. Window B then fails with `HARVEST_OVER_ALLOCATED`. In window A, run `DELETE FROM batches WHERE honey_type='race A';` to clean up (allowed while the batch is CREATED and has no anchor; otherwise reset the demo).

## 4. Manual QR check

1. Log in as a beekeeper, open a batch, and click *Download PNG*.
2. Scan it with a phone (README §9 for LAN setup). It opens `/verify/<that batch>`.
3. Repeat with a second batch: the page shows different origin, harvest and status.

## 5. Manual acceptance checklist (project description §14)

| Criterion | How to check | Automated? |
|---|---|---|
| Users only access permitted functions | Log in as each role; try `/app/admin/users` as a beekeeper (blocked in the UI **and** the API returns 403) | ✅ tests 10, 11 |
| Beekeeper: hive → harvest → linked batches | README demo step 2 | ✅ tests 12, UI |
| Lab report linked to the correct batch | Lab queue → enter results | ✅ |
| Processor/distributor records with validation | Try shipping more units than packed (rejected) | ✅ |
| Admin inspects records and flagged inconsistencies | Admin → Records / Anomalies | ✅ |
| QR shows the correct batch | §4 | ✅ decoded |
| Anchor + later verification | Admin → Blockchain → Verify; tamper demo | ✅ test 15 |
| AI returns real output or honest status | Lab report → Run quality (NOT_TRAINED) / adulteration (TRAINED) | ✅ tests 17, 18 |
| PostgreSQL and MongoDB both used by features | Stats/records (PG); AI, anomalies, logs (Mongo) | ✅ |
| Starts from documented instructions + seed | README §1–6 | manual |
