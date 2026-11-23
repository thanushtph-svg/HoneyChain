# HoneyChain

**AI-assisted honey quality & adulteration analysis with blockchain-based supply-chain traceability.** A DBMS course project.

One web application with **six separate role-based views** tracks honey from the beekeeper to the consumer.
Every hand-over is a custody **transfer** that the receiver must **accept** or **reject with a reason**:

```
Beekeeper ──transfer──► Processor ──testing request──► Lab Tester ──result──► Processor ──transfer──► Distributor ──► Consumer
 hives                   accept/reject                  accept/reject           (custody)              accept/reject      QR code, no login
 harvests → batches      processing, losses             PASS/FAIL/INCONCLUSIVE                         shipments,         origin, processing, lab,
 QR codes                                               documents, corrections                         delivery           journey, blockchain check

Administrator: users & roles, monitoring, audit logs, blockchain, anomalies, reports, settings, approves audited lab corrections
```

| View | URL | Who |
|---|---|---|
| Beekeeper | `/beekeeper` | registers hives, records harvests, creates/splits batches, transfers to a processor |
| Processor | `/processor` | accepts/rejects batches, records processing, requests lab testing, transfers to distributors |
| Lab Tester | `/lab` | accepts/rejects testing requests, records results, documents, requests corrections |
| Distributor | `/distributor` | accepts/rejects batches, records shipments and delivery |
| Admin | `/admin` | administration and read-only monitoring (cannot edit business records) |
| Consumer | `/verify` (no account) and `/consumer` (optional account with history) | product verification |

Details: [docs/10-role-based-views.md](docs/10-role-based-views.md).

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + React Router |
| Backend | Node.js 20+/22 + Express 5 (REST, zod validation, JWT httpOnly cookie, six-role RBAC + row-level scopes) |
| Primary DB | PostgreSQL 14+ (25 tables, 20 trigger functions, partial indexes, views; business rules enforced by triggers) |
| Secondary DB | MongoDB Community 7/8 (AI results, spectral scans, anomaly reports, activity logs) |
| AI service | Python 3.11–3.13, FastAPI, scikit-learn 1.9.1 |
| Blockchain | Solidity 0.8.24 contract, Hardhat local chain (default) or Sepolia testnet |

> **Scope:** no IoT/sensor features. All data is entered by authorized users. AI output is decision support only; laboratory decisions are authoritative. Blockchain verification detects changes to anchored records; it does not prove the original data was true.

---

## 1. Install the prerequisites (once, on Windows)

| Software | Version | Download | Notes |
|---|---|---|---|
| Node.js | 22 LTS (20+ works) | https://nodejs.org | includes npm |
| Python | 3.12 recommended (3.11–3.13) | https://www.python.org/downloads/ | tick **"Add python.exe to PATH"** |
| PostgreSQL | 16 or 17 | https://www.postgresql.org/download/windows/ | remember the **postgres password** you set; keep port 5432 |
| MongoDB Community Server | 7 or 8 | https://www.mongodb.com/try/download/community | choose **"Install MongoD as a Service"** (default) |
| Git | any | https://git-scm.com | optional |

Check them in a **new** PowerShell window:

```powershell
node -v
npm -v
python --version
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" --version   # use 16 instead of 17 if you installed 16
Get-Service MongoDB, postgresql*                                # both should say Running
```

---

## 2. Configure

```powershell
cd path\to\honeychain
Copy-Item .env.example .env
notepad .env
```

In `.env` change at least these values:

| Variable | Set to |
|---|---|
| `DATABASE_URL` | `postgres://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/honeychain` |
| `JWT_SECRET` | any random string of 32+ characters |
| `AI_SERVICE_KEY` | another random string of 16+ characters |

Generate random strings in PowerShell:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})
```

Everything else can stay as it is for local development.

---

## 3. Install dependencies (once)

Run these four blocks from the project folder.

```powershell
# 3a. Backend
cd backend
npm install
cd ..

# 3b. Frontend
cd frontend
npm install
cd ..

# 3c. Blockchain (Hardhat + bundled Solidity compiler - works offline)
cd blockchain
npm install
npx hardhat compile
cd ..

