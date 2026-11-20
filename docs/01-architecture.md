# 01 — System Architecture

## 1. One application, five services

```
                         ┌──────────────────────────────────────────┐
  Browser                │  React frontend (Vite)   :5173           │
  (staff + consumers)───▶│  role dashboards + public /verify/:code   │
                         └───────────────┬──────────────────────────┘
                                         │ HTTPS/JSON, httpOnly JWT cookie
                                         ▼
                         ┌──────────────────────────────────────────┐
                         │  Node.js + Express API    :4000          │
                         │  auth · RBAC · validation · workflow     │
                         │  hashing · QR · rule checks · workers    │
                         └──┬──────────┬───────────┬──────────┬─────┘
                            │ SQL      │ driver    │ HTTP     │ JSON-RPC (ethers)
                            ▼          ▼           ▼          ▼
                  ┌──────────────┐ ┌─────────┐ ┌─────────────┐ ┌──────────────────┐
                  │ PostgreSQL   │ │ MongoDB │ │ FastAPI AI  │ │ Hardhat :8545    │
                  │ :5432        │ │ :27017  │ │ :8000       │ │  (or Sepolia)    │
                  │ AUTHORITATIVE│ │ support │ │ sklearn     │ │ HoneyChainAnchor │
                  └──────────────┘ └─────────┘ └─────────────┘ └──────────────────┘
```

| Service | Responsibility | Never does |
|---|---|---|
| **React frontend** | Forms, tables, dashboards, public verify page | Authorization decisions (it only hides buttons for usability) |
| **Express API** | The only thing that talks to databases, AI and chain; enforces roles and lifecycle | Expose MongoDB/PostgreSQL/AI/chain directly to the browser |
| **PostgreSQL** | System of record for users, hives, harvests, batches, lab/processing/shipment records, QR, anchors, verification history | Store AI blobs or high-volume logs |
| **MongoDB** | AI analysis results, spectral scans, anomaly reports, activity logs | Hold any record the supply chain depends on |
| **FastAPI AI service** | Model status, quality model, adulteration model, Isolation Forest scoring | Store data; it is stateless apart from model files |
| **Hardhat / Sepolia** | Stores hashes of selected records via a smart contract | Store names, emails, phone numbers or raw records |

## 2. Request flow examples

**Lab submits a report (most complex write):**

```
LAB user ──POST /api/v1/lab/reports/:id/submit──▶ Express
  1. requireAuth → requireRole('LAB') → validate body (zod)
  2. PostgreSQL TRANSACTION
       set_config('app.user_id', ...)
       SELECT batch ... FOR UPDATE
       UPDATE lab_reports SET report_state='SUBMITTED', decision=...   (trigger checks)
       UPDATE batches SET status='LAB_PASSED' | 'LAB_FAILED'           (trigger checks + history)
       INSERT blockchain_anchors (status PENDING, canonical_json, record_hash)
     COMMIT
  3. after commit: activity log → MongoDB (on failure → mongo_outbox)
  4. respond 200
  5. anchor worker (background) picks PENDING anchor → sends tx → SUBMITTED → CONFIRMED (tx hash, block)
```

**Consumer scans a QR code:**

```
Phone camera → https://<host>/verify/HC-2026-000123  (React page)
  → GET /api/v1/public/batches/HC-2026-000123
      reads v_public_batch, v_public_shipments, v_anchor_status   (PostgreSQL)
      if last verification older than PUBLIC_REVERIFY_MINUTES → verify against chain, store check
      latest AI analysis summary (MongoDB) — with disclaimer and model status
      log PUBLIC_QR_SCAN (MongoDB, TTL 90 days); qr_records.scan_count += 1
```

## 3. Cross-database consistency (PostgreSQL ⇄ MongoDB ⇄ chain)

The rule: **PostgreSQL commits first, everything else follows.** Nothing in PostgreSQL ever depends on MongoDB or the chain succeeding.

