# 10 · The six role-based views, workflow and RBAC

HoneyChain has **exactly six roles**. Each has its own URL prefix, its own sidebar, its own dashboard and its
own API permissions. The roles share one data model in PostgreSQL. They are separate views, not separate
databases.

| # | Role code | View | Home | Belongs to an organization |
|---|---|---|---|---|
| 1 | `BEEKEEPER` | Beekeeper dashboard | `/beekeeper` | no (has a producer profile) |
| 2 | `PROCESSOR` | Processor dashboard | `/processor` | yes, type `PROCESSOR` |
| 3 | `LAB_TESTER` | Lab Tester dashboard | `/lab` | yes, type `LABORATORY` |
| 4 | `DISTRIBUTOR` | Distributor dashboard | `/distributor` | yes, type `DISTRIBUTOR` |
| 5 | `ADMIN` | Admin dashboard | `/admin` | no |
| 6 | `CONSUMER` | Consumer / public verification | `/verify` (no account), `/consumer` (optional account) | no |

## 1. Workflow

```
CREATED ─transfer─► PENDING_PROCESSOR ─accept─► IN_PROCESSING ─processing record─► PROCESSED
   ▲                       │reject/cancel (reason)                                      │ testing request
   └───────────────────────┘                                                            ▼
                                     PENDING_LAB ◄─────────── re-test ─────────── LAB_INCONCLUSIVE
                                      │accept   │reject/cancel (reason) → back                ▲
                                      ▼                                                    │
                                  IN_TESTING ──submit──► LAB_PASSED / LAB_FAILED (terminal) / LAB_INCONCLUSIVE
                                                           │ transfer (all packed units)
                                                           ▼
                                   PENDING_DISTRIBUTOR ─accept─► IN_DISTRIBUTION ─all units delivered─► DELIVERED
                                      │reject/cancel (reason) → LAB_PASSED
```

* Every hand-over is a row in `batch_transfers`. Custody moves only when the receiver **accepts**.
  A **rejection** requires a reason and returns the batch to the sender. Both outcomes keep the
  responsible user and a timestamp.
* The processor holds the batch while the laboratory tests a sample. A testing request is a row in
  `lab_test_requests`, which the lab **accepts** or **rejects** with a reason.
* All stages share the batch code `HC-YYYY-NNNNNN`.
* Quantities: the sum of batches never exceeds the harvest. A transfer to a processor carries the whole
  batch quantity. Processing input never exceeds the batch, and loss = input − output. A transfer to a
  distributor carries all packed units. Shipped units never exceed packed units. All of this is enforced
  by triggers.
* The legal status changes are listed in `batch_status_transitions` and checked by a trigger. Every change
  is written to `batch_status_history` with the acting user.

## 2. Views, navigation and features

### Beekeeper (`/beekeeper`)
Dashboard · My Hives · Harvests · My Batches · QR Codes · Profile
* Register and manage hives; record harvests; split a harvest into several batches. Each batch gets a QR
  code automatically.
* Batch page: send the batch to a processor (or cancel while it is pending), then follow its status,
  custody transfers, processing, laboratory results, shipments and blockchain anchors.
* The dashboard warns about batches a processor rejected and shows the reason.
* **Cannot:** enter or approve lab results, edit processing/distribution records, or open admin pages
  (UI 403 + API 403).

### Processor (`/processor`)
Dashboard · Incoming Batches · Processing · Processed Batches · Transfers · History · Profile
* Incoming: accept a batch, or reject it with a reason. Before deciding, the processor sees its origin and
  previous records.
* Processing: date, type, details, operator, input/output quantity (the loss and loss % are shown live),
  packaging. Saving sets the batch to PROCESSED and anchors the record.
* Processed Batches: send a testing request to a laboratory, or a re-test after INCONCLUSIVE, and follow
  the lab status.
* Transfers: hand LAB_PASSED batches to a distributor; outgoing transfer history.
* **Cannot:** edit harvests, edit lab results, act on batches held by another processor (404), or open
  admin pages.

### Lab Tester (`/lab`)
Dashboard · Testing Requests · Pending Tests · Submit Results · Lab Reports · Testing History · Profile
* Accept or reject (with a reason) testing requests from processors. Results can be entered only for
  accepted requests.
* Report page, in three clearly separated parts:
  1. **Laboratory measurements**: moisture, HMF, sucrose, glucose, fructose, pH, °Brix, acidity, aw,
     conductivity, pollen, adulteration test. These are authoritative.
  2. **Standards-based rule check**: each value against the configured standard (FSSAI or Codex), with a
     *suggested* decision. This is not AI.
  3. **AI**: a prediction is shown only when the model is `TRAINED` and the input matches its training
     data. The quality model honestly reports `NOT_TRAINED`. The adulteration model needs hyperspectral
     scans and carries a LOW-reliability warning.
