# 08 — Repository Structure

All items below now exist (P-numbers show the phase in which each was built).

```
honeychain/
├── README.md                         P2 stub → full setup guide in P10
├── .gitignore                        P3   (.env, node_modules, .venv, models/*.joblib, hardhat cache…)
├── .env.example                      P3   every variable with a safe placeholder
│
├── docs/                             P2
│   ├── README.md                     index of design docs
│   ├── 01-architecture.md
│   ├── 02-er-diagram.md
│   ├── 03-postgresql-design.md
│   ├── 04-mongodb-design.md
│   ├── 05-api-contract.md
│   ├── 06-blockchain-hashing-spec.md
│   ├── 07-ai-service-design.md
│   ├── 08-repository-structure.md
│   ├── 09-decision-log.md
│   ├── sql/demo_queries.sql          P5–P6 joins / GROUP BY / subqueries for the report
│   └── testing.md                    P10
│
├── backend/                          Node.js 20+ / Express
│   ├── package.json                  P3
│   ├── db/
│   │   ├── migrations/001…004.sql    P2  (tested)
│   │   ├── mongo/collections.json    P2
│   │   ├── tests/schema_tests.sql    P2  (44 checks)
│   │   ├── migrate.js                P3  applies .sql files in order, records them in schema_migrations
│   │   ├── mongo-init.js             P3  creates collections, validators, indexes
│   │   └── seeds/                    P5–P6 demo data (is_demo = true)
│   ├── config/standards.json         P9
│   ├── src/
│   │   ├── app.js / server.js        P3
│   │   ├── config/env.js             P3  loads + validates .env (fails fast on missing vars)
│   │   ├── db/pg.js, mongo.js, tx.js P3  pool, client, withTransaction(userId, fn)
│   │   ├── middleware/               P4  auth.js, requireRole.js, validate.js, errorHandler.js, rateLimit.js
│   │   ├── modules/                  P4–P9  one folder per area:
│   │   │   ├── auth/ users/ organizations/
│   │   │   ├── beekeepers/ hives/ harvests/ batches/     P5
│   │   │   ├── lab/ processing/ distribution/            P6
│   │   │   ├── qr/ public/                               P7
│   │   │   ├── blockchain/                               P8
│   │   │   └── ai/ anomalies/ admin/                     P6–P9
│   │   │       (each: routes.js · controller.js · service.js · schemas.js)
│   │   ├── services/                 canonicalHash.js (P8), chainClient.js (P8), aiClient.js (P9),
│   │   │                             activityLog.js (P4), outboxWorker.js (P4), anchorWorker.js (P8)
│   │   └── utils/
│   └── tests/                        API, RBAC, workflow tests (node:test + supertest)
│
├── frontend/                         React (Vite)
│   ├── package.json                  P3
│   └── src/
│       ├── main.jsx, App.jsx, routes.jsx
│       ├── api/client.js + one file per module
│       ├── context/AuthContext.jsx
│       ├── layouts/DashboardLayout.jsx, PublicLayout.jsx
│       ├── components/               Table, Card, StatCard, FormField, StatusBadge, ModelStatusBadge,
│       │                             IntegrityBadge, Timeline (from legacy design), EmptyState, ErrorState, Spinner
│       ├── pages/
│       │   ├── auth/                 Login, RegisterBeekeeper
│       │   ├── beekeeper/            Dashboard, Hives, Harvests, HarvestDetail, Batches, Profile
│       │   ├── lab/                  Queue, ReportForm, AIPanel, History
│       │   ├── processor/            Queue, ProcessingForm, History
│       │   ├── distributor/          Queue, ShipmentForm, Shipments
│       │   ├── admin/                Overview, Users, Organizations, Records, Anomalies, Blockchain, ActivityLogs
│       │   └── public/               Home, VerifyBatch (reuses legacy verify layout), NotFound
│       └── styles/                   tokens.css (amber/gold palette), base.css, components.css
│
├── ai-service/                       Python 3.11+ / FastAPI / scikit-learn
│   ├── requirements.txt              P3
│   ├── app/main.py, auth.py, registry.py (model gating), quality.py, adulteration.py, anomaly.py
│   ├── training/                     P9  prepare_*.py, train_*.py, evaluate_*.py (group-aware splits)
│   ├── data/README.md                P9  how to download each dataset + licence; raw data git-ignored
│   ├── models/<name>/                P9  manifest.json, metrics.json, DATASET_CARD.md (+ model.joblib, git-ignored)
│   └── tests/
│
├── blockchain/                       Hardhat
│   ├── package.json, hardhat.config.js   P3 (networks: hardhat, localhost, sepolia from .env)
│   ├── contracts/HoneyChainAnchor.sol    P8
│   ├── scripts/deploy.js                 P8  writes deployments/<network>.json
│   ├── deployments/                      P8
│   └── test/HoneyChainAnchor.test.js     P8
│
└── legacy/flask-prototype/           P2  original repo, untouched, kept for reference
```

## Reuse from the original repository

| Original | New home |
|---|---|
| `templates/verify.html` layout (header card → info grid → lab panel → timeline → integrity block) | `frontend/src/pages/public/VerifyBatch.jsx` without the IoT/AI-snapshot sections |
| `static/style.css` cards, pills, timeline, breakpoints | `frontend/src/styles/components.css`, re-tinted to amber/gold |
| `templates/not_found.html` | `pages/public/NotFound.jsx` |
| `templates/home.html` hero + cards | `pages/public/Home.jsx` (cards list **real** demo batches from the API) |
| `/qr/<id>` logic (URL from base + id, PNG via qrcode) | `backend/src/modules/qr/` (`qrcode` npm, base from `PUBLIC_BASE_URL`) |
| `/verify/<id>` URL pattern, case-insensitive codes | kept |
| Demo names/places | demo seed data (flagged `is_demo`) |

## Run layout on Windows (from Phase 3)

Five PowerShell windows, one per service, plus PostgreSQL and MongoDB running as Windows services:

```
backend      → npm run dev          (:4000)
frontend     → npm run dev          (:5173)
ai-service   → uvicorn app.main:app (:8000)
blockchain   → npx hardhat node     (:8545)
(once)       → npx hardhat run scripts/deploy.js --network localhost
```