| Situation | What happens | What the user sees |
|---|---|---|
| PostgreSQL transaction fails | Whole transaction rolls back; nothing written anywhere | Error with reason (e.g. `HARVEST_OVER_ALLOCATED`) |
| PG commits, MongoDB activity-log write fails | Document stored in `mongo_outbox`; worker retries with backoff (1 min, 5 min, 30 min … up to 8 attempts, then `DEAD`, shown on admin dashboard) | Normal success (the log is supplementary) |
| AI analysis computed, MongoDB save fails | Result returned to the lab user **with a warning "not saved"** and queued in `mongo_outbox` | Yellow warning banner |
| AI service down | No result is invented; status `SERVICE_UNAVAILABLE` | "AI service unavailable" |
| PG commits, chain unreachable | Anchor row stays `PENDING`; worker retries; admin can retry manually | "Anchoring pending" (never "verified") |
| Chain tx reverted / fails | Anchor `FAILED` with `failure_reason`; admin retry creates a new attempt | "Anchoring failed" on admin page |
| Hardhat node restarted (local chain wiped) | Verification returns `NOT_FOUND_ON_CHAIN`; admin can re-anchor to the new deployment (old rows kept as history) | Honest status, not "verified" |

**Eventual-consistency limitation (documented, accepted):** for a short time after a write, MongoDB logs and blockchain anchors can lag behind PostgreSQL. The UI always shows the *state* (PENDING / SUBMITTED / CONFIRMED) rather than assuming success.

## 4. Security model

| Concern | Design |
|---|---|
| Passwords | bcrypt (cost 12); never logged, never returned |
| Sessions | JWT (HS256, 8 h) in an **httpOnly, SameSite=Strict** cookie → JavaScript cannot read it (XSS-resistant), cross-site requests don't carry it (CSRF-resistant) |
| Authorization | `requireRole(...)` on every route **plus** ownership checks in the service layer (e.g. beekeeper may only touch hives where `beekeeper.user_id = req.user.id`) **plus** DB triggers for staff/org membership |
| Registration | Only beekeepers self-register. Lab/processor/distributor/admin accounts are created by an admin |
| SQL injection | Only parameterized queries (`$1, $2`) via `pg`; no string-built SQL |
| Input validation | `zod` schemas on every body/param; DB CHECK constraints behind them |
| Public data | Public endpoints read only `v_public_*` views |
| Secrets | `.env` files (git-ignored); `.env.example` committed with placeholders |
| Rate limiting | Login and public verify endpoints rate-limited |
| Service-to-service | Express → AI service uses a shared `AI_SERVICE_KEY` header; AI service binds to 127.0.0.1 |
| Blockchain key | `DEPLOYER_PRIVATE_KEY` only in `.env`; only hashes go on-chain |

## 5. Ports and environment variables

| Service | Port | Key variables |
|---|---|---|
| Frontend | 5173 | `VITE_API_BASE_URL` |
| Backend | 4000 | `DATABASE_URL`, `MONGODB_URI`, `JWT_SECRET`, `PUBLIC_BASE_URL`, `AI_SERVICE_URL`, `AI_SERVICE_KEY`, `CHAIN_NETWORK`, `HARDHAT_RPC_URL`, `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `ANCHOR_CONTRACT_ADDRESS`, `ANOMALY_MIN_RECORDS`, `PUBLIC_REVERIFY_MINUTES` |
| AI service | 8000 | `AI_SERVICE_KEY`, `MODEL_DIR` |
| Hardhat node | 8545 | — |
| PostgreSQL | 5432 | — |
| MongoDB | 27017 | — |

`CHAIN_NETWORK=hardhat` (default) or `sepolia`. Switching changes only the RPC URL, chain id, signer and contract address; application code is identical.

## 6. What is deliberately out of scope

IoT devices, hive sensors, temperature/humidity/weight/hive-health telemetry, sensor dashboards, honey-yield prediction (dropped in the final description), AI certification claims.