# 3d. AI service (Python virtual environment)
cd ai-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
deactivate
cd ..
```

> If PowerShell blocks `Activate.ps1` with an "execution policy" error, run once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

---

## 4. Create the databases (once)

```powershell
cd backend
npm run db:migrate        # creates database "honeychain", tables, triggers, indexes, views
npm run db:mongo-init     # creates MongoDB collections with validators and indexes
cd ..
```

Expected output ends with `[migrate] 5 new migration(s)` and four `[mongo-init] ... ready` lines.

---

## 5. Start everything (every time)

Open **four PowerShell windows** (or run `.\scripts\start-dev.ps1`, which opens them for you).

**Window 1 - local blockchain** (keep it open):
```powershell
cd path\to\honeychain\blockchain
npx hardhat node
```

**Window 2 - deploy the contract** (each time you restart the Hardhat node), then start the AI service:
```powershell
cd path\to\honeychain\blockchain
npx hardhat run scripts/deploy.js --network localhost
cd ..\ai-service
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Window 3 - backend API:**
```powershell
cd path\to\honeychain\backend
npm run dev
```
It should print `blockchain: hardhat contract 0x5FbDB...` and `listening on http://localhost:4000`.

**Window 4 - frontend:**
```powershell
cd path\to\honeychain\frontend
npm run dev
```

Open **http://localhost:5173**. Check that everything is connected at **http://localhost:4000/api/v1/health**: all four services should say `"up"`.

---

## 6. Load the demo data (optional, recommended)

With the Hardhat node, contract, AI service **and** MongoDB running (the backend server itself may be stopped):

```powershell
cd backend
npm run db:reset -- --yes   # WIPES all HoneyChain data
npm run db:seed
```

The seed drives the real API through the complete workflow: organizations, users of all six roles, hives, harvests, 10 batches in different stages, custody transfers (one rejected), processing, testing requests (one rejected), lab reports (PASS / FAIL / INCONCLUSIVE / draft), a pending audited correction, shipments and AI analyses. It anchors 24 records on-chain and runs an anomaly scan. Every row is flagged **DEMO DATA**.

| Role | Email | Password | Lands on |
|---|---|---|---|
| Administrator | admin@honeychain.demo | Demo@1234 | `/admin` |
| Lab Tester | lab@honeychain.demo | Demo@1234 | `/lab` |
| Processor | processor@honeychain.demo (second unit: processor2@honeychain.demo) | Demo@1234 | `/processor` |
| Distributor | distributor@honeychain.demo | Demo@1234 | `/distributor` |
| Beekeeper | lakshmi@honeychain.demo · ramesh@honeychain.demo · anitha@honeychain.demo | Demo@1234 | `/beekeeper` |
| Consumer (optional account) | consumer@honeychain.demo | Demo@1234 | `/consumer` |

Demo batches:

| Batch | State | Shows |
|---|---|---|
| HC-2026-000001 | DELIVERED | complete journey, all records anchored and VERIFIED |
| HC-2026-000003 | IN_DISTRIBUTION | shipment in transit |
| HC-2026-000005 | LAB_PASSED | HMF above the FSSAI limit but PASS (rule **R07**) + a correction waiting for admin review |
| HC-2026-000006 | IN_TESTING | draft report with 2 hyperspectral scans and real adulteration predictions |
| HC-2026-000004 | LAB_FAILED | failing lab values |
| HC-2026-000009 | LAB_INCONCLUSIVE | processor can request a re-test |
| HC-2026-000010 | PENDING_LAB | first testing request rejected by the lab (reason recorded), second one pending |
| HC-2026-000007 | PENDING_PROCESSOR | waiting for the processor to accept |
| HC-2026-000008 | CREATED | rejected by the second processor, back with the beekeeper (reason recorded) |
| HC-2026-000002 | CREATED | not yet sent to a processor |

Consumer page: **http://localhost:5173/verify/HC-2026-000001** (no login).

**Using real data instead of the demo seed:** create the first administrator, then create organizations and staff accounts in *Admin > Settings > Organizations* and *Admin > User Management*:

```powershell
cd backend
$env:ADMIN_PASSWORD = "choose-a-strong-pass1"   # optional; otherwise a random one is printed once
npm run admin:create -- --email you@example.org --name "Your Name"
```

---

## 7. Five-minute demo script (for the viva)

