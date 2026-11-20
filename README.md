# HoneyChain

**AI-assisted honey quality & adulteration analysis with blockchain-based supply-chain traceability.** A DBMS course project.

One web application tracks honey from the beekeeper to the consumer:

```
Beekeeper ──► Laboratory ──► Processor ──► Distributor ──► Consumer (QR code, no login)
 hives          test results    processing     dispatch &       origin, lab, journey,
 harvests       AI support      packaging      delivery         blockchain integrity
 batches        decision
                          Administrator: users, records, anomalies, blockchain
```

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + React Router |
| Backend | Node.js 20+/22 + Express 5 (REST, zod validation, JWT httpOnly cookie, RBAC) |
| Primary DB | PostgreSQL 14+ (17 tables, 11 trigger functions, partial indexes, views) |
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

Expected output ends with `[migrate] 4 new migration(s)` and four `[mongo-init] ... ready` lines.

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

The seed drives the real API: it creates organizations, users, hives, harvests, 7 batches in different lifecycle stages, lab reports, processing, shipments and AI analyses. It anchors 15 records on-chain and runs an anomaly scan. Every row is flagged **DEMO DATA**.

| Role | Email | Password |
|---|---|---|
| Administrator | admin@honeychain.demo | Demo@1234 |
| Laboratory | lab@honeychain.demo | Demo@1234 |
| Processor | processor@honeychain.demo | Demo@1234 |
| Distributor | distributor@honeychain.demo | Demo@1234 |
| Beekeeper | lakshmi@honeychain.demo · ramesh@honeychain.demo · anitha@honeychain.demo | Demo@1234 |

Demo batches:

| Batch | State | Shows |
|---|---|---|
| HC-2026-000001 | DELIVERED | complete journey, 5 anchored records |
| HC-2026-000003 | IN_DISTRIBUTION | shipment in transit |
| HC-2026-000005 | LAB_PASSED | HMF above the FSSAI limit but PASS, so rule **R07** is flagged |
| HC-2026-000006 | IN_TESTING | draft report with 2 hyperspectral scans and real adulteration predictions |
| HC-2026-000004 | LAB_FAILED | failing lab values |
| HC-2026-000002 / 000007 | CREATED | waiting for testing |

Consumer page: **http://localhost:5173/verify/HC-2026-000001**

---

## 7. Five-minute demo script (for the viva)

1. **Consumer:** open `/verify/HC-2026-000001`. It shows origin, harvest, lab values, processing and journey, with every record marked *VERIFIED* against the chain.
2. **Beekeeper** (anitha): register a hive, record a harvest, create 2 batches and assign the lab. Each batch gets a QR code (batch page, then *Download PNG*).
3. **Lab:** Testing queue, then *Enter results*. Save the draft and run the quality analysis: the rule-based screening appears and the ML quality model honestly says *Not trained*. Submit PASS.
4. **Lab** on HC-2026-000006: the adulteration model gives a real prediction from hyperspectral data, with a LOW reliability warning.
5. **Processor**, then **Distributor:** record processing, dispatch, then mark delivered. The batch becomes DELIVERED.
6. **Tamper demo** (shows blockchain value), in a psql window:
   ```powershell
   & "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d honeychain
   ```
   ```sql
   ALTER TABLE lab_reports DISABLE TRIGGER lab_reports_rules;
   UPDATE lab_reports SET moisture_pct = 15.00 WHERE report_code = 'LAB-2026-000001';
   ALTER TABLE lab_reports ENABLE TRIGGER lab_reports_rules;
   ```
   As admin, open Blockchain and click *Verify* on that lab report: the result is **MISMATCH**. The public page shows an integrity warning, and an anomaly scan raises **R10_INTEGRITY**.
7. **Admin:** Anomalies, then *Run scan now*. Rules are listed separately from Isolation Forest, which reports *insufficient data* until 50 genuine batches exist.

---

## 8. Run the tests

```powershell
# Database schema (44 checks, rolls back)
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d honeychain -v ON_ERROR_STOP=1 -o NUL -f backend\db\tests\schema_tests.sql

# Smart contract (8 tests)
cd blockchain; npx hardhat test; cd ..

# AI service (11 tests)
cd ai-service; .\.venv\Scripts\Activate.ps1; python -m pytest -q; deactivate; cd ..

# Backend end-to-end API tests (21 tests; uses a separate database honeychain_test).
# Start the Hardhat node + deploy + AI service first so blockchain/AI tests run instead of being skipped.
cd backend; npm test; cd ..

# Frontend UI tests (40 tests) - need the seeded backend running on :4000
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
