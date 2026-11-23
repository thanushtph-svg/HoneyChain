# 03 — PostgreSQL Design

> **Updated by migration 005:** workflow order is now beekeeper → processor → laboratory → distributor with custody transfers; see [10-role-based-views.md §5](10-role-based-views.md#5-database-changes-migration-005-applied-in-place-existing-rows-kept) for the new tables, triggers and views. Sections below describing lab-before-processing rules or `batches_lab_queue_idx` describe migrations 001-004 only.


The DDL lives in `backend/db/migrations/` and runs in order:

| File | Contents |
|---|---|
| `001_core_schema.sql` | 17 tables, PK/FK/UNIQUE/CHECK constraints, code sequences, lookup data |
| `002_business_rules.sql` | Trigger functions enforcing supply-chain rules inside the database |
| `003_indexes.sql` | Indexes justified by real queries |
| `004_views.sql` | Internal trace view + privacy-safe public views |
| `tests/schema_tests.sql` | 44 automated checks (lifecycle + every rejected violation); rolls back |

## 1. Tables at a glance

| # | Table | One row = | Key constraints |
|---|---|---|---|
| 1 | `roles` | a role | PK `role_code` (natural key), CHECK on allowed values |
| 2 | `organizations` | a lab / processor / distributor | UNIQUE(`name`,`org_type`), CHECK `org_type` |
| 3 | `users` | a login | UNIQUE `lower(email)`, email format CHECK, staff ⇔ org CHECK |
| 4 | `beekeepers` | beekeeper profile | `user_id` UNIQUE (1:1), consent flag `show_name_publicly` |
| 5 | `hives` | a hive | CHECK hive type, `installed_on ≤ today` |
| 6 | `harvests` | one harvest from one hive | `0 < quantity_kg ≤ 500`, `harvest_date ≤ today` |
| 7 | `batch_statuses` | a lifecycle state | lookup |
| 8 | `batch_status_transitions` | a legal state change | PK(from,to) |
| 9 | `batches` | a traceable unit (gets the QR) | `quantity_kg > 0`, FK status |
| 10 | `batch_status_history` | one status change | written only by trigger |
| 11 | `lab_reports` | one lab test report | range CHECKs, DRAFT/SUBMITTED, decision rules, partial uniques |
| 12 | `processing_records` | processing + packaging of a batch | `batch_id` UNIQUE, output ≤ input, packed mass ≤ output, date order |
| 13 | `shipments` | one dispatch leg | delivered ⇔ date, date order, status CHECK |
| 14 | `qr_records` | the QR of a batch | `batch_id` UNIQUE, `public_url` UNIQUE |
| 15 | `blockchain_anchors` | one anchoring attempt | typed FKs, hex-format CHECKs, CONFIRMED ⇒ tx+block |
| 16 | `verification_checks` | one hash comparison | result must agree with the hashes |
| 17 | `mongo_outbox` | a MongoDB write waiting for retry | status CHECK |

**ID scheme.** Integer surrogate keys for joins; separate human-readable codes from sequences:

| Entity | Example code |
|---|---|
| Beekeeper | `BK-00012` |
| Hive | `HIVE-000047` |
| Harvest | `HRV-2026-000031` |
| Batch (QR) | `HC-2026-000123` |
| Lab report | `LAB-2026-000045` |
| Processing | `PRC-2026-000040` |
| Shipment | `SHP-2026-000077` |

## 2. Rules enforced by the database

These run even if someone bypasses the API (e.g. a psql session).

| Rule | Mechanism | Error code |
|---|---|---|
| Lab/processor/distributor staff belong to an org of the matching type | CHECK + trigger | `ORG_ROLE_MISMATCH` |
| Beekeeper profile only for BEEKEEPER users | trigger | `NOT_A_BEEKEEPER` |
| Harvest only from an ACTIVE hive, not before installation | trigger | `HIVE_INACTIVE`, `HARVEST_BEFORE_HIVE` |
| Harvest details frozen once batched | trigger | `HARVEST_LOCKED` |
| Σ batch quantity ≤ harvest quantity (concurrency-safe) | trigger + `SELECT … FOR UPDATE` | `HARVEST_OVER_ALLOCATED` |
| New batch starts CREATED; only listed transitions allowed | trigger + transition table | `BAD_INITIAL_STATUS`, `INVALID_TRANSITION` |
| Every status change recorded with acting user | AFTER trigger → `batch_status_history` | — |
| Lab must be assigned the batch; tester must be LAB staff of that lab | trigger | `LAB_NOT_ASSIGNED`, `NOT_LAB_STAFF` |
| One DRAFT and one SUBMITTED report per batch | partial unique indexes | unique violation |
| Submitted report needs decision + time; then immutable | CHECK + trigger | `REPORT_IMMUTABLE` |
| Processing only after LAB_PASSED; input ≤ batch; date ≥ test date | trigger | `BATCH_NOT_PROCESSABLE`, `INPUT_EXCEEDS_BATCH`, `DATE_ORDER` |
| Packed mass ≤ processed output ≤ input | CHECKs | constraint names |
| Units shipped ≤ units packed (concurrency-safe) | trigger + row lock | `SHIPPED_EXCEEDS_PACKED` |
| Shipment status path DISPATCHED → IN_TRANSIT → DELIVERED (or CANCELLED) | trigger | `INVALID_TRANSITION` |
| Anchor references the right record of the right batch; never deleted | CHECK + trigger | `ANCHOR_BATCH_MISMATCH`, `RECORD_IMMUTABLE` |
| An anchor cannot be CONFIRMED without a real tx hash and block | CHECK | `anchor_confirmed_has_tx` |
| Only exception on immutable rows: `is_demo` may be switched false → true (never back); `is_demo` is in no hash | `only_demo_flag_set()` in the lab/processing triggers | — |
| A check cannot say VERIFIED when hashes differ | CHECK | `verify_result_consistent` |

The API maps `P0001` errors with these codes to HTTP **409 Conflict** (rule violations) and CHECK/unique violations to **422/409** with a readable message.

## 3. Transactions

Each of these runs as **one** `BEGIN … COMMIT` block. If any step fails, everything rolls back.

| Operation | Steps inside the transaction |
|---|---|
| Register beekeeper | INSERT `users` → INSERT `beekeepers` |
| Create batches from a harvest | lock harvest → INSERT N `batches` (trigger checks total) → INSERT N `qr_records` → INSERT N `blockchain_anchors` (BATCH_ORIGIN, PENDING) |
| Start lab report | lock batch → INSERT `lab_reports` (DRAFT) → UPDATE batch `IN_TESTING` (first draft only) |
| Submit lab report | lock batch → UPDATE report SUBMITTED → UPDATE batch LAB_PASSED/LAB_FAILED → INSERT anchor (LAB_REPORT) |
| Record processing | lock batch → INSERT `processing_records` → UPDATE batch PROCESSED → INSERT anchor |
| Dispatch shipment | lock processing row → INSERT `shipments` → UPDATE batch IN_DISTRIBUTION (first shipment) |
| Deliver shipment | UPDATE shipment DELIVERED → INSERT anchor (SHIPMENT) → if all packed units shipped and all delivered, UPDATE batch DELIVERED |
| Verify anchor | read record → recompute hash → read chain → INSERT `verification_checks` |

**Isolation:** PostgreSQL's default `READ COMMITTED` plus explicit row locks (`SELECT … FOR UPDATE`) on the "parent" row (harvest, batch, processing record). This serializes the competing writers that matter without the retry overhead of `SERIALIZABLE`.

**Tested here:** two sessions each tried to create a 12 kg batch from the same 20 kg harvest at the same moment. Session B waited for A's lock, then saw A's 12 kg and was rejected with `HARVEST_OVER_ALLOCATED: batches would total 24.00 kg but harvest has only 20.00 kg`. Final state: one batch, 12 kg.

## 4. Index justification

PostgreSQL indexes PKs and UNIQUE columns automatically, **not foreign keys**.

| Index | Query it serves |
|---|---|
| `users_email_lower_uq` | login: `WHERE lower(email) = lower($1)` (also enforces uniqueness) |
| `hives_beekeeper_idx` | beekeeper dashboard: my hives |
| `harvests_hive_date_idx (hive_id, harvest_date DESC)` | harvest history per hive, newest first |
| `batches_harvest_idx` | batches of a harvest; Σ quantity check in trigger |
| `batches_status_idx` | processor/distributor queues, admin counts by status |
| `batches_lab_queue_idx (assigned_lab_id, status) WHERE status IN (…)` | lab queue (partial index: only open work is indexed) |
| `lab_reports_org_date_idx` | lab testing history |
| `shipments_batch_idx` | Σ units shipped check; batch journey |
| `shipments_org_status_idx` | distributor: my active shipments |
| `anchors_pending_idx … WHERE status IN ('PENDING','SUBMITTED')` | anchor worker polling |
| `verification_anchor_time_idx` | latest verification per anchor (`v_anchor_status`) |
| `outbox_due_idx … WHERE status='PENDING'` | outbox retry worker |

Evidence on seeded data (`docs/sql/demo_queries.sql`, Q12): the lab-queue query uses `Index Scan using batches_lab_queue_idx`.

## 5. Views (public/private separation in the database)

| View | Used by | Contains |
|---|---|---|
| `v_batch_trace` | Admin | Everything about a batch in one row (including private fields) |
| `v_public_batch` | Public QR page | Only approved fields. Beekeeper name shown **only** if `show_name_publicly`; lab/processor shown as organizations; no emails, phones, staff ids, operator names |
| `v_public_shipments` | Public QR page | Dates, destination type/city/state, status, distributor org name; no tracking refs |
| `v_anchor_status` | Admin + public | Each anchor with its latest verification result |

A test asserts that no private column name appears in the public views.

## 6. DBMS-concept coverage map (for the report/viva)

| Concept | Where to point |
|---|---|
| PK, FK, UNIQUE, CHECK | `001_core_schema.sql` |
| Composite & partial unique indexes | `UNIQUE(lab_org_id, sample_code)`, `lab_reports_one_submitted_uq` |
| Triggers / stored functions | `002_business_rules.sql` |
| Transactions & locking | §3 and the concurrency test |
| Views | `004_views.sql` |
| Joins (inner, left, lateral) | `v_batch_trace`, `v_anchor_status` |
| Aggregation / GROUP BY / HAVING / subqueries / window functions | admin statistics endpoint + `docs/sql/demo_queries.sql` (13 queries, tested on seed data) |
| Normalization | doc 02 §3 |