1. **Consumer (no account):** open `/verify/HC-2026-000001`. The banner says *Records verified against the blockchain* only because every published record verified; the journey shows harvest → processor → processing → lab → distributor → shipments.
2. **Beekeeper** (anitha): register a hive, record a harvest, split it into 2 batches (each gets a QR code), open a batch and *Transfer to a processor*.
3. **Processor:** *Incoming Batches* → accept one, reject the other with a reason (the beekeeper's dashboard shows it returned). *Processing* → record processing (the loss is calculated). *Processed Batches* → send a testing request to the laboratory.
4. **Lab Tester:** *Testing Requests* → accept. *Pending Tests* → enter results; the page separates laboratory measurements, the standards-based rule check (with its suggested decision) and AI. Submit PASS. Try the adulteration model on HC-2026-000006 (real prediction, LOW reliability warning).
5. **Processor** → *Transfers* → send to the distributor. **Distributor** → accept → *Distribution* → dispatch → *Delivery Status* → delivered.
6. **Admin:** *Laboratory Monitoring* → approve the pending correction on HC-2026-000005: the old report stays as SUPERSEDED (still verifiable), a new corrected report is created and anchored. *Role Management* shows the permission matrix; *Reports* shows quantity reconciliation and security events (try opening `/admin` as a beekeeper: *Access denied*, logged as ACCESS_DENIED).
7. **Tamper demo** (shows blockchain value), in a psql window:
   ```sql
   ALTER TABLE lab_reports DISABLE TRIGGER lab_reports_rules;
   UPDATE lab_reports SET moisture_pct = 15.00 WHERE report_code = 'LAB-2026-000001';
   ALTER TABLE lab_reports ENABLE TRIGGER lab_reports_rules;
   ```
   As admin, *Blockchain Monitoring* → *Verify*: **MISMATCH**. The public page now shows an integrity warning instead of "verified", and an anomaly scan raises **R10_INTEGRITY**.

---

## 8. Run the tests

```powershell
# Database schema (78 checks, rolls back - run against the TEST database)
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d honeychain_test -v ON_ERROR_STOP=1 -o NUL -f backend\db\tests\schema_tests.sql

# Smart contract (8 tests)
cd blockchain; npx hardhat test; cd ..

# AI service (11 tests)
cd ai-service; .\.venv\Scripts\Activate.ps1; python -m pytest -q; deactivate; cd ..

# Backend end-to-end API tests (36 tests incl. the RBAC matrix for all six roles; uses database honeychain_test).
# Start the Hardhat node + deploy + AI service first so blockchain/AI tests run instead of being skipped.
cd backend; npm test; cd ..

# Frontend UI tests (108 tests: 96 page/navigation/403 checks + 12-step UI workflow) - need a seeded backend.
# Point API_BASE at it (default http://localhost:4000).
cd frontend; npm run test:ui; cd ..
```

Full details and the latest results: [docs/testing.md](docs/testing.md).

---

## 9. Scanning QR codes with a phone

1. Find your PC's Wi-Fi IP: `ipconfig` (e.g. `192.168.1.20`).
2. In `.env`, set `PUBLIC_BASE_URL=http://192.168.1.20:5173` and restart the backend. **Only batches created after this** get the new URL; QR URLs are stored when a batch is created so printed labels never change.
3. Allow port 5173 in Windows Firewall when prompted.
4. Phone and PC must be on the same Wi-Fi.

---

## 10. Switching to Sepolia (final demo)

See [docs/sepolia-setup.md](docs/sepolia-setup.md): free RPC key, a new wallet, test ETH, then deploy with `npx hardhat run scripts/deploy.js --network sepolia` and set `CHAIN_NETWORK=sepolia`.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `password authentication failed for user "postgres"` | Wrong password in `DATABASE_URL` |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL service not running: `Start-Service postgresql-x64-17` |
| `Server selection timed out` (MongoDB) | `Start-Service MongoDB` |
| Health shows blockchain `down` / "No contract code" | Hardhat node was restarted; run the deploy command again, restart the backend, then Admin > Blockchain > *Anchor missing records* |
| AI model shows NOT_TRAINED "trained with scikit-learn X" | Your scikit-learn differs: `pip install scikit-learn==1.9.1`, or retrain: `python training/download_data.py` then `python training/train_adulteration.py` |
| `Too many requests` on login | Login is limited to 10 attempts / 15 min per IP (`LOGIN_RATE_LIMIT`) |
| `npm run db:seed` says database not empty | `npm run db:reset -- --yes` first |
| Port already in use | Close the other window running that service |

---

## 12. Project structure

```
honeychain/
├── backend/            Express API, PostgreSQL migrations, Mongo design, seed, tests
├── frontend/           React app (role dashboards + public verify page), UI tests
├── ai-service/         FastAPI + scikit-learn: models, training scripts, dataset cards, tests
├── blockchain/         HoneyChainAnchor.sol, Hardhat config, deploy script, tests
├── docs/               architecture, ER diagram, schema, API, hashing spec, AI, testing, Sepolia, SQL demos
├── scripts/            start-dev.ps1
└── legacy/flask-prototype/   original prototype (kept for reference)
```

Design documents: [docs/README.md](docs/README.md).

## 13. Credits & data

- Hyperspectral honey adulteration data: Phillips T., Coleman B., Takano S., Abdulla W. (2021), University of Auckland, doi:10.17608/k6.auckland.16441686.v1, **CC BY 4.0**; obtained via the data repository of Ahmed E. (2024), *PLOS Digital Health* 3(6):e0000536.
- Honey composition limits: Codex Alimentarius CXS 12-1981 (Rev. 2001); FSSAI honey standards.
- All people, cooperatives and lab values in the demo seed are **fictional**.
