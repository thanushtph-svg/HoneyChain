-- =====================================================================
-- HoneyChain - Migration 005: six roles, custody transfers, corrected workflow
--
-- 1. Roles become exactly: BEEKEEPER, PROCESSOR, LAB_TESTER, DISTRIBUTOR, ADMIN, CONSUMER
--    (LAB is renamed to LAB_TESTER; CONSUMER is new and has no organization).
-- 2. The workflow order becomes
--      Beekeeper -> Processor -> Laboratory -> (processor) -> Distributor -> Consumer
--    and every hand-over is an explicit custody TRANSFER that the receiver must
--    ACCEPT or REJECT (with a recorded reason).
-- 3. The laboratory receives TESTING REQUESTS (accept / reject), may decide
--    PASS / FAIL / INCONCLUSIVE, can attach documents, and submitted results can
--    only be changed through an AUDITED CORRECTION approved by an administrator
--    (the old report is kept as SUPERSEDED, a new report is created and anchored).
-- 4. Consumer verification history, application settings, and a role-change audit table.
--
-- All new rules are enforced by triggers as well as by the API.
-- Existing rows are preserved; legacy batches keep their status.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------
ALTER TABLE roles DROP CONSTRAINT roles_role_code_check;
ALTER TABLE users DROP CONSTRAINT users_org_matches_role;

INSERT INTO roles (role_code, display_name, description) VALUES
 ('LAB_TESTER', 'Lab Tester', 'Accepts testing requests, records laboratory measurements and decisions'),
 ('CONSUMER',   'Consumer',   'Verifies honey products by QR code; optional account keeps a verification history')
ON CONFLICT (role_code) DO NOTHING;

UPDATE roles SET display_name = 'Administrator',
       description = 'Manages users, roles, organizations and settings; monitors the platform; approves audited corrections'
 WHERE role_code = 'ADMIN';
UPDATE roles SET description = 'Registers hives, records harvests, creates batches and transfers them to a processor'
 WHERE role_code = 'BEEKEEPER';
UPDATE roles SET description = 'Accepts incoming batches, records processing, requests laboratory testing, transfers to distributors'
 WHERE role_code = 'PROCESSOR';
UPDATE roles SET description = 'Accepts processed batches, records shipments and deliveries'
 WHERE role_code = 'DISTRIBUTOR';

-- Org-type rule now refers to LAB_TESTER (must be replaced BEFORE users are updated)
CREATE OR REPLACE FUNCTION trg_users_org_type() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_type TEXT;
BEGIN
    IF NEW.org_id IS NULL THEN RETURN NEW; END IF;
    SELECT org_type INTO v_type FROM organizations WHERE org_id = NEW.org_id;
    IF (NEW.role_code = 'LAB_TESTER'  AND v_type <> 'LABORATORY') OR
       (NEW.role_code = 'PROCESSOR'   AND v_type <> 'PROCESSOR')  OR
       (NEW.role_code = 'DISTRIBUTOR' AND v_type <> 'DISTRIBUTOR') THEN
        PERFORM hc_raise('ORG_ROLE_MISMATCH',
            format('role %s cannot belong to an organization of type %s', NEW.role_code, v_type));
    END IF;
    RETURN NEW;
END $$;

-- Audit table for role / organization changes (written by trigger)
CREATE TABLE user_role_changes (
    change_id    BIGSERIAL    PRIMARY KEY,
    user_id      INT          NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    old_role     VARCHAR(20),
    new_role     VARCHAR(20)  NOT NULL,
    old_org_id   INT,
    new_org_id   INT,
    changed_by   INT          REFERENCES users(user_id),
    changed_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX user_role_changes_user_idx ON user_role_changes (user_id, changed_at DESC);

CREATE OR REPLACE FUNCTION trg_users_role_audit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.role_code, NEW.org_id) IS DISTINCT FROM (OLD.role_code, OLD.org_id) THEN
        INSERT INTO user_role_changes (user_id, old_role, new_role, old_org_id, new_org_id, changed_by)
        VALUES (NEW.user_id, OLD.role_code, NEW.role_code, OLD.org_id, NEW.org_id, app_current_user_id());
    END IF;
    RETURN NEW;
END $$;

UPDATE users SET role_code = 'LAB_TESTER' WHERE role_code = 'LAB';
DELETE FROM roles WHERE role_code = 'LAB';

CREATE TRIGGER users_role_audit AFTER UPDATE OF role_code, org_id ON users
    FOR EACH ROW EXECUTE FUNCTION trg_users_role_audit();

ALTER TABLE roles ADD CONSTRAINT roles_role_code_check
    CHECK (role_code IN ('BEEKEEPER','PROCESSOR','LAB_TESTER','DISTRIBUTOR','ADMIN','CONSUMER'));
ALTER TABLE users ADD CONSTRAINT users_org_matches_role
    CHECK ((role_code IN ('LAB_TESTER','PROCESSOR','DISTRIBUTOR')) = (org_id IS NOT NULL));

-- ---------------------------------------------------------------------
-- 2. Batch lifecycle (new order)
-- ---------------------------------------------------------------------
-- move existing stage numbers out of the way (stage_order is UNIQUE)
UPDATE batch_statuses SET stage_order = stage_order + 100;
INSERT INTO batch_statuses (status_code, stage_order, is_terminal, description) VALUES
 ('PENDING_PROCESSOR',   202, FALSE, 'Transferred by the beekeeper; waiting for the processor to accept or reject'),
 ('IN_PROCESSING',       203, FALSE, 'Accepted by the processor; processing in progress'),
 ('PENDING_LAB',         205, FALSE, 'Testing requested; waiting for the laboratory to accept or reject'),
 ('LAB_INCONCLUSIVE',    209, FALSE, 'Laboratory result inconclusive; the processor may request a re-test'),
 ('PENDING_DISTRIBUTOR', 210, FALSE, 'Transferred by the processor; waiting for the distributor to accept or reject')
ON CONFLICT (status_code) DO NOTHING;

