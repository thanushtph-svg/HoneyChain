# 02 — ER Diagram

GitHub and VS Code (with a Mermaid extension) render the diagram below automatically. For the project report, paste the block into <https://mermaid.live> and export PNG/SVG.

## 1. Entity–Relationship diagram (PostgreSQL)

```mermaid
erDiagram
    ROLES ||--o{ USERS : "assigned to"
    ORGANIZATIONS |o--o{ USERS : "employs (lab/processor/distributor staff)"
    USERS ||--o| BEEKEEPERS : "has profile (BEEKEEPER only)"
    BEEKEEPERS ||--o{ HIVES : owns
    HIVES ||--o{ HARVESTS : "yields"
    HARVESTS ||--|{ BATCHES : "split into (once batched)"
    BATCH_STATUSES ||--o{ BATCHES : "current status"
    ORGANIZATIONS |o--o{ BATCHES : "assigned lab"
    BATCHES ||--o{ BATCH_STATUS_HISTORY : "status trail"
    BATCHES ||--o{ LAB_REPORTS : "tested in (max 1 SUBMITTED)"
    ORGANIZATIONS ||--o{ LAB_REPORTS : "laboratory"
    BATCHES ||--o| PROCESSING_RECORDS : "processed once"
    ORGANIZATIONS ||--o{ PROCESSING_RECORDS : processor
    BATCHES ||--o{ SHIPMENTS : "shipped in"
    ORGANIZATIONS ||--o{ SHIPMENTS : distributor
    BATCHES ||--|| QR_RECORDS : "has QR"
    BATCHES ||--o{ BLOCKCHAIN_ANCHORS : "anchored records"
    LAB_REPORTS |o--o{ BLOCKCHAIN_ANCHORS : "anchored as"
    PROCESSING_RECORDS |o--o{ BLOCKCHAIN_ANCHORS : "anchored as"
    SHIPMENTS |o--o{ BLOCKCHAIN_ANCHORS : "anchored as"
    BLOCKCHAIN_ANCHORS ||--o{ VERIFICATION_CHECKS : "checked by"

    ROLES {
        varchar role_code PK
        varchar display_name
    }
    ORGANIZATIONS {
        int org_id PK
        varchar org_code UK
        varchar name
        varchar org_type
        varchar city
        varchar state
    }
    USERS {
        int user_id PK
        varchar email UK
        text password_hash
        varchar full_name
        varchar role_code FK
        int org_id FK
        bool is_active
    }
    BEEKEEPERS {
        int beekeeper_id PK
        int user_id FK,UK
        varchar beekeeper_code UK
        varchar public_display_name
        bool show_name_publicly
        varchar district
        varchar state
    }
    HIVES {
        int hive_id PK
        varchar hive_code UK
        int beekeeper_id FK
        varchar hive_type
        varchar bee_species
        date installed_on
        varchar status
    }
    HARVESTS {
        int harvest_id PK
        varchar harvest_code UK
        int hive_id FK
        date harvest_date
        numeric quantity_kg
        varchar floral_source
    }
    BATCH_STATUSES {
        varchar status_code PK
        smallint stage_order
        bool is_terminal
    }
    BATCHES {
        int batch_id PK
        varchar batch_code UK
        int harvest_id FK
        numeric quantity_kg
        varchar honey_type
        int assigned_lab_id FK
        varchar status FK
    }
    BATCH_STATUS_HISTORY {
        bigint history_id PK
        int batch_id FK
        varchar from_status
        varchar to_status
        int changed_by FK
        timestamptz changed_at
    }
    LAB_REPORTS {
        int lab_report_id PK
        varchar report_code UK
        int batch_id FK
        int lab_org_id FK
        int tested_by FK
        numeric moisture_pct
        numeric hmf_mg_kg
        numeric sucrose_g_100g
        varchar adulteration_result
        varchar report_state
        varchar decision
    }
    PROCESSING_RECORDS {
        int processing_id PK
        varchar processing_code UK
        int batch_id FK,UK
        int processor_org_id FK
        date processing_date
        varchar method
        numeric input_quantity_kg
        numeric output_quantity_kg
        int units_packed
    }
    SHIPMENTS {
        int shipment_id PK
        varchar shipment_code UK
        int batch_id FK
        int distributor_org_id FK
        date dispatch_date
        varchar destination_name
        int units_shipped
        varchar status
    }
    QR_RECORDS {
        int qr_id PK
        int batch_id FK,UK
        text public_url UK
        int scan_count
    }
    BLOCKCHAIN_ANCHORS {
        bigint anchor_id PK
        varchar entity_type
        int batch_id FK
        int lab_report_id FK
        int processing_id FK
        int shipment_id FK
        char record_hash
        char tx_hash UK
        bigint block_number
        varchar status
    }
    VERIFICATION_CHECKS {
        bigint check_id PK
        bigint anchor_id FK
        char recomputed_hash
        char onchain_hash
        varchar result
    }
```

