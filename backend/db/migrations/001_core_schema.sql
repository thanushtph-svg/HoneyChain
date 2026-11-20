-- =====================================================================
-- HoneyChain - Migration 001: core relational schema
-- PostgreSQL 14+ (tested on 16)
--
-- PostgreSQL is the AUTHORITATIVE store for every supply-chain record.
-- Conventions
--   * Every table has a surrogate integer primary key (xxx_id).
--   * Human-readable codes (HC-2026-000001 ...) are separate UNIQUE columns,
--     generated from sequences. Codes are what QR codes, the UI and the
--     blockchain hash use; integer ids are what foreign keys use.
--   * Enumerations are VARCHAR + CHECK (easy to read in a viva, easy to change).
--   * Quantities use NUMERIC (exact decimals) - never FLOAT for money/mass.
--   * is_demo = TRUE marks seed/demo rows so they are always identifiable.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Code sequences (human-readable identifiers)
-- ---------------------------------------------------------------------
CREATE SEQUENCE beekeeper_code_seq;
CREATE SEQUENCE hive_code_seq;
CREATE SEQUENCE harvest_code_seq;
CREATE SEQUENCE batch_code_seq;
CREATE SEQUENCE lab_report_code_seq;
CREATE SEQUENCE processing_code_seq;
CREATE SEQUENCE shipment_code_seq;
CREATE SEQUENCE org_code_seq;

-- ---------------------------------------------------------------------
-- 1. roles  (small lookup table; natural key)
-- ---------------------------------------------------------------------
CREATE TABLE roles (
    role_code     VARCHAR(20)  PRIMARY KEY
                  CHECK (role_code IN ('ADMIN','BEEKEEPER','LAB','PROCESSOR','DISTRIBUTOR')),
    display_name  VARCHAR(50)  NOT NULL,
    description   TEXT
);

INSERT INTO roles (role_code, display_name, description) VALUES
 ('ADMIN',       'Administrator',     'Manages users, reviews alerts, inspects blockchain verification'),
 ('BEEKEEPER',   'Beekeeper',         'Registers hives, records harvests, creates batches'),
 ('LAB',         'Laboratory Staff',  'Enters laboratory results and decisions'),
 ('PROCESSOR',   'Processor',         'Records processing and packaging'),
 ('DISTRIBUTOR', 'Distributor',       'Records dispatch, shipment and delivery');

-- ---------------------------------------------------------------------
-- 2. organizations  (laboratories, processing units, distributors)
-- ---------------------------------------------------------------------
CREATE TABLE organizations (
    org_id            SERIAL       PRIMARY KEY,
    org_code          VARCHAR(20)  NOT NULL UNIQUE
                      DEFAULT ('ORG-' || lpad(nextval('org_code_seq')::text, 4, '0')),
    name              VARCHAR(150) NOT NULL,
    org_type          VARCHAR(20)  NOT NULL
                      CHECK (org_type IN ('LABORATORY','PROCESSOR','DISTRIBUTOR')),
    city              VARCHAR(80)  NOT NULL,
    state             VARCHAR(80)  NOT NULL,
    accreditation_no  VARCHAR(60),                 -- e.g. NABL certificate no. (labs)
    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    is_demo           BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (name, org_type)
);