* Submit **PASS / FAIL / INCONCLUSIVE**. The audit log records whether the decision differed from the
  rule-based suggestion.
* Upload supporting documents (PDF/PNG/JPEG/CSV/TXT, 5 MB max, magic bytes checked, SHA-256 stored,
  immutable).
* **Audited correction**: a submitted report is never edited. The lab tester files a correction (reason +
  changed values) and an administrator approves it. The old report then becomes `SUPERSEDED`: it is kept
  unchanged and still verifiable on-chain, while a new report is created, linked
  (`supersedes_report_id`) and anchored.
* **Cannot:** change beekeeper or processing records, approve its own corrections, or open admin pages.

### Distributor (`/distributor`)
Dashboard · Incoming Batches · Distribution · Shipments · Delivery Status · History · Profile
* Accept or reject (with a reason) lab-passed batches from processors. The distributor sees the full
  traceability record, including the lab result.
* Record shipments (dispatch date, origin, recipient, destination, carrier, private docket number, units).
* Delivery status: in transit, delivered (with date), or cancelled. The batch becomes DELIVERED when every
  packed unit has been delivered.
* **Cannot:** modify harvest, processing or lab records, or open admin pages.

### Admin (`/admin`)
Dashboard · User Management · Role Management · Hives · Harvests · Batch Management · Processing Monitoring ·
Laboratory Monitoring · Distribution Monitoring · Blockchain Monitoring · Audit Logs · Anomalies · Reports · Settings
* Create accounts for all six roles; activate and deactivate them (deactivation ends existing sessions
  immediately).
* Change roles, with a reason. Every change is audited in both `user_role_changes` (trigger) and the
  activity log. Beekeeper accounts cannot be converted, an admin cannot change their own role, and the last
  active admin is protected.
* Role Management shows the six roles, user counts, the permission matrix (from `backend/src/config/roles.js`)
  and the role-change history.
* Read-only monitoring of hives, harvests, batches, processing, laboratory and distribution, including all
  transfers and testing requests.
* Laboratory Monitoring: approve or reject correction requests.
* Blockchain: anchor, retry and verify records. Anomalies: rule-based checks, with Isolation Forest gated
  on data volume.
* Reports: quantity reconciliation per batch, and security events (`ACCESS_DENIED`, `LOGIN_FAILED`) by IP
  and user.
* Settings: organizations, the active standards profile, the processing-loss threshold, and whether
  consumer registration is enabled. Every change goes to `app_settings_history` and the activity log.
  Read-only system configuration is shown with no secrets.
* **Admin cannot silently modify business records.** No admin endpoint edits hives, harvests, batches,
  lab results, processing or shipments (the tests assert 403). Lab results change only through approved
  corrections.

### Consumer (`/verify`, `/consumer`)
Product Verification · QR Scanner · Verification History · Profile (the last two only with the optional account)
* QR scanner: uses the camera with the native `BarcodeDetector` or a lazily loaded jsQR fallback, a photo
  upload, or manual code entry. **No account is needed.**
