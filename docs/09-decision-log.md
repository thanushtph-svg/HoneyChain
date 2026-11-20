# 09 — Decision Log

| # | Decision | Reason | Source |
|---|---|---|---|
| D1 | Replace Flask/Jinja with React + Express; move the old code to `legacy/flask-prototype/` | Stack mandated by the master instructions; nothing working is deleted | Master prompt §2, Phase 1 |
| D2 | Remove all IoT/sensor content (temperature, humidity, hive health, "AI + IoT snapshot") | Explicitly out of scope | Final description §4; scope update §6 |
| D3 | Hardhat local by default; Sepolia via `SEPOLIA_RPC_URL` + `DEPLOYER_PRIVATE_KEY` in `.env` | User decision | Scope update §3 |
| D4 | Native Windows + PowerShell; no Docker/WSL | User decision | Scope update §4 |
| D5 | Two separate AI models (quality, adulteration), trained only after dataset validation; otherwise "Not trained — validated labelled dataset required" | User decision; no fabrication | Scope update §1, final description §7 |
| D6 | Adulteration model accepts only spectral inputs; group-aware splits by jar/sample | Prevents modality mixing and data leakage | Scope update §1B |
| D7 | Isolation Forest only above 50 genuine records (`ANOMALY_MIN_RECORDS`); demo data excluded by default | "Insufficient data" safeguard | Scope update §2 |
| D8 | **Honey-yield prediction dropped** | The final project description removed it (it was optional before). Recorded here so it isn't a silent removal | Final description §7 |
| D9 | Only beekeepers self-register; staff accounts are created by admin | Prevents anyone self-registering as a "laboratory" | Security |
| D10 | Lab/processor/distributor modelled as **organizations** with staff users | Lets the public page show the lab's name rather than the staff member's, and lets the DB enforce "tester belongs to the assigned lab" | Privacy + integrity |
| D11 | Batches are assigned to a lab by the beekeeper | Implements "view assigned batches" for labs | Master prompt §3B |
| D12 | Lab report DRAFT → (AI) → SUBMITTED; submitted reports immutable | Matches workflow steps 7–9; makes anchored records stable | Master prompt §4 |
| D13 | Processing records append-only; shipments only change status | Anchored records must not change legitimately | Hashing spec |
| D14 | Business rules duplicated in DB triggers (not only in the API) | Defence in depth; good DBMS demonstration | Master prompt §6 |
| D15 | Raw SQL with `pg` (parameterized), no ORM | Shows the SQL for a DBMS course; prevents injection | DBMS focus |
| D16 | MongoDB native driver with `$jsonSchema` validators (not Mongoose) | Demonstrates NoSQL schema validation in the database itself | DBMS focus |
| D17 | Outbox table for failed MongoDB writes; PENDING anchor rows as the chain queue | Reliable cross-database coordination | Final description §8.3 |
| D18 | Canonical JSON (sorted keys, decimal strings, no personal data) + SHA-256, scheme `hc-v1` | Deterministic, versioned hashing | Final description §9 |
| D19 | QR created automatically with each batch (URL valid from day one; the page shows whichever stages exist) | Simpler for users; the URL never changes | Practicality |
| D20 | JWT in httpOnly SameSite=Strict cookie | XSS/CSRF resistance without extra token plumbing | Security |

| D21 | Quality model left **NOT_TRAINED** | Aykas 2023 has no per-sample data or labels; no fabricated data | Phase 9 investigation |
| D22 | Adulteration label = `Concentration_Class > 0`; dataset's `Adultration` column ignored; pure-syrup rows excluded | That column says "Yes" only at 50 %, contradicting measured concentrations | Dataset inspection |
| D23 | Headline evaluation is leave-one-**product**-out (stricter than jar-grouped) | A new producer's honey is the realistic case; product-level leakage would inflate scores | Scope update §1B |
| D24 | Reliability capped at LOW when fewer than 20 pure jars | 7 pure jars make specificity very uncertain | Honest reporting |
| D25 | Two demo jars held out of the final model | Demo predictions are genuine out-of-sample examples | Honesty |
| D26 | Standards profile FSSAI by default (HMF ≤ 80), Codex selectable | India-based project; values verified against sources | Phase 9 |
| D27 | Only `is_demo` false → true may change on immutable rows | Lets the seed label records as demo after driving the real API | Seed design |
| D28 | Anchor worker guarded by a PostgreSQL advisory lock | Prevents duplicate transactions when the seed and the server run together | Race found in Phase 10 |
| D29 | Re-anchoring refuses records whose hash differs from an earlier confirmed anchor | Stops tampered data being "re-blessed" after a local chain reset | Integrity |
| D30 | Solidity compiled with the bundled `solc` npm package | Works offline and identically on Windows | Build robustness |
| D31 | Frontend calls `/api` through the Vite proxy | Same-origin cookies (SameSite=Strict) without CORS cookie issues | Security |
| D32 | Login rate limit configurable (`LOGIN_RATE_LIMIT`, default 10 / 15 min) | Production stays strict; long demos/tests can raise it | Usability |
| D33 | Automated tests use an in-memory MongoDB test double when no server exists | The build machine could not install MongoDB; real-MongoDB check documented in `docs/testing.md` | Environment |

## Open items for later phases

| Item | Phase |
|---|---|
| ~~Verify Codex/FSSAI limits~~ | done (D26) |
| ~~Inspect datasets~~ | done (D21–D25) |
| ~~Sepolia walkthrough~~ | done: `docs/sepolia-setup.md` |
| ~~Index evidence~~ | done: `docs/sql/demo_queries.sql` Q12 |
| Run the backend tests once against real MongoDB on Windows | user, see `docs/testing.md` §2 |