UPDATE batch_statuses s SET stage_order = v.ord, is_terminal = v.term, description = v.descr
  FROM (VALUES
    ('CREATED',              1, FALSE, 'Batch created from a harvest; in the beekeeper''s custody'),
    ('PENDING_PROCESSOR',    2, FALSE, 'Transferred by the beekeeper; waiting for the processor to accept or reject'),
    ('IN_PROCESSING',        3, FALSE, 'Accepted by the processor; processing in progress'),
    ('PROCESSED',            4, FALSE, 'Processing and packaging recorded; ready for laboratory testing'),
    ('PENDING_LAB',          5, FALSE, 'Testing requested; waiting for the laboratory to accept or reject'),
    ('IN_TESTING',           6, FALSE, 'Laboratory accepted the testing request'),
    ('LAB_PASSED',           7, FALSE, 'Laboratory submitted a PASS decision; eligible for distribution'),
    ('LAB_FAILED',           8, TRUE,  'Laboratory submitted a FAIL decision (terminal)'),
    ('LAB_INCONCLUSIVE',     9, FALSE, 'Laboratory result inconclusive; the processor may request a re-test'),
    ('PENDING_DISTRIBUTOR', 10, FALSE, 'Transferred by the processor; waiting for the distributor to accept or reject'),
    ('IN_DISTRIBUTION',     11, FALSE, 'Accepted by the distributor; shipments may be recorded'),
    ('DELIVERED',           12, TRUE,  'All packed units shipped and every shipment delivered')
  ) AS v(code, ord, term, descr)
 WHERE s.status_code = v.code;

DELETE FROM batch_status_transitions;
INSERT INTO batch_status_transitions (from_status, to_status) VALUES
 ('CREATED',             'PENDING_PROCESSOR'),
 ('PENDING_PROCESSOR',   'CREATED'),            -- rejected / cancelled
 ('PENDING_PROCESSOR',   'IN_PROCESSING'),      -- accepted
 ('IN_PROCESSING',       'PROCESSED'),
 ('PROCESSED',           'PENDING_LAB'),
 ('PENDING_LAB',         'PROCESSED'),          -- rejected / cancelled (first request)
 ('PENDING_LAB',         'LAB_INCONCLUSIVE'),   -- rejected / cancelled (re-test request)
 ('PENDING_LAB',         'IN_TESTING'),         -- accepted
 ('IN_TESTING',          'LAB_PASSED'),
 ('IN_TESTING',          'LAB_FAILED'),
 ('IN_TESTING',          'LAB_INCONCLUSIVE'),
 ('LAB_INCONCLUSIVE',    'PENDING_LAB'),        -- re-test
 ('LAB_PASSED',          'PENDING_DISTRIBUTOR'),
 ('PENDING_DISTRIBUTOR', 'LAB_PASSED'),         -- rejected / cancelled
 ('PENDING_DISTRIBUTOR', 'IN_DISTRIBUTION'),    -- accepted
 ('IN_DISTRIBUTION',     'DELIVERED'),
 -- only through an approved, audited lab correction (guarded in trg_batch_status)
 ('LAB_PASSED',          'LAB_FAILED'),
 ('LAB_PASSED',          'LAB_INCONCLUSIVE'),
 ('LAB_FAILED',          'LAB_PASSED'),
 ('LAB_FAILED',          'LAB_INCONCLUSIVE'),
 ('LAB_INCONCLUSIVE',    'LAB_PASSED'),
 ('LAB_INCONCLUSIVE',    'LAB_FAILED');

CREATE OR REPLACE FUNCTION trg_batch_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.status = OLD.status THEN RETURN NEW; END IF;
        IF NOT EXISTS (SELECT 1 FROM batch_status_transitions
                       WHERE from_status = OLD.status AND to_status = NEW.status) THEN
            PERFORM hc_raise('INVALID_TRANSITION',
                format('batch %s cannot move from %s to %s', OLD.batch_code, OLD.status, NEW.status));
        END IF;
        -- a lab result can only change after submission through an approved correction
        IF OLD.status IN ('LAB_PASSED','LAB_FAILED','LAB_INCONCLUSIVE')
           AND NEW.status IN ('LAB_PASSED','LAB_FAILED','LAB_INCONCLUSIVE')
           AND NULLIF(current_setting('app.lab_correction', true), '') IS NULL THEN
            PERFORM hc_raise('CORRECTION_REQUIRED',
                format('batch %s lab result can only change through an approved lab correction', OLD.batch_code));
        END IF;
    END IF;
    INSERT INTO batch_status_history (batch_id, from_status, to_status, changed_by)
    VALUES (NEW.batch_id,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
            NEW.status,
            app_current_user_id());
    RETURN NEW;
END $$;

-- The beekeeper no longer assigns a laboratory; the processor sends testing requests.
-- assigned_lab_id is kept for legacy rows only and is no longer written by the API.
DROP TRIGGER batches_assigned_lab ON batches;
DROP INDEX IF EXISTS batches_lab_queue_idx;