-- ---------------------------------------------------------------------
-- 3. users  (one login per person; role decides permissions)
-- ---------------------------------------------------------------------
CREATE TABLE users (
    user_id        SERIAL       PRIMARY KEY,
    email          VARCHAR(255) NOT NULL
                   CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    password_hash  TEXT         NOT NULL,           -- bcrypt hash, never the password
    full_name      VARCHAR(120) NOT NULL,
    phone          VARCHAR(20),
    role_code      VARCHAR(20)  NOT NULL REFERENCES roles(role_code),
    org_id         INT          REFERENCES organizations(org_id),
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    is_demo        BOOLEAN      NOT NULL DEFAULT FALSE,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Lab / processor / distributor staff MUST belong to an organization;
    -- admins and beekeepers MUST NOT.
    CONSTRAINT users_org_matches_role CHECK (
        (role_code IN ('LAB','PROCESSOR','DISTRIBUTOR')) = (org_id IS NOT NULL)
    )
);
-- Case-insensitive uniqueness: "A@x.com" and "a@x.com" are the same account.
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- ---------------------------------------------------------------------
-- 4. beekeepers  (1:1 profile extension of a BEEKEEPER user)
-- ---------------------------------------------------------------------
CREATE TABLE beekeepers (
    beekeeper_id         SERIAL       PRIMARY KEY,
    user_id              INT          NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE RESTRICT,
    beekeeper_code       VARCHAR(20)  NOT NULL UNIQUE
                         DEFAULT ('BK-' || lpad(nextval('beekeeper_code_seq')::text, 5, '0')),
    public_display_name  VARCHAR(120) NOT NULL,     -- what consumers may see
    show_name_publicly   BOOLEAN      NOT NULL DEFAULT FALSE,  -- consent flag
    cooperative_name     VARCHAR(150),
    village              VARCHAR(80),
    district             VARCHAR(80)  NOT NULL,
    state                VARCHAR(80)  NOT NULL,
    registration_no      VARCHAR(60),               -- e.g. NBB / KVIC registration, optional
    is_demo              BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 5. hives  (1 beekeeper : N hives)   - no sensors, no telemetry
-- ---------------------------------------------------------------------
CREATE TABLE hives (
    hive_id          SERIAL       PRIMARY KEY,
    hive_code        VARCHAR(20)  NOT NULL UNIQUE
                     DEFAULT ('HIVE-' || lpad(nextval('hive_code_seq')::text, 6, '0')),
    beekeeper_id     INT          NOT NULL REFERENCES beekeepers(beekeeper_id) ON DELETE RESTRICT,
    hive_type        VARCHAR(20)  NOT NULL
                     CHECK (hive_type IN ('LANGSTROTH','NEWTON','TOP_BAR','TRADITIONAL','OTHER')),
    bee_species      VARCHAR(60)  NOT NULL,         -- e.g. Apis cerana indica
    apiary_location  VARCHAR(150) NOT NULL,         -- free text, entered by beekeeper
    district         VARCHAR(80)  NOT NULL,
    state            VARCHAR(80)  NOT NULL,
    installed_on     DATE         NOT NULL CHECK (installed_on <= CURRENT_DATE),
    status           VARCHAR(10)  NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','INACTIVE')),
    is_demo          BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 6. harvests  (1 hive : N harvests)
-- ---------------------------------------------------------------------
CREATE TABLE harvests (
    harvest_id     SERIAL         PRIMARY KEY,
    harvest_code   VARCHAR(20)    NOT NULL UNIQUE
                   DEFAULT ('HRV-' || to_char(CURRENT_DATE,'YYYY') || '-'
                            || lpad(nextval('harvest_code_seq')::text, 6, '0')),
    hive_id        INT            NOT NULL REFERENCES hives(hive_id) ON DELETE RESTRICT,
    harvest_date   DATE           NOT NULL CHECK (harvest_date <= CURRENT_DATE),
    quantity_kg    NUMERIC(10,2)  NOT NULL CHECK (quantity_kg > 0 AND quantity_kg <= 500),
    floral_source  VARCHAR(100)   NOT NULL,         -- e.g. Multifloral, Eucalyptus, Jamun
    notes          TEXT,
    recorded_by    INT            NOT NULL REFERENCES users(user_id),
    is_demo        BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 7. batches  (1 harvest : N batches)  - the unit that gets a QR code
-- ---------------------------------------------------------------------
CREATE TABLE batch_statuses (            -- lookup table for the lifecycle
    status_code  VARCHAR(20) PRIMARY KEY,
    stage_order  SMALLINT    NOT NULL UNIQUE,
    is_terminal  BOOLEAN     NOT NULL DEFAULT FALSE,
    description  TEXT        NOT NULL
);
INSERT INTO batch_statuses VALUES
 ('CREATED',         1, FALSE, 'Batch created from a harvest; not yet tested'),
 ('IN_TESTING',      2, FALSE, 'A laboratory has opened a draft report'),
 ('LAB_PASSED',      3, FALSE, 'Laboratory submitted a PASS decision'),
 ('LAB_FAILED',      4, TRUE,  'Laboratory submitted a FAIL decision (terminal)'),
 ('PROCESSED',       5, FALSE, 'Processing and packaging recorded'),
 ('IN_DISTRIBUTION', 6, FALSE, 'At least one shipment dispatched'),
 ('DELIVERED',       7, TRUE,  'All packed units shipped and every shipment delivered');

-- Which status changes are legal. The trigger in migration 002 consults this.
CREATE TABLE batch_status_transitions (
    from_status  VARCHAR(20) NOT NULL REFERENCES batch_statuses(status_code),
    to_status    VARCHAR(20) NOT NULL REFERENCES batch_statuses(status_code),
    PRIMARY KEY (from_status, to_status),
    CHECK (from_status <> to_status)
);
INSERT INTO batch_status_transitions VALUES
 ('CREATED',         'IN_TESTING'),
 ('IN_TESTING',      'LAB_PASSED'),
 ('IN_TESTING',      'LAB_FAILED'),
 ('LAB_PASSED',      'PROCESSED'),
 ('PROCESSED',       'IN_DISTRIBUTION'),
 ('IN_DISTRIBUTION', 'DELIVERED');

CREATE TABLE batches (
    batch_id         SERIAL         PRIMARY KEY,
    batch_code       VARCHAR(20)    NOT NULL UNIQUE
                     DEFAULT ('HC-' || to_char(CURRENT_DATE,'YYYY') || '-'
                              || lpad(nextval('batch_code_seq')::text, 6, '0')),
    harvest_id       INT            NOT NULL REFERENCES harvests(harvest_id) ON DELETE RESTRICT,
    quantity_kg      NUMERIC(10,2)  NOT NULL CHECK (quantity_kg > 0),
    honey_type       VARCHAR(80)    NOT NULL,
    assigned_lab_id  INT            REFERENCES organizations(org_id),  -- set when sent for testing
    status           VARCHAR(20)    NOT NULL DEFAULT 'CREATED'
                     REFERENCES batch_statuses(status_code),
    created_by       INT            NOT NULL REFERENCES users(user_id),
    is_demo          BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- Audit trail of every status change (written by trigger, never by hand)
CREATE TABLE batch_status_history (
    history_id   BIGSERIAL    PRIMARY KEY,
    batch_id     INT          NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
    from_status  VARCHAR(20)  REFERENCES batch_statuses(status_code),
    to_status    VARCHAR(20)  NOT NULL REFERENCES batch_statuses(status_code),
    changed_by   INT          REFERENCES users(user_id),
    changed_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 8. lab_reports  (1 batch : N reports over time, at most 1 SUBMITTED)
--    Measurement columns follow common honey test parameters (Codex Stan
--    12-1981 style). All optional except moisture/HMF/sucrose, because a
--    lab only records what it actually tested.
-- ---------------------------------------------------------------------
CREATE TABLE lab_reports (
    lab_report_id          SERIAL        PRIMARY KEY,
    report_code            VARCHAR(20)   NOT NULL UNIQUE
                           DEFAULT ('LAB-' || to_char(CURRENT_DATE,'YYYY') || '-'
                                    || lpad(nextval('lab_report_code_seq')::text, 6, '0')),
    batch_id               INT           NOT NULL REFERENCES batches(batch_id) ON DELETE RESTRICT,
    lab_org_id             INT           NOT NULL REFERENCES organizations(org_id),
    tested_by              INT           NOT NULL REFERENCES users(user_id),
    sample_code            VARCHAR(40)   NOT NULL,
    received_on            DATE          NOT NULL,
    tested_on              DATE          NOT NULL CHECK (tested_on <= CURRENT_DATE),

    -- core measurements (required)
    moisture_pct           NUMERIC(5,2)  NOT NULL CHECK (moisture_pct  BETWEEN 0 AND 100),
    hmf_mg_kg              NUMERIC(7,2)  NOT NULL CHECK (hmf_mg_kg >= 0),
    sucrose_g_100g         NUMERIC(5,2)  NOT NULL CHECK (sucrose_g_100g BETWEEN 0 AND 100),
    -- optional measurements (only if the lab ran the test)
    glucose_g_100g         NUMERIC(5,2)  CHECK (glucose_g_100g  BETWEEN 0 AND 100),
    fructose_g_100g        NUMERIC(5,2)  CHECK (fructose_g_100g BETWEEN 0 AND 100),
    brix                   NUMERIC(5,2)  CHECK (brix BETWEEN 0 AND 100),
    ph                     NUMERIC(4,2)  CHECK (ph BETWEEN 0 AND 14),
    free_acidity_meq_kg    NUMERIC(6,2)  CHECK (free_acidity_meq_kg >= 0),
    water_activity         NUMERIC(4,3)  CHECK (water_activity BETWEEN 0 AND 1),
    electrical_conductivity_ms_cm NUMERIC(6,3) CHECK (electrical_conductivity_ms_cm >= 0),

    pollen_identification  TEXT          NOT NULL,          -- as written on the lab report
    adulteration_method    VARCHAR(100),                    -- e.g. "C4 sugar (SCIRA)", "NMR"
    adulteration_result    VARCHAR(15)   NOT NULL DEFAULT 'NOT_TESTED'
                           CHECK (adulteration_result IN ('NOT_DETECTED','DETECTED','INCONCLUSIVE','NOT_TESTED')),

    report_state           VARCHAR(10)   NOT NULL DEFAULT 'DRAFT'
                           CHECK (report_state IN ('DRAFT','SUBMITTED')),
    decision               VARCHAR(4)    CHECK (decision IN ('PASS','FAIL')),   -- the LAB's decision
    decision_remarks       TEXT,
    submitted_at           TIMESTAMPTZ,

    is_demo                BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT lab_dates_ordered   CHECK (tested_on >= received_on),
    CONSTRAINT lab_submit_complete CHECK (
        (report_state = 'SUBMITTED') = (decision IS NOT NULL AND submitted_at IS NOT NULL)
    ),
    CONSTRAINT lab_method_if_tested CHECK (
        adulteration_result = 'NOT_TESTED' OR adulteration_method IS NOT NULL
    ),
    UNIQUE (lab_org_id, sample_code)
);
-- At most ONE submitted report and ONE open draft per batch (partial unique indexes)
CREATE UNIQUE INDEX lab_reports_one_submitted_uq ON lab_reports (batch_id) WHERE report_state = 'SUBMITTED';
CREATE UNIQUE INDEX lab_reports_one_draft_uq     ON lab_reports (batch_id) WHERE report_state = 'DRAFT';

-- ---------------------------------------------------------------------
-- 9. processing_records  (1 batch : 0..1 processing record)
-- ---------------------------------------------------------------------
CREATE TABLE processing_records (
    processing_id       SERIAL         PRIMARY KEY,
    processing_code     VARCHAR(20)    NOT NULL UNIQUE
                        DEFAULT ('PRC-' || to_char(CURRENT_DATE,'YYYY') || '-'
                                 || lpad(nextval('processing_code_seq')::text, 6, '0')),
    batch_id            INT            NOT NULL UNIQUE REFERENCES batches(batch_id) ON DELETE RESTRICT,
    processor_org_id    INT            NOT NULL REFERENCES organizations(org_id),
    recorded_by         INT            NOT NULL REFERENCES users(user_id),
    processing_date     DATE           NOT NULL CHECK (processing_date <= CURRENT_DATE),
    method              VARCHAR(20)    NOT NULL
                        CHECK (method IN ('FILTRATION','STRAINING','SETTLING','GENTLE_WARMING','CREAMING','OTHER')),
    method_details      TEXT,
    operator_name       VARCHAR(120)   NOT NULL,
    operator_staff_id   VARCHAR(40),
    input_quantity_kg   NUMERIC(10,2)  NOT NULL CHECK (input_quantity_kg  > 0),
    output_quantity_kg  NUMERIC(10,2)  NOT NULL CHECK (output_quantity_kg > 0),
    packaging_date      DATE           NOT NULL,
    packaging_type      VARCHAR(20)    NOT NULL
                        CHECK (packaging_type IN ('GLASS_JAR','PET_JAR','SACHET','TIN','BULK_DRUM','OTHER')),
    unit_size_g         INT            NOT NULL CHECK (unit_size_g > 0),
    units_packed        INT            NOT NULL CHECK (units_packed > 0),
    best_before         DATE           NOT NULL,
    is_demo             BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT proc_output_le_input   CHECK (output_quantity_kg <= input_quantity_kg),
    CONSTRAINT proc_packed_le_output  CHECK (units_packed * unit_size_g <= output_quantity_kg * 1000),
    CONSTRAINT proc_dates_ordered     CHECK (packaging_date >= processing_date AND best_before > packaging_date)
);

-- ---------------------------------------------------------------------
-- 10. shipments  (1 batch : N shipments; distribution journey)
-- ---------------------------------------------------------------------
CREATE TABLE shipments (
    shipment_id            SERIAL        PRIMARY KEY,
    shipment_code          VARCHAR(20)   NOT NULL UNIQUE
                           DEFAULT ('SHP-' || to_char(CURRENT_DATE,'YYYY') || '-'
                                    || lpad(nextval('shipment_code_seq')::text, 6, '0')),
    batch_id               INT           NOT NULL REFERENCES batches(batch_id) ON DELETE RESTRICT,
    distributor_org_id     INT           NOT NULL REFERENCES organizations(org_id),
    recorded_by            INT           NOT NULL REFERENCES users(user_id),
    dispatch_date          DATE          NOT NULL CHECK (dispatch_date <= CURRENT_DATE),
    origin_location        VARCHAR(150)  NOT NULL,
    destination_name       VARCHAR(150)  NOT NULL,
    destination_type       VARCHAR(15)   NOT NULL
                           CHECK (destination_type IN ('WAREHOUSE','DISTRIBUTOR','RETAILER','INSTITUTION','OTHER')),
    destination_city       VARCHAR(80)   NOT NULL,
    destination_state      VARCHAR(80)   NOT NULL,
    carrier_name           VARCHAR(120),
    tracking_reference     VARCHAR(60),   -- vehicle no. / docket no. (entered manually)
    units_shipped          INT           NOT NULL CHECK (units_shipped > 0),
    status                 VARCHAR(12)   NOT NULL DEFAULT 'DISPATCHED'
                           CHECK (status IN ('DISPATCHED','IN_TRANSIT','DELIVERED','CANCELLED')),
    delivered_on           DATE,
    is_demo                BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT ship_delivered_has_date CHECK ((status = 'DELIVERED') = (delivered_on IS NOT NULL)),
    CONSTRAINT ship_dates_ordered      CHECK (delivered_on IS NULL OR delivered_on >= dispatch_date)
);

-- ---------------------------------------------------------------------
-- 11. qr_records  (1 batch : 1 QR record)
--     public_url is stored (not derived) because printed QR codes must keep
--     working even if PUBLIC_BASE_URL changes later - a justified exception
--     to "don't store derivable data".
-- ---------------------------------------------------------------------
CREATE TABLE qr_records (
    qr_id            SERIAL       PRIMARY KEY,
    batch_id         INT          NOT NULL UNIQUE REFERENCES batches(batch_id) ON DELETE CASCADE,
    public_url       TEXT         NOT NULL UNIQUE,
    generated_by     INT          REFERENCES users(user_id),
    generated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    scan_count       INT          NOT NULL DEFAULT 0 CHECK (scan_count >= 0),
    last_scanned_at  TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- 12. blockchain_anchors
--     One row per attempt to anchor one record. Instead of a polymorphic
--     "entity_id" with no FK, each anchorable entity has its own nullable FK
--     and a CHECK guarantees exactly the right one is filled in.
-- ---------------------------------------------------------------------
CREATE TABLE blockchain_anchors (
    anchor_id         BIGSERIAL    PRIMARY KEY,
    entity_type       VARCHAR(20)  NOT NULL
                      CHECK (entity_type IN ('BATCH_ORIGIN','LAB_REPORT','PROCESSING_RECORD','SHIPMENT')),
    batch_id          INT          NOT NULL REFERENCES batches(batch_id) ON DELETE RESTRICT,
    lab_report_id     INT          REFERENCES lab_reports(lab_report_id) ON DELETE RESTRICT,
    processing_id     INT          REFERENCES processing_records(processing_id) ON DELETE RESTRICT,
    shipment_id       INT          REFERENCES shipments(shipment_id) ON DELETE RESTRICT,

    hash_scheme       VARCHAR(10)  NOT NULL DEFAULT 'hc-v1',
    record_key        CHAR(66)     NOT NULL CHECK (record_key  ~ '^0x[0-9a-f]{64}$'),
    record_hash       CHAR(66)     NOT NULL CHECK (record_hash ~ '^0x[0-9a-f]{64}$'),
    canonical_json    TEXT         NOT NULL,   -- exact string that was hashed (for explanation/debug)

    network           VARCHAR(10)  NOT NULL CHECK (network IN ('hardhat','sepolia')),
    chain_id          INT          NOT NULL,
    contract_address  CHAR(42)     NOT NULL CHECK (contract_address ~ '^0x[0-9a-fA-F]{40}$'),

    status            VARCHAR(10)  NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','SUBMITTED','CONFIRMED','FAILED')),
    tx_hash           CHAR(66)     UNIQUE CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    block_number      BIGINT       CHECK (block_number >= 0),
    block_timestamp   TIMESTAMPTZ,
    attempts          SMALLINT     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    failure_reason    TEXT,
    anchored_by       INT          REFERENCES users(user_id),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    confirmed_at      TIMESTAMPTZ,

    -- the right FK for the right entity type
    CONSTRAINT anchor_entity_fk_matches CHECK (
        (entity_type = 'BATCH_ORIGIN'      AND num_nonnulls(lab_report_id, processing_id, shipment_id) = 0) OR
        (entity_type = 'LAB_REPORT'        AND lab_report_id IS NOT NULL AND num_nonnulls(processing_id, shipment_id) = 0) OR
        (entity_type = 'PROCESSING_RECORD' AND processing_id IS NOT NULL AND num_nonnulls(lab_report_id, shipment_id) = 0) OR
        (entity_type = 'SHIPMENT'          AND shipment_id   IS NOT NULL AND num_nonnulls(lab_report_id, processing_id) = 0)
    ),
    -- "CONFIRMED" is impossible without a real transaction hash and block number
    CONSTRAINT anchor_confirmed_has_tx CHECK (
        status <> 'CONFIRMED' OR (tx_hash IS NOT NULL AND block_number IS NOT NULL AND confirmed_at IS NOT NULL)
    ),
    CONSTRAINT anchor_submitted_has_tx CHECK (status <> 'SUBMITTED' OR tx_hash IS NOT NULL)
);
-- Only one live (non-failed) anchor per record per deployed contract
CREATE UNIQUE INDEX anchors_one_live_per_record_uq
    ON blockchain_anchors (record_key, chain_id, contract_address)
    WHERE status IN ('PENDING','SUBMITTED','CONFIRMED');

-- ---------------------------------------------------------------------
-- 13. verification_checks  (1 anchor : N checks over time)
-- ---------------------------------------------------------------------
CREATE TABLE verification_checks (
    check_id         BIGSERIAL    PRIMARY KEY,
    anchor_id        BIGINT       NOT NULL REFERENCES blockchain_anchors(anchor_id) ON DELETE CASCADE,
    recomputed_hash  CHAR(66)     NOT NULL CHECK (recomputed_hash ~ '^0x[0-9a-f]{64}$'),
    onchain_hash     CHAR(66)     CHECK (onchain_hash ~ '^0x[0-9a-f]{64}$'),
    result           VARCHAR(20)  NOT NULL
                     CHECK (result IN ('VERIFIED','MISMATCH','NOT_FOUND_ON_CHAIN','CHAIN_UNAVAILABLE')),
    trigger_source   VARCHAR(12)  NOT NULL CHECK (trigger_source IN ('ADMIN','PUBLIC_PAGE','SCHEDULED')),
    checked_by       INT          REFERENCES users(user_id),   -- NULL for public/scheduled checks
    checked_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT verify_result_consistent CHECK (
        (result = 'VERIFIED' AND onchain_hash IS NOT NULL AND onchain_hash =  recomputed_hash) OR
        (result = 'MISMATCH' AND onchain_hash IS NOT NULL AND onchain_hash <> recomputed_hash) OR
        (result IN ('NOT_FOUND_ON_CHAIN','CHAIN_UNAVAILABLE') AND onchain_hash IS NULL)
    )
);

-- ---------------------------------------------------------------------
-- 14. mongo_outbox  (cross-database reliability; see docs/04)
--     If a MongoDB write fails after the PostgreSQL commit, the document is
--     parked here and a retry worker replays it.
-- ---------------------------------------------------------------------
CREATE TABLE mongo_outbox (
    outbox_id        BIGSERIAL    PRIMARY KEY,
    target_collection VARCHAR(40) NOT NULL
                      CHECK (target_collection IN ('activity_logs','ai_analysis_results','anomaly_reports','spectral_scans')),
    operation        VARCHAR(10)  NOT NULL CHECK (operation IN ('INSERT','UPDATE')),
    payload          JSONB        NOT NULL,
    status           VARCHAR(10)  NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','DONE','DEAD')),
    attempts         SMALLINT     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error       TEXT,
    next_attempt_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMIT;