`batch_status_transitions` (allowed from→to pairs) and `mongo_outbox` (retry queue) are support tables and are omitted from the picture for readability.

## 2. Cardinalities in words

| Relationship | Cardinality | Enforced by |
|---|---|---|
| Role → Users | 1 : N | FK `users.role_code` |
| Organization → Users | 1 : N (only staff roles) | FK + CHECK `users_org_matches_role` + trigger (org type matches role) |
| User → Beekeeper profile | 1 : 0..1 | FK `beekeepers.user_id` **UNIQUE** + trigger (user must be BEEKEEPER) |
| Beekeeper → Hives | 1 : N | FK `hives.beekeeper_id` |
| Hive → Harvests | 1 : N | FK `harvests.hive_id` |
| Harvest → Batches | 1 : N, Σ batch kg ≤ harvest kg | FK + trigger with row lock |
| Batch → Lab reports | 1 : N history, **at most 1 SUBMITTED, 1 DRAFT** | partial unique indexes |
| Batch → Processing record | 1 : 0..1 | FK `processing_records.batch_id` **UNIQUE** |
| Batch → Shipments | 1 : N, Σ units shipped ≤ units packed | FK + trigger with row lock |
| Batch → QR record | 1 : 1 | FK `qr_records.batch_id` **UNIQUE** (created in the same transaction as the batch) |
| Record → Blockchain anchors | 1 : N attempts, **1 live per contract** | typed FKs + CHECK + partial unique index |
| Anchor → Verification checks | 1 : N | FK |

## 3. Normalization (to 3NF)

**1NF — atomic values, no repeating groups.**
Each measurement has its own column (`moisture_pct`, `hmf_mg_kg` …). Repeating groups become rows in their own table: many shipments per batch are rows in `shipments`, not `shipment1`, `shipment2` columns. Spectral data (128+ numbers per acquisition) is *not* forced into SQL; it lives in MongoDB (see doc 04).

**2NF — no partial dependency on part of a key.**
Every table has a single-column surrogate primary key, so a partial dependency is impossible.

**3NF — no transitive dependency (non-key → non-key).**
- `batches` stores `harvest_id`, **not** `hive_id` or `beekeeper_id`. Who owns a batch is found by joining `batches → harvests → hives → beekeepers`. Storing `beekeeper_id` in `batches` would be a transitive dependency (batch → harvest → hive → beekeeper) and could become inconsistent.
- `lab_reports` stores `lab_org_id`, not the lab's name or city.
- `users` stores `role_code`, not the role's display name.

**Deliberate, documented exceptions**

| Column | Why it is kept | How consistency is protected |
|---|---|---|
| `batches.status` (derivable from which stage records exist) | Fast queue queries (`WHERE status = 'LAB_PASSED'`) and a clear state machine | Transition table + trigger; every change written to history |
| `qr_records.public_url` (derivable from `batch_code`) | Printed QR labels must keep working if `PUBLIC_BASE_URL` changes later | Written once, UNIQUE |
| `blockchain_anchors.canonical_json` | Shows exactly what was hashed (for viva/debugging) | Write-once evidence; anchors cannot be deleted |