* The page shows product, origin (the producer's name only with their consent), harvest, processing, lab
  result (marked if it is a correction), custody journey, shipments, and per-record blockchain checks.
* **Overall verdict** (computed server side): `VERIFIED` only when every published record (origin,
  current lab report, processing, delivered shipments) has a confirmed anchor whose latest check is
  VERIFIED. Otherwise it shows `MISMATCH` (red warning), `PARTIAL`, `NOT_ANCHORED` or `UNAVAILABLE`, each
  with an explanation. The word "AUTHENTIC" is never used. The page states that verification proves
  integrity against the anchored version, not that the original information was true.
* Never exposed: emails, phone numbers, passwords, staff names, operator names, tracking/docket numbers,
  rejection reasons, notes. The public API reads only the `v_public_*` views.

## 3. RBAC: four layers

| Layer | Where | What it does |
|---|---|---|
| Route guards (UI) | `frontend/src/layouts/DashboardLayout.jsx` (`RoleLayout`) | Each view renders only for its role. Another role sees *Access denied (403)* and no foreign navigation. Anonymous users go to login. After login the user goes to their own home, and a "return to" path is honoured only inside their own view. |
| Endpoint guards (API) | `requireAuth` + `requireRole(...)` on every route | A wrong role gets 403 and an `ACCESS_DENIED` audit entry. The session is a JWT in an httpOnly, SameSite=Strict cookie. The user is reloaded from the database on every request, so role changes and deactivation take effect immediately. |
| Row-level scopes (API) | `backend/src/services/access.js`, `transferScope`, `requestScope` | Beekeeper: own hives. Processor or distributor: batches transferred to their organization (pending or accepted). Lab: batches with a request to their lab. Consumer: none. Anything out of scope is a 404 (no information leak). `sanitizeBatchDetail` removes private fields per role. |
| Database triggers | `backend/db/migrations/005_*.sql` | Who may create or answer transfers and requests, custody checks for processing and shipping, quantity rules, status transitions, immutability, correction-only changes to lab results, admin-only review, consumer-only history. These hold even for a buggy API or a manual psql session. |

## 4. API added or changed (all under `/api/v1`)

| Method & path | Roles | Purpose |
|---|---|---|
| `POST /auth/register-consumer` | public | optional consumer account |
| `GET/PATCH /auth/me/profile` | any signed-in | own name and phone |
| `GET /directory/organizations?type=` | BEEKEEPER (processors), PROCESSOR (labs, distributors), ADMIN | public organization fields only |
| `POST /batches/:code/transfers` | BEEKEEPER (to processor), PROCESSOR (to distributor) | start a custody transfer |
| `GET /transfers?direction=&status=&type=` | BEEKEEPER, PROCESSOR, DISTRIBUTOR, ADMIN | scoped list |
| `POST /transfers/:code/accept` · `/reject {reason}` | receiving PROCESSOR / DISTRIBUTOR | respond |
| `POST /transfers/:code/cancel {reason}` | sender | cancel while pending |
| `POST /lab-requests` · `GET /lab-requests` | PROCESSOR · LAB_TESTER, PROCESSOR, ADMIN | testing requests |
| `POST /lab-requests/:code/accept` · `/reject` · `/cancel` | LAB_TESTER · LAB_TESTER · PROCESSOR | respond / cancel |
| `GET /lab/queue` | LAB_TESTER | accepted requests awaiting results |
| `GET /lab/reports/:code/screening` | LAB_TESTER, ADMIN | rule-based check + suggested decision |
| `POST /lab/reports/:code/submit` | LAB_TESTER | decision now `PASS`, `FAIL` or `INCONCLUSIVE` |
| `POST/GET /lab/reports/:code/documents`, `GET /lab/documents/:id` | LAB_TESTER (own lab), ADMIN | supporting documents |
| `POST /lab/reports/:code/corrections` | LAB_TESTER | request an audited correction |
| `GET /lab-corrections`, `POST /lab-corrections/:code/approve\|reject` | LAB_TESTER (list), ADMIN | review corrections |
| `GET /processing/queue` | PROCESSOR | accepted batches to process (was: every LAB_PASSED batch) |
| `GET /distribution/queue`, `POST /shipments` | DISTRIBUTOR | only batches the company accepted |
| `GET /consumer/verifications` | CONSUMER | verification history |
| `GET /public/batches/:code` | public | adds `custody`, `verification.overall`, `savedToHistory` |
| `PATCH /admin/users/:id/role` · `GET /admin/role-changes` · `GET /admin/roles` | ADMIN | role management |
| `GET/PATCH /admin/settings[/:key]` | ADMIN | settings + history |
| `GET /admin/security-events`, `GET /admin/reports/reconciliation` | ADMIN | reports |
| removed: `POST /batches/:code/assign-lab`, `GET /labs` | | beekeepers no longer assign labs |

## 5. Database changes (migration 005, applied in place, existing rows kept)

* `roles`: `LAB` renamed to `LAB_TESTER`; `CONSUMER` added; CHECK constraints updated.
* New tables: `batch_transfers`, `lab_test_requests`, `lab_report_documents`, `lab_report_corrections`,
  `consumer_verifications`, `app_settings`, `app_settings_history`, `user_role_changes`.
* `lab_reports`: `request_id`, `supersedes_report_id`, `superseded_at`; decision now includes
  `INCONCLUSIVE`; state now includes `SUPERSEDED`. At most one final (PASS/FAIL) submitted report per
  batch.
* `batch_statuses` / `batch_status_transitions`: the 12-stage lifecycle above.
* New functions: `batch_processor_org`, `batch_distributor_org`, `batch_owner_user`, `batch_current_report`.
  Custody is derived from accepted transfers and never duplicated in the batches table.
* Triggers rewritten: processing, shipments and lab reports now require custody or an accepted request.
* Views recreated: `v_batch_trace` and `v_public_batch` use the current report. New view `v_public_custody`.
* `batches.assigned_lab_id` is kept for legacy rows only and is no longer written.