-- ---------------------------------------------------------------------
-- 3. Custody transfers  (beekeeper -> processor, processor -> distributor)
-- ---------------------------------------------------------------------
CREATE SEQUENCE transfer_code_seq;
CREATE TABLE batch_transfers (
    transfer_id      SERIAL         PRIMARY KEY,
    transfer_code    VARCHAR(20)    NOT NULL UNIQUE
                     DEFAULT ('TRF-' || to_char(CURRENT_DATE,'YYYY') || '-'
                              || lpad(nextval('transfer_code_seq')::text, 6, '0')),
    batch_id         INT            NOT NULL REFERENCES batches(batch_id) ON DELETE RESTRICT,
    transfer_type    VARCHAR(16)    NOT NULL CHECK (transfer_type IN ('TO_PROCESSOR','TO_DISTRIBUTOR')),
    from_org_id      INT            REFERENCES organizations(org_id),   -- NULL = from the beekeeper
    to_org_id        INT            NOT NULL REFERENCES organizations(org_id),
    quantity_kg      NUMERIC(10,2)  NOT NULL CHECK (quantity_kg > 0),
    units            INT            CHECK (units > 0),                  -- packed units (to distributor)
    notes            TEXT,
    status           VARCHAR(10)    NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','ACCEPTED','REJECTED','CANCELLED')),
    initiated_by     INT            NOT NULL REFERENCES users(user_id),
    initiated_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    responded_by     INT            REFERENCES users(user_id),
    responded_at     TIMESTAMPTZ,
    response_reason  TEXT,
    is_demo          BOOLEAN        NOT NULL DEFAULT FALSE,

    CONSTRAINT transfer_from_matches_type CHECK ((transfer_type = 'TO_PROCESSOR') = (from_org_id IS NULL)),
    CONSTRAINT transfer_units_for_distributor CHECK ((transfer_type = 'TO_DISTRIBUTOR') = (units IS NOT NULL)),
    CONSTRAINT transfer_response_complete CHECK (
        (status = 'PENDING') = (responded_at IS NULL) AND (status = 'PENDING') = (responded_by IS NULL)),
    CONSTRAINT transfer_reject_has_reason CHECK (
        status NOT IN ('REJECTED','CANCELLED') OR length(trim(coalesce(response_reason, ''))) > 0)
);
CREATE UNIQUE INDEX transfers_one_pending_uq  ON batch_transfers (batch_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX transfers_one_accepted_uq ON batch_transfers (batch_id, transfer_type) WHERE status = 'ACCEPTED';
CREATE INDEX transfers_to_org_idx   ON batch_transfers (to_org_id, status);
CREATE INDEX transfers_from_org_idx ON batch_transfers (from_org_id, status) WHERE from_org_id IS NOT NULL;
CREATE INDEX transfers_batch_idx    ON batch_transfers (batch_id, initiated_at);

-- Current processor / distributor of a batch = receiver of the ACCEPTED transfer
CREATE OR REPLACE FUNCTION batch_processor_org(p_batch INT) RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT to_org_id FROM batch_transfers
     WHERE batch_id = p_batch AND transfer_type = 'TO_PROCESSOR' AND status = 'ACCEPTED'
$$;
CREATE OR REPLACE FUNCTION batch_distributor_org(p_batch INT) RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT to_org_id FROM batch_transfers
     WHERE batch_id = p_batch AND transfer_type = 'TO_DISTRIBUTOR' AND status = 'ACCEPTED'
$$;
CREATE OR REPLACE FUNCTION batch_owner_user(p_batch INT) RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT bk.user_id FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id
      JOIN hives hv ON hv.hive_id = h.hive_id JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
     WHERE b.batch_id = p_batch
$$;

-- R-T1 transfer rules (who may send what to whom, quantities, immutability)
CREATE OR REPLACE FUNCTION trg_transfer_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_batch batches%ROWTYPE;
    v_proc  processing_records%ROWTYPE;
    v_type  TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'transfers are never deleted; cancel or reject them instead');
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF only_demo_flag_set(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
        IF OLD.status <> 'PENDING' THEN
            PERFORM hc_raise('RECORD_IMMUTABLE', format('transfer %s is already %s', OLD.transfer_code, OLD.status));
        END IF;
        IF (to_jsonb(NEW) - 'status' - 'responded_by' - 'responded_at' - 'response_reason')
           IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'responded_by' - 'responded_at' - 'response_reason') THEN
            PERFORM hc_raise('RECORD_IMMUTABLE', 'only the response of a transfer can change');
        END IF;
        IF NEW.status IN ('ACCEPTED','REJECTED') AND NOT user_is_staff_of(NEW.responded_by, NEW.to_org_id,
               CASE NEW.transfer_type WHEN 'TO_PROCESSOR' THEN 'PROCESSOR' ELSE 'DISTRIBUTOR' END) THEN
            PERFORM hc_raise('NOT_RECEIVER', 'only staff of the receiving organization can accept or reject a transfer');
        END IF;
        IF NEW.status = 'CANCELLED' AND NEW.responded_by IS DISTINCT FROM NEW.initiated_by
           AND NOT (NEW.from_org_id IS NOT NULL AND user_is_staff_of(NEW.responded_by, NEW.from_org_id, 'PROCESSOR')) THEN
            PERFORM hc_raise('NOT_SENDER', 'only the sender can cancel a transfer');
        END IF;
        RETURN NEW;
    END IF;

    -- INSERT
    IF NEW.status <> 'PENDING' THEN
        PERFORM hc_raise('BAD_INITIAL_STATUS', 'a new transfer must start as PENDING');
    END IF;
    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id FOR UPDATE;
    SELECT org_type INTO v_type FROM organizations WHERE org_id = NEW.to_org_id AND is_active;

    IF NEW.transfer_type = 'TO_PROCESSOR' THEN
        IF v_batch.status <> 'CREATED' THEN
            PERFORM hc_raise('BATCH_NOT_TRANSFERABLE', format('batch %s is %s; only CREATED batches can be sent to a processor', v_batch.batch_code, v_batch.status));
        END IF;
        IF batch_owner_user(NEW.batch_id) IS DISTINCT FROM NEW.initiated_by THEN
            PERFORM hc_raise('NOT_OWNER', 'only the beekeeper who owns the batch can transfer it to a processor');
        END IF;
        IF v_type IS DISTINCT FROM 'PROCESSOR' THEN
            PERFORM hc_raise('NOT_A_PROCESSOR', 'batches can only be sent to an active processing organization');
        END IF;
        IF NEW.quantity_kg <> v_batch.quantity_kg THEN
            PERFORM hc_raise('QUANTITY_MISMATCH', format('transfer quantity must equal the batch quantity (%s kg)', v_batch.quantity_kg));
        END IF;
    ELSE -- TO_DISTRIBUTOR
        IF v_batch.status <> 'LAB_PASSED' THEN
            PERFORM hc_raise('BATCH_NOT_TRANSFERABLE', format('batch %s is %s; only LAB_PASSED batches can go to a distributor', v_batch.batch_code, v_batch.status));
        END IF;
        IF NEW.from_org_id IS DISTINCT FROM batch_processor_org(NEW.batch_id)
           OR NOT user_is_staff_of(NEW.initiated_by, NEW.from_org_id, 'PROCESSOR') THEN
            PERFORM hc_raise('NOT_CUSTODIAN', 'only staff of the processor holding the batch can transfer it');
        END IF;
        IF v_type IS DISTINCT FROM 'DISTRIBUTOR' THEN
            PERFORM hc_raise('NOT_A_DISTRIBUTOR', 'batches can only be sent to an active distributor');
        END IF;
        SELECT * INTO v_proc FROM processing_records WHERE batch_id = NEW.batch_id;
        IF NEW.units <> v_proc.units_packed OR NEW.quantity_kg <> v_proc.output_quantity_kg THEN
            PERFORM hc_raise('QUANTITY_MISMATCH',
                format('transfer must hand over all %s packed units (%s kg)', v_proc.units_packed, v_proc.output_quantity_kg));
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER transfers_rules BEFORE INSERT OR UPDATE OR DELETE ON batch_transfers
    FOR EACH ROW EXECUTE FUNCTION trg_transfer_rules();

-- R-T2 the batch status always follows its transfers (cannot get out of sync)
CREATE OR REPLACE FUNCTION trg_transfer_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE batches SET status = CASE NEW.transfer_type WHEN 'TO_PROCESSOR' THEN 'PENDING_PROCESSOR' ELSE 'PENDING_DISTRIBUTOR' END
         WHERE batch_id = NEW.batch_id;
    ELSIF NEW.status <> OLD.status THEN
        UPDATE batches SET status = CASE
              WHEN NEW.transfer_type = 'TO_PROCESSOR'   AND NEW.status = 'ACCEPTED' THEN 'IN_PROCESSING'
              WHEN NEW.transfer_type = 'TO_PROCESSOR'                               THEN 'CREATED'
              WHEN NEW.transfer_type = 'TO_DISTRIBUTOR' AND NEW.status = 'ACCEPTED' THEN 'IN_DISTRIBUTION'
              ELSE 'LAB_PASSED' END
         WHERE batch_id = NEW.batch_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER transfers_status AFTER INSERT OR UPDATE OF status ON batch_transfers
    FOR EACH ROW EXECUTE FUNCTION trg_transfer_status();

-- ---------------------------------------------------------------------
-- 4. Laboratory testing requests  (processor -> laboratory)
-- ---------------------------------------------------------------------
CREATE SEQUENCE test_request_code_seq;
CREATE TABLE lab_test_requests (
    request_id        SERIAL        PRIMARY KEY,
    request_code      VARCHAR(20)   NOT NULL UNIQUE
                      DEFAULT ('LTR-' || to_char(CURRENT_DATE,'YYYY') || '-'
                               || lpad(nextval('test_request_code_seq')::text, 6, '0')),
    batch_id          INT           NOT NULL REFERENCES batches(batch_id) ON DELETE RESTRICT,
    lab_org_id        INT           NOT NULL REFERENCES organizations(org_id),
    requester_org_id  INT           NOT NULL REFERENCES organizations(org_id),
    requested_by      INT           NOT NULL REFERENCES users(user_id),
    requested_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    sample_reference  VARCHAR(60),
    tests_requested   TEXT,
    notes             TEXT,
    status            VARCHAR(10)   NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','ACCEPTED','REJECTED','CANCELLED','COMPLETED')),
    responded_by      INT           REFERENCES users(user_id),
    responded_at      TIMESTAMPTZ,
    response_reason   TEXT,
    completed_at      TIMESTAMPTZ,
    is_demo           BOOLEAN       NOT NULL DEFAULT FALSE,
    CONSTRAINT request_response_complete CHECK ((status = 'PENDING') = (responded_at IS NULL)),
    CONSTRAINT request_reject_has_reason CHECK (
        status NOT IN ('REJECTED','CANCELLED') OR length(trim(coalesce(response_reason, ''))) > 0),
    CONSTRAINT request_completed_has_time CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX lab_requests_one_open_uq ON lab_test_requests (batch_id) WHERE status IN ('PENDING','ACCEPTED');
CREATE INDEX lab_requests_lab_idx       ON lab_test_requests (lab_org_id, status);
CREATE INDEX lab_requests_requester_idx ON lab_test_requests (requester_org_id, status);
CREATE INDEX lab_requests_batch_idx     ON lab_test_requests (batch_id);

CREATE OR REPLACE FUNCTION trg_lab_request_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_batch batches%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'testing requests are never deleted');
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF only_demo_flag_set(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
        IF (to_jsonb(NEW) - 'status' - 'responded_by' - 'responded_at' - 'response_reason' - 'completed_at')
           IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'responded_by' - 'responded_at' - 'response_reason' - 'completed_at') THEN
            PERFORM hc_raise('RECORD_IMMUTABLE', 'only the response of a testing request can change');
        END IF;
        IF NEW.status = OLD.status THEN RETURN NEW; END IF;
        IF NOT ((OLD.status = 'PENDING'  AND NEW.status IN ('ACCEPTED','REJECTED','CANCELLED')) OR
                (OLD.status = 'ACCEPTED' AND NEW.status = 'COMPLETED')) THEN
            PERFORM hc_raise('INVALID_TRANSITION', format('testing request %s cannot move from %s to %s', OLD.request_code, OLD.status, NEW.status));
        END IF;
        IF NEW.status IN ('ACCEPTED','REJECTED') AND NOT user_is_staff_of(NEW.responded_by, NEW.lab_org_id, 'LAB_TESTER') THEN
            PERFORM hc_raise('NOT_LAB_STAFF', 'only lab testers of the requested laboratory can accept or reject');
        END IF;
        IF NEW.status = 'CANCELLED' AND NOT user_is_staff_of(NEW.responded_by, NEW.requester_org_id, 'PROCESSOR') THEN
            PERFORM hc_raise('NOT_SENDER', 'only the requesting processor can cancel a testing request');
        END IF;
        IF NEW.status = 'COMPLETED' AND NOT EXISTS (
            SELECT 1 FROM lab_reports WHERE request_id = NEW.request_id AND report_state = 'SUBMITTED') THEN
            PERFORM hc_raise('NO_RESULT', 'a testing request is completed only by a submitted lab report');
        END IF;
        RETURN NEW;
    END IF;

    -- INSERT
    IF NEW.status <> 'PENDING' THEN
        PERFORM hc_raise('BAD_INITIAL_STATUS', 'a new testing request must start as PENDING');
    END IF;
    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id FOR UPDATE;
    IF v_batch.status NOT IN ('PROCESSED','LAB_INCONCLUSIVE') THEN
        PERFORM hc_raise('BATCH_NOT_TESTABLE', format('batch %s is %s; testing can be requested after processing (or after an inconclusive result)', v_batch.batch_code, v_batch.status));
    END IF;
    IF NEW.requester_org_id IS DISTINCT FROM batch_processor_org(NEW.batch_id)
       OR NOT user_is_staff_of(NEW.requested_by, NEW.requester_org_id, 'PROCESSOR') THEN
        PERFORM hc_raise('NOT_CUSTODIAN', 'only staff of the processor holding the batch can request testing');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE org_id = NEW.lab_org_id AND org_type = 'LABORATORY' AND is_active) THEN
        PERFORM hc_raise('NOT_A_LAB', 'testing can only be requested from an active laboratory');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER lab_requests_rules BEFORE INSERT OR UPDATE OR DELETE ON lab_test_requests
    FOR EACH ROW EXECUTE FUNCTION trg_lab_request_rules();

CREATE OR REPLACE FUNCTION trg_lab_request_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE batches SET status = 'PENDING_LAB' WHERE batch_id = NEW.batch_id;
    ELSIF NEW.status <> OLD.status THEN
        IF NEW.status = 'ACCEPTED' THEN
            UPDATE batches SET status = 'IN_TESTING' WHERE batch_id = NEW.batch_id;
        ELSIF NEW.status IN ('REJECTED','CANCELLED') THEN
            -- back to where it was: inconclusive re-test, or freshly processed
            UPDATE batches SET status = CASE WHEN EXISTS (
                    SELECT 1 FROM lab_reports WHERE batch_id = NEW.batch_id AND report_state = 'SUBMITTED' AND decision = 'INCONCLUSIVE')
                THEN 'LAB_INCONCLUSIVE' ELSE 'PROCESSED' END
             WHERE batch_id = NEW.batch_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER lab_requests_status AFTER INSERT OR UPDATE OF status ON lab_test_requests
    FOR EACH ROW EXECUTE FUNCTION trg_lab_request_status();

-- ---------------------------------------------------------------------
-- 5. Lab reports: request link, INCONCLUSIVE, SUPERSEDED (audited corrections)
-- ---------------------------------------------------------------------
-- views depending on lab_reports.decision must be dropped before its type changes
DROP VIEW IF EXISTS v_public_batch;
DROP VIEW IF EXISTS v_batch_trace;

ALTER TABLE lab_reports DROP CONSTRAINT lab_reports_decision_check;
ALTER TABLE lab_reports DROP CONSTRAINT lab_reports_report_state_check;
ALTER TABLE lab_reports DROP CONSTRAINT lab_submit_complete;
ALTER TABLE lab_reports ALTER COLUMN decision TYPE VARCHAR(12);
ALTER TABLE lab_reports ADD CONSTRAINT lab_reports_decision_check CHECK (decision IN ('PASS','FAIL','INCONCLUSIVE'));
ALTER TABLE lab_reports ADD CONSTRAINT lab_reports_report_state_check CHECK (report_state IN ('DRAFT','SUBMITTED','SUPERSEDED'));
ALTER TABLE lab_reports ADD CONSTRAINT lab_submit_complete CHECK (
    (report_state IN ('SUBMITTED','SUPERSEDED')) = (decision IS NOT NULL AND submitted_at IS NOT NULL));

ALTER TABLE lab_reports
    ADD COLUMN request_id            INT REFERENCES lab_test_requests(request_id),
    ADD COLUMN supersedes_report_id  INT REFERENCES lab_reports(lab_report_id),
    ADD COLUMN superseded_at         TIMESTAMPTZ;
ALTER TABLE lab_reports ADD CONSTRAINT lab_superseded_has_time CHECK ((report_state = 'SUPERSEDED') = (superseded_at IS NOT NULL));
CREATE INDEX lab_reports_request_idx ON lab_reports (request_id) WHERE request_id IS NOT NULL;

-- One FINAL (PASS/FAIL) submitted report per batch; INCONCLUSIVE reports may be followed by re-tests.
DROP INDEX lab_reports_one_submitted_uq;
CREATE UNIQUE INDEX lab_reports_one_final_uq ON lab_reports (batch_id)
    WHERE report_state = 'SUBMITTED' AND decision IN ('PASS','FAIL');

-- The batch's current laboratory result = latest SUBMITTED report (never a superseded one)
CREATE OR REPLACE FUNCTION batch_current_report(p_batch INT) RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT lab_report_id FROM lab_reports
     WHERE batch_id = p_batch AND report_state = 'SUBMITTED'
     ORDER BY submitted_at DESC, lab_report_id DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION trg_lab_report_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_batch batches%ROWTYPE;
    v_req   lab_test_requests%ROWTYPE;
    v_old   lab_reports%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.report_state <> 'DRAFT' THEN
            PERFORM hc_raise('REPORT_IMMUTABLE', 'a submitted lab report cannot be deleted');
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND only_demo_flag_set(to_jsonb(OLD), to_jsonb(NEW)) THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.report_state = 'SUPERSEDED' THEN
        PERFORM hc_raise('REPORT_IMMUTABLE', format('lab report %s has been superseded', OLD.report_code));
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.report_state = 'SUBMITTED' THEN
        -- the ONLY permitted change: marking it SUPERSEDED during an approved correction
        IF NEW.report_state = 'SUPERSEDED'
           AND NULLIF(current_setting('app.lab_correction', true), '') IS NOT NULL
           AND (to_jsonb(NEW) - 'report_state' - 'superseded_at' - 'updated_at')
             = (to_jsonb(OLD) - 'report_state' - 'superseded_at' - 'updated_at') THEN
            RETURN NEW;
        END IF;
        PERFORM hc_raise('REPORT_IMMUTABLE', format('lab report %s is already submitted; use an audited correction', OLD.report_code));
    END IF;

    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id;

    IF NOT user_is_staff_of(NEW.tested_by, NEW.lab_org_id, 'LAB_TESTER') THEN
        PERFORM hc_raise('NOT_LAB_STAFF', 'tested_by must be an active LAB_TESTER of lab_org_id');
    END IF;

    -- corrected report (inserted directly as SUBMITTED by an approved correction)
    IF NEW.supersedes_report_id IS NOT NULL THEN
        IF TG_OP <> 'INSERT' OR NULLIF(current_setting('app.lab_correction', true), '') IS NULL THEN
            PERFORM hc_raise('CORRECTION_REQUIRED', 'corrected reports can only be created by an approved correction');
        END IF;
        SELECT * INTO v_old FROM lab_reports WHERE lab_report_id = NEW.supersedes_report_id;
        IF v_old.batch_id <> NEW.batch_id OR v_old.lab_org_id <> NEW.lab_org_id OR v_old.report_state <> 'SUPERSEDED' THEN
            PERFORM hc_raise('CORRECTION_INVALID', 'the superseded report must belong to the same batch and laboratory');
        END IF;
        IF NEW.report_state <> 'SUBMITTED' THEN
            PERFORM hc_raise('CORRECTION_INVALID', 'a corrected report is created as SUBMITTED');
        END IF;
        RETURN NEW;
    END IF;

    -- normal path: requires an ACCEPTED testing request from this laboratory
    SELECT * INTO v_req FROM lab_test_requests WHERE request_id = NEW.request_id;
    IF v_req.request_id IS NULL OR v_req.status <> 'ACCEPTED'
       OR v_req.lab_org_id <> NEW.lab_org_id OR v_req.batch_id <> NEW.batch_id THEN
        PERFORM hc_raise('NO_ACCEPTED_REQUEST', format('batch %s has no accepted testing request for this laboratory', v_batch.batch_code));
    END IF;
    IF v_batch.status <> 'IN_TESTING' THEN
        PERFORM hc_raise('BATCH_NOT_TESTABLE', format('batch %s is in status %s', v_batch.batch_code, v_batch.status));
    END IF;
    IF NEW.received_on < v_req.requested_at::date THEN
        PERFORM hc_raise('DATE_ORDER', 'sample received before testing was requested');
    END IF;
    RETURN NEW;
END $$;

-- Supporting documents for a lab report (PDF / images / CSV), stored transactionally in PostgreSQL
CREATE TABLE lab_report_documents (
    document_id    SERIAL        PRIMARY KEY,
    lab_report_id  INT           NOT NULL REFERENCES lab_reports(lab_report_id) ON DELETE RESTRICT,
    file_name      VARCHAR(200)  NOT NULL,
    mime_type      VARCHAR(80)   NOT NULL CHECK (mime_type IN ('application/pdf','image/png','image/jpeg','text/csv','text/plain')),
    size_bytes     INT           NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
    sha256         CHAR(64)      NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content        BYTEA         NOT NULL,
    description    VARCHAR(300),
    uploaded_by    INT           NOT NULL REFERENCES users(user_id),
    uploaded_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    is_demo        BOOLEAN       NOT NULL DEFAULT FALSE,
    UNIQUE (lab_report_id, sha256)
);
CREATE OR REPLACE FUNCTION trg_lab_document_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_rep lab_reports%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF only_demo_flag_set(to_jsonb(OLD) - 'content', to_jsonb(NEW) - 'content') AND OLD.content = NEW.content THEN RETURN NEW; END IF;
        PERFORM hc_raise('RECORD_IMMUTABLE', 'lab documents cannot be edited');
    END IF;
    IF TG_OP = 'DELETE' THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'lab documents cannot be deleted');
    END IF;
    SELECT * INTO v_rep FROM lab_reports WHERE lab_report_id = NEW.lab_report_id;
    IF NOT user_is_staff_of(NEW.uploaded_by, v_rep.lab_org_id, 'LAB_TESTER') THEN
        PERFORM hc_raise('NOT_LAB_STAFF', 'only lab testers of the reporting laboratory can attach documents');
    END IF;
    IF v_rep.report_state = 'SUPERSEDED' THEN
        PERFORM hc_raise('REPORT_IMMUTABLE', 'documents cannot be added to a superseded report');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER lab_documents_rules BEFORE INSERT OR UPDATE OR DELETE ON lab_report_documents
    FOR EACH ROW EXECUTE FUNCTION trg_lab_document_rules();

-- Audited correction requests for submitted results (approved by an ADMIN, never self-approved)
CREATE SEQUENCE correction_code_seq;
CREATE TABLE lab_report_corrections (
    correction_id      SERIAL       PRIMARY KEY,
    correction_code    VARCHAR(20)  NOT NULL UNIQUE
                       DEFAULT ('LCR-' || to_char(CURRENT_DATE,'YYYY') || '-'
                                || lpad(nextval('correction_code_seq')::text, 6, '0')),
    lab_report_id      INT          NOT NULL REFERENCES lab_reports(lab_report_id),
    requested_by       INT          NOT NULL REFERENCES users(user_id),
    requested_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    reason             TEXT         NOT NULL CHECK (length(trim(reason)) >= 10),
    proposed_changes   JSONB        NOT NULL CHECK (jsonb_typeof(proposed_changes) = 'object' AND proposed_changes <> '{}'::jsonb),
    previous_values    JSONB        NOT NULL,
    status             VARCHAR(10)  NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    reviewed_by        INT          REFERENCES users(user_id),
    reviewed_at        TIMESTAMPTZ,
    review_note        TEXT,
    new_lab_report_id  INT          REFERENCES lab_reports(lab_report_id),
    is_demo            BOOLEAN      NOT NULL DEFAULT FALSE,
    CONSTRAINT correction_review_complete CHECK ((status = 'PENDING') = (reviewed_by IS NULL AND reviewed_at IS NULL)),
    CONSTRAINT correction_approved_has_report CHECK ((status = 'APPROVED') = (new_lab_report_id IS NOT NULL)),
    CONSTRAINT correction_not_self_reviewed CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by)
);
CREATE UNIQUE INDEX corrections_one_pending_uq ON lab_report_corrections (lab_report_id) WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION trg_correction_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_rep lab_reports%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'correction requests are audit records and cannot be deleted');
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF only_demo_flag_set(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
        IF OLD.status <> 'PENDING' THEN
            PERFORM hc_raise('RECORD_IMMUTABLE', format('correction %s is already %s', OLD.correction_code, OLD.status));
        END IF;
        IF (to_jsonb(NEW) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note' - 'new_lab_report_id')
           IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note' - 'new_lab_report_id') THEN
            PERFORM hc_raise('RECORD_IMMUTABLE', 'only the review of a correction can change');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM users WHERE user_id = NEW.reviewed_by AND role_code = 'ADMIN' AND is_active) THEN
            PERFORM hc_raise('NOT_ADMIN', 'corrections are reviewed by an active administrator');
        END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO v_rep FROM lab_reports WHERE lab_report_id = NEW.lab_report_id;
    IF v_rep.report_state <> 'SUBMITTED' THEN
        PERFORM hc_raise('NOT_CORRECTABLE', 'only the current submitted report can be corrected');
    END IF;
    IF NOT user_is_staff_of(NEW.requested_by, v_rep.lab_org_id, 'LAB_TESTER') THEN
        PERFORM hc_raise('NOT_LAB_STAFF', 'only lab testers of the reporting laboratory can request a correction');
    END IF;
    IF NEW.status <> 'PENDING' THEN
        PERFORM hc_raise('BAD_INITIAL_STATUS', 'a correction request starts as PENDING');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER corrections_rules BEFORE INSERT OR UPDATE OR DELETE ON lab_report_corrections
    FOR EACH ROW EXECUTE FUNCTION trg_correction_rules();

-- ---------------------------------------------------------------------
-- 6. Processing: requires custody (accepted transfer) - no longer needs a lab result first
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_processing_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_batch     batches%ROWTYPE;
    v_accepted  DATE;
BEGIN
    IF TG_OP = 'UPDATE' AND only_demo_flag_set(to_jsonb(OLD), to_jsonb(NEW)) THEN
        RETURN NEW;
    END IF;
    IF TG_OP IN ('UPDATE','DELETE') THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'processing records are append-only');
    END IF;

    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id FOR UPDATE;
    IF v_batch.status <> 'IN_PROCESSING' THEN
        PERFORM hc_raise('BATCH_NOT_PROCESSABLE', format('batch %s is in status %s; accept the transfer first', v_batch.batch_code, v_batch.status));
    END IF;
    IF NEW.processor_org_id IS DISTINCT FROM batch_processor_org(NEW.batch_id) THEN
        PERFORM hc_raise('NOT_CUSTODIAN', 'this processing unit does not hold the batch');
    END IF;
    IF NOT user_is_staff_of(NEW.recorded_by, NEW.processor_org_id, 'PROCESSOR') THEN
        PERFORM hc_raise('NOT_PROCESSOR_STAFF', 'recorded_by must be active PROCESSOR staff of processor_org_id');
    END IF;
    IF NEW.input_quantity_kg > v_batch.quantity_kg THEN
        PERFORM hc_raise('INPUT_EXCEEDS_BATCH',
            format('input %s kg exceeds batch quantity %s kg', NEW.input_quantity_kg, v_batch.quantity_kg));
    END IF;
    SELECT responded_at::date INTO v_accepted FROM batch_transfers
     WHERE batch_id = NEW.batch_id AND transfer_type = 'TO_PROCESSOR' AND status = 'ACCEPTED';
    IF NEW.processing_date < v_accepted THEN
        PERFORM hc_raise('DATE_ORDER', 'processing date is before the batch was received by the processor');
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 7. Shipments: require distributor custody
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_shipment_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_batch    batches%ROWTYPE;
    v_proc     processing_records%ROWTYPE;
    v_shipped  INT;
    v_accepted DATE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'shipments cannot be deleted; cancel them instead');
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF only_demo_flag_set(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
        IF (NEW.batch_id, NEW.distributor_org_id, NEW.dispatch_date, NEW.units_shipped,
            NEW.destination_name, NEW.origin_location)
           IS DISTINCT FROM
           (OLD.batch_id, OLD.distributor_org_id, OLD.dispatch_date, OLD.units_shipped,
            OLD.destination_name, OLD.origin_location) THEN
            PERFORM hc_raise('RECORD_IMMUTABLE', 'only shipment status and delivery date can change');
        END IF;
        IF NEW.status <> OLD.status AND NOT (
               (OLD.status = 'DISPATCHED' AND NEW.status IN ('IN_TRANSIT','DELIVERED','CANCELLED')) OR
               (OLD.status = 'IN_TRANSIT' AND NEW.status IN ('DELIVERED','CANCELLED'))) THEN
            PERFORM hc_raise('INVALID_TRANSITION',
                format('shipment %s cannot move from %s to %s', OLD.shipment_code, OLD.status, NEW.status));
        END IF;
        RETURN NEW;
    END IF;

    -- INSERT
    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id;
    IF v_batch.status <> 'IN_DISTRIBUTION' THEN
        PERFORM hc_raise('BATCH_NOT_DISPATCHABLE', format('batch %s is in status %s; accept the transfer first', v_batch.batch_code, v_batch.status));
    END IF;
    IF NEW.distributor_org_id IS DISTINCT FROM batch_distributor_org(NEW.batch_id) THEN
        PERFORM hc_raise('NOT_CUSTODIAN', 'this distributor does not hold the batch');
    END IF;
    IF NOT user_is_staff_of(NEW.recorded_by, NEW.distributor_org_id, 'DISTRIBUTOR') THEN
        PERFORM hc_raise('NOT_DISTRIBUTOR_STAFF', 'recorded_by must be active DISTRIBUTOR staff of distributor_org_id');
    END IF;
    IF NEW.status <> 'DISPATCHED' THEN
        PERFORM hc_raise('BAD_INITIAL_STATUS', 'a new shipment must start as DISPATCHED');
    END IF;

    SELECT * INTO v_proc FROM processing_records WHERE batch_id = NEW.batch_id FOR UPDATE;  -- row lock
    IF NEW.dispatch_date < v_proc.packaging_date THEN
        PERFORM hc_raise('DATE_ORDER', 'dispatch date is before the packaging date');
    END IF;
    SELECT responded_at::date INTO v_accepted FROM batch_transfers
     WHERE batch_id = NEW.batch_id AND transfer_type = 'TO_DISTRIBUTOR' AND status = 'ACCEPTED';
    IF NEW.dispatch_date < v_accepted THEN
        PERFORM hc_raise('DATE_ORDER', 'dispatch date is before the distributor received the batch');
    END IF;
    SELECT COALESCE(SUM(units_shipped), 0) INTO v_shipped FROM shipments
     WHERE batch_id = NEW.batch_id AND status <> 'CANCELLED';
    IF v_shipped + NEW.units_shipped > v_proc.units_packed THEN
        PERFORM hc_raise('SHIPPED_EXCEEDS_PACKED',
            format('would ship %s units but only %s were packed', v_shipped + NEW.units_shipped, v_proc.units_packed));
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 8. Consumer verification history  &  application settings
-- ---------------------------------------------------------------------
CREATE TABLE consumer_verifications (
    verification_id  BIGSERIAL    PRIMARY KEY,
    user_id          INT          NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    batch_id         INT          NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
    overall_result   VARCHAR(20)  NOT NULL
                     CHECK (overall_result IN ('VERIFIED','MISMATCH','PARTIAL','NOT_ANCHORED','UNAVAILABLE')),
    verified_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX consumer_verifications_user_idx ON consumer_verifications (user_id, verified_at DESC);

CREATE OR REPLACE FUNCTION trg_consumer_verification_role() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE user_id = NEW.user_id AND role_code = 'CONSUMER') THEN
        PERFORM hc_raise('NOT_A_CONSUMER', 'verification history is only kept for CONSUMER accounts');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER consumer_verifications_role BEFORE INSERT ON consumer_verifications
    FOR EACH ROW EXECUTE FUNCTION trg_consumer_verification_role();

CREATE TABLE app_settings (
    setting_key  VARCHAR(60)  PRIMARY KEY,
    value        JSONB        NOT NULL,
    description  TEXT         NOT NULL,
    updated_by   INT          REFERENCES users(user_id),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE TABLE app_settings_history (
    history_id   BIGSERIAL    PRIMARY KEY,
    setting_key  VARCHAR(60)  NOT NULL REFERENCES app_settings(setting_key),
    old_value    JSONB,
    new_value    JSONB        NOT NULL,
    changed_by   INT          REFERENCES users(user_id),
    changed_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION trg_settings_history() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    NEW.updated_by := app_current_user_id();
    IF NEW.value IS DISTINCT FROM OLD.value THEN
        INSERT INTO app_settings_history (setting_key, old_value, new_value, changed_by)
        VALUES (NEW.setting_key, OLD.value, NEW.value, app_current_user_id());
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER app_settings_history BEFORE UPDATE ON app_settings
    FOR EACH ROW EXECUTE FUNCTION trg_settings_history();

INSERT INTO app_settings (setting_key, value, description) VALUES
 ('standards_profile', '"FSSAI"', 'Honey composition standard used for rule-based screening of lab values (FSSAI or CODEX)'),
 ('max_processing_loss_pct', '10', 'Processing loss (%) above which an anomaly warning is raised'),
 ('consumer_registration_enabled', 'true', 'Whether consumers can create an optional account to keep a verification history');

-- ---------------------------------------------------------------------
-- 9. Views (recreated for the new workflow)
-- ---------------------------------------------------------------------
CREATE VIEW v_batch_trace AS
SELECT
    b.batch_id, b.batch_code, b.status, b.quantity_kg AS batch_quantity_kg, b.honey_type,
    b.is_demo, b.created_at AS batch_created_at,
    h.harvest_id, h.harvest_code, h.harvest_date, h.quantity_kg AS harvest_quantity_kg, h.floral_source,
    hv.hive_id, hv.hive_code, hv.hive_type, hv.bee_species, hv.district AS hive_district, hv.state AS hive_state,
    bk.beekeeper_id, bk.beekeeper_code, bk.public_display_name, bk.cooperative_name,
    u.user_id AS beekeeper_user_id, u.full_name AS beekeeper_full_name, u.email AS beekeeper_email,
    po.org_id AS processor_org_id, po.name AS processor_org_name,
    dorg.org_id AS distributor_org_id, dorg.name AS distributor_org_name,
    CASE WHEN b.status IN ('CREATED','PENDING_PROCESSOR') THEN 'BEEKEEPER'
         WHEN b.status IN ('IN_DISTRIBUTION','DELIVERED') THEN 'DISTRIBUTOR'
         ELSE 'PROCESSOR' END                                              AS custodian_role,
    rq.request_code AS open_request_code, rq.status AS open_request_status, rlab.name AS requested_lab_name,
    lr.lab_report_id, lr.report_code, lr.tested_on, lr.moisture_pct, lr.hmf_mg_kg, lr.sucrose_g_100g,
    lr.adulteration_result, lr.decision AS lab_decision, lab.name AS lab_name,
    pr.processing_id, pr.processing_code, pr.processing_date, pr.method AS processing_method,
    pr.input_quantity_kg, pr.output_quantity_kg, pr.units_packed, pr.unit_size_g,
    (SELECT COALESCE(SUM(s.units_shipped), 0) FROM shipments s
      WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED')            AS units_shipped,
    (SELECT COUNT(*) FROM shipments s WHERE s.batch_id = b.batch_id)        AS shipment_count
FROM batches b
JOIN harvests   h  ON h.harvest_id    = b.harvest_id
JOIN hives      hv ON hv.hive_id      = h.hive_id
JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
JOIN users      u  ON u.user_id       = bk.user_id
LEFT JOIN organizations      po   ON po.org_id   = batch_processor_org(b.batch_id)
LEFT JOIN organizations      dorg ON dorg.org_id = batch_distributor_org(b.batch_id)
LEFT JOIN lab_test_requests  rq   ON rq.batch_id = b.batch_id AND rq.status IN ('PENDING','ACCEPTED')
LEFT JOIN organizations      rlab ON rlab.org_id = rq.lab_org_id
LEFT JOIN lab_reports        lr   ON lr.lab_report_id = batch_current_report(b.batch_id)
LEFT JOIN organizations      lab  ON lab.org_id  = lr.lab_org_id
LEFT JOIN processing_records pr   ON pr.batch_id = b.batch_id;


CREATE VIEW v_public_batch AS
SELECT
    b.batch_code, b.status, b.honey_type, b.quantity_kg AS batch_quantity_kg, b.is_demo,
    -- origin: the beekeeper's name only if they consented
    CASE WHEN bk.show_name_publicly THEN bk.public_display_name
         ELSE 'Registered beekeeper' END                          AS producer_name,
    CASE WHEN bk.show_name_publicly THEN bk.cooperative_name END   AS cooperative_name,
    hv.district AS origin_district, hv.state AS origin_state,
    hv.hive_code, hv.bee_species,
    h.harvest_code, h.harvest_date, h.floral_source,
    -- laboratory (organization, never the individual tester)
    lab.name AS lab_name, lab.accreditation_no AS lab_accreditation_no,
    lr.report_code, lr.tested_on, lr.moisture_pct, lr.hmf_mg_kg, lr.sucrose_g_100g,
    lr.glucose_g_100g, lr.fructose_g_100g, lr.ph, lr.free_acidity_meq_kg,
    lr.pollen_identification, lr.adulteration_method, lr.adulteration_result,
    lr.decision AS lab_decision,
    (SELECT o.report_code FROM lab_reports o WHERE o.lab_report_id = lr.supersedes_report_id) AS supersedes_report_code,
    -- processing (organization, method, packaging - not the operator's name)
    po.name AS processor_name, po.city AS processor_city,
    pr.processing_code, pr.processing_date, pr.method AS processing_method,
    pr.packaging_date, pr.packaging_type, pr.unit_size_g, pr.best_before
FROM batches b
JOIN harvests   h  ON h.harvest_id    = b.harvest_id
JOIN hives      hv ON hv.hive_id      = h.hive_id
JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
LEFT JOIN lab_reports        lr  ON lr.lab_report_id = batch_current_report(b.batch_id)
LEFT JOIN organizations      lab ON lab.org_id  = lr.lab_org_id
LEFT JOIN processing_records pr  ON pr.batch_id = b.batch_id
LEFT JOIN organizations      po  ON po.org_id   = pr.processor_org_id;

-- Accepted custody hand-overs only (no rejection reasons, no people, no notes)
CREATE VIEW v_public_custody AS
SELECT b.batch_code, t.transfer_code, t.transfer_type, o.name AS receiver_name, o.city AS receiver_city,
       t.responded_at::date AS received_on
  FROM batch_transfers t
  JOIN batches b       ON b.batch_id = t.batch_id
  JOIN organizations o ON o.org_id   = t.to_org_id
 WHERE t.status = 'ACCEPTED';

COMMIT;
