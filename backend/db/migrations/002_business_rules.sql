-- =====================================================================
-- HoneyChain - Migration 002: business rules enforced INSIDE the database
--
-- Why triggers as well as backend validation?
--   The backend validates first (friendly error messages). These triggers
--   are the last line of defence: even a buggy API, a script or a manual
--   psql session cannot create an impossible supply chain.
--
-- The backend sets the acting user at the start of every transaction:
--     SELECT set_config('app.user_id', '<user_id>', true);
-- so history rows can record who made the change.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::INT
$$;

CREATE OR REPLACE FUNCTION hc_raise(code TEXT, msg TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    -- SQLSTATE P0001 + a machine-readable code prefix the API maps to HTTP 409/422
    RAISE EXCEPTION '%: %', code, msg USING ERRCODE = 'P0001';
END $$;

-- "Is user U an active member of organization O with role R?"
CREATE OR REPLACE FUNCTION user_is_staff_of(p_user INT, p_org INT, p_role TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM users
                   WHERE user_id = p_user AND org_id = p_org
                     AND role_code = p_role AND is_active)
$$;

-- Labelling a record as demo data after creation is the ONLY change allowed on otherwise
-- immutable rows (false -> true only; never un-labelled; is_demo is not part of any hash).
CREATE OR REPLACE FUNCTION only_demo_flag_set(old_row JSONB, new_row JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT (old_row - 'is_demo' - 'updated_at') = (new_row - 'is_demo' - 'updated_at')
       AND (new_row ->> 'is_demo')::boolean AND NOT (old_row ->> 'is_demo')::boolean
$$;

-- Generic updated_at maintenance
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER users_updated_at      BEFORE UPDATE ON users      FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER beekeepers_updated_at BEFORE UPDATE ON beekeepers FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER hives_updated_at      BEFORE UPDATE ON hives      FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER harvests_updated_at   BEFORE UPDATE ON harvests   FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER batches_updated_at    BEFORE UPDATE ON batches    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER lab_updated_at        BEFORE UPDATE ON lab_reports FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER ship_updated_at       BEFORE UPDATE ON shipments  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------------------------------------------------------------------
-- R-U1  Staff organization type must match role
--       (LAB -> LABORATORY, PROCESSOR -> PROCESSOR, DISTRIBUTOR -> DISTRIBUTOR)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_users_org_type() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_type TEXT;
BEGIN
    IF NEW.org_id IS NULL THEN RETURN NEW; END IF;
    SELECT org_type INTO v_type FROM organizations WHERE org_id = NEW.org_id;
    IF (NEW.role_code = 'LAB'         AND v_type <> 'LABORATORY') OR
       (NEW.role_code = 'PROCESSOR'   AND v_type <> 'PROCESSOR')  OR
       (NEW.role_code = 'DISTRIBUTOR' AND v_type <> 'DISTRIBUTOR') THEN
        PERFORM hc_raise('ORG_ROLE_MISMATCH',
            format('role %s cannot belong to an organization of type %s', NEW.role_code, v_type));
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER users_org_type BEFORE INSERT OR UPDATE OF role_code, org_id ON users
    FOR EACH ROW EXECUTE FUNCTION trg_users_org_type();

-- R-U2  A beekeeper profile may only be attached to a BEEKEEPER user
CREATE OR REPLACE FUNCTION trg_beekeeper_role() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE user_id = NEW.user_id AND role_code = 'BEEKEEPER') THEN
        PERFORM hc_raise('NOT_A_BEEKEEPER', 'beekeeper profile requires a BEEKEEPER user');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER beekeepers_role BEFORE INSERT OR UPDATE OF user_id ON beekeepers
    FOR EACH ROW EXECUTE FUNCTION trg_beekeeper_role();

-- ---------------------------------------------------------------------
-- R-H1  Harvest: hive must be ACTIVE, date not before hive installation.
-- R-H2  Once a harvest has batches, its key facts are frozen
--       (they are part of the anchored BATCH_ORIGIN hash).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_harvest_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_hive hives%ROWTYPE;
BEGIN
    SELECT * INTO v_hive FROM hives WHERE hive_id = NEW.hive_id;
    IF TG_OP = 'INSERT' AND v_hive.status <> 'ACTIVE' THEN
        PERFORM hc_raise('HIVE_INACTIVE', format('hive %s is not active', v_hive.hive_code));
    END IF;
    IF NEW.harvest_date < v_hive.installed_on THEN
        PERFORM hc_raise('HARVEST_BEFORE_HIVE', 'harvest date is earlier than hive installation date');
    END IF;
    IF TG_OP = 'UPDATE'
       AND (NEW.hive_id, NEW.harvest_date, NEW.quantity_kg, NEW.floral_source)
           IS DISTINCT FROM (OLD.hive_id, OLD.harvest_date, OLD.quantity_kg, OLD.floral_source)
       AND EXISTS (SELECT 1 FROM batches WHERE harvest_id = OLD.harvest_id) THEN
        PERFORM hc_raise('HARVEST_LOCKED', 'harvest already has batches; its details can no longer change');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER harvests_rules BEFORE INSERT OR UPDATE ON harvests
    FOR EACH ROW EXECUTE FUNCTION trg_harvest_rules();

-- ---------------------------------------------------------------------
-- R-B1  Sum of batch quantities <= harvest quantity.
--       The harvest row is locked (FOR UPDATE) so two concurrent requests
--       cannot both pass the check and over-allocate the same harvest.
-- R-B2  New batches always start as CREATED.
-- R-B3  Quantity and source harvest are frozen after CREATED.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_batch_quantity() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_harvest_qty NUMERIC;
    v_allocated   NUMERIC;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status <> 'CREATED' THEN
        PERFORM hc_raise('BAD_INITIAL_STATUS', 'a new batch must start in status CREATED');
    END IF;
    IF TG_OP = 'UPDATE'
       AND (NEW.quantity_kg, NEW.harvest_id) IS DISTINCT FROM (OLD.quantity_kg, OLD.harvest_id)
       AND OLD.status <> 'CREATED' THEN
        PERFORM hc_raise('BATCH_LOCKED', 'batch quantity/harvest cannot change after testing starts');
    END IF;

    SELECT quantity_kg INTO v_harvest_qty FROM harvests
     WHERE harvest_id = NEW.harvest_id FOR UPDATE;          -- row lock

    SELECT COALESCE(SUM(quantity_kg), 0) INTO v_allocated FROM batches
     WHERE harvest_id = NEW.harvest_id
       AND batch_id <> COALESCE(NEW.batch_id, -1);

    IF v_allocated + NEW.quantity_kg > v_harvest_qty THEN
        PERFORM hc_raise('HARVEST_OVER_ALLOCATED',
            format('batches would total %s kg but harvest has only %s kg',
                   v_allocated + NEW.quantity_kg, v_harvest_qty));
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER batches_quantity BEFORE INSERT OR UPDATE OF quantity_kg, harvest_id ON batches
    FOR EACH ROW EXECUTE FUNCTION trg_batch_quantity();

-- R-B4  Lifecycle: only transitions listed in batch_status_transitions are legal.
--       Every change (and the initial CREATED) is written to batch_status_history.
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
    END IF;
    INSERT INTO batch_status_history (batch_id, from_status, to_status, changed_by)
    VALUES (NEW.batch_id,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
            NEW.status,
            app_current_user_id());
    RETURN NEW;
END $$;
CREATE TRIGGER batches_status AFTER INSERT OR UPDATE OF status ON batches
    FOR EACH ROW EXECUTE FUNCTION trg_batch_status();

-- R-B5  Lab assignment must point at a LABORATORY organization
CREATE OR REPLACE FUNCTION trg_batch_assigned_lab() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.assigned_lab_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM organizations WHERE org_id = NEW.assigned_lab_id
                                      AND org_type = 'LABORATORY' AND is_active) THEN
        PERFORM hc_raise('NOT_A_LAB', 'batches can only be assigned to an active laboratory');
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.assigned_lab_id IS DISTINCT FROM NEW.assigned_lab_id
       AND OLD.status <> 'CREATED' THEN
        PERFORM hc_raise('BATCH_LOCKED', 'laboratory cannot be changed after testing starts');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER batches_assigned_lab BEFORE INSERT OR UPDATE OF assigned_lab_id ON batches
    FOR EACH ROW EXECUTE FUNCTION trg_batch_assigned_lab();

-- ---------------------------------------------------------------------
-- R-L1  Lab report: tester must be LAB staff of that lab; batch must be
--       assigned to that lab and be in CREATED/IN_TESTING; sample received
--       on/after the batch was created.
-- R-L2  SUBMITTED reports are immutable and cannot be deleted.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_lab_report_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_batch batches%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.report_state = 'SUBMITTED' THEN
            PERFORM hc_raise('REPORT_IMMUTABLE', 'a submitted lab report cannot be deleted');
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND only_demo_flag_set(to_jsonb(OLD), to_jsonb(NEW)) THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.report_state = 'SUBMITTED' THEN
        PERFORM hc_raise('REPORT_IMMUTABLE', format('lab report %s is already submitted', OLD.report_code));
    END IF;

    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id;

    IF NOT user_is_staff_of(NEW.tested_by, NEW.lab_org_id, 'LAB') THEN
        PERFORM hc_raise('NOT_LAB_STAFF', 'tested_by must be active LAB staff of lab_org_id');
    END IF;
    IF v_batch.assigned_lab_id IS DISTINCT FROM NEW.lab_org_id THEN
        PERFORM hc_raise('LAB_NOT_ASSIGNED', format('batch %s is not assigned to this laboratory', v_batch.batch_code));
    END IF;
    IF v_batch.status NOT IN ('CREATED','IN_TESTING') THEN
        PERFORM hc_raise('BATCH_NOT_TESTABLE', format('batch %s is in status %s', v_batch.batch_code, v_batch.status));
    END IF;
    IF NEW.received_on < v_batch.created_at::date THEN
        PERFORM hc_raise('DATE_ORDER', 'sample received before the batch existed');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER lab_reports_rules BEFORE INSERT OR UPDATE OR DELETE ON lab_reports
    FOR EACH ROW EXECUTE FUNCTION trg_lab_report_rules();

-- ---------------------------------------------------------------------
-- R-P1  Processing: batch must be LAB_PASSED; recorder must be PROCESSOR
--       staff of that processor; input <= batch quantity; processing date on
--       or after the lab test date.
-- R-P2  Processing records are append-only (immutable once written).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_processing_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_batch     batches%ROWTYPE;
    v_tested_on DATE;
BEGIN
    IF TG_OP = 'UPDATE' AND only_demo_flag_set(to_jsonb(OLD), to_jsonb(NEW)) THEN
        RETURN NEW;
    END IF;
    IF TG_OP IN ('UPDATE','DELETE') THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'processing records are append-only');
    END IF;

    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id FOR UPDATE;
    IF v_batch.status <> 'LAB_PASSED' THEN
        PERFORM hc_raise('BATCH_NOT_PROCESSABLE', format('batch %s is in status %s', v_batch.batch_code, v_batch.status));
    END IF;
    IF NOT user_is_staff_of(NEW.recorded_by, NEW.processor_org_id, 'PROCESSOR') THEN
        PERFORM hc_raise('NOT_PROCESSOR_STAFF', 'recorded_by must be active PROCESSOR staff of processor_org_id');
    END IF;
    IF NEW.input_quantity_kg > v_batch.quantity_kg THEN
        PERFORM hc_raise('INPUT_EXCEEDS_BATCH',
            format('input %s kg exceeds batch quantity %s kg', NEW.input_quantity_kg, v_batch.quantity_kg));
    END IF;
    SELECT tested_on INTO v_tested_on FROM lab_reports
     WHERE batch_id = NEW.batch_id AND report_state = 'SUBMITTED';
    IF NEW.processing_date < v_tested_on THEN
        PERFORM hc_raise('DATE_ORDER', 'processing date is before the laboratory test date');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER processing_rules BEFORE INSERT OR UPDATE OR DELETE ON processing_records
    FOR EACH ROW EXECUTE FUNCTION trg_processing_rules();

-- ---------------------------------------------------------------------
-- R-S1  Shipment: batch must be PROCESSED/IN_DISTRIBUTION; recorder must be
--       DISTRIBUTOR staff; dispatch on/after packaging; total units shipped
--       (excluding cancelled) <= units packed  <- "distributed > processed" rule.
-- R-S2  Only status/delivered_on may change, and only along
--       DISPATCHED -> IN_TRANSIT -> DELIVERED (or -> CANCELLED before delivery).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_shipment_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_batch   batches%ROWTYPE;
    v_proc    processing_records%ROWTYPE;
    v_shipped INT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'shipments cannot be deleted; cancel them instead');
    END IF;

    IF TG_OP = 'UPDATE' THEN
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
    IF v_batch.status NOT IN ('PROCESSED','IN_DISTRIBUTION') THEN
        PERFORM hc_raise('BATCH_NOT_DISPATCHABLE', format('batch %s is in status %s', v_batch.batch_code, v_batch.status));
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
    SELECT COALESCE(SUM(units_shipped), 0) INTO v_shipped FROM shipments
     WHERE batch_id = NEW.batch_id AND status <> 'CANCELLED';
    IF v_shipped + NEW.units_shipped > v_proc.units_packed THEN
        PERFORM hc_raise('SHIPPED_EXCEEDS_PACKED',
            format('would ship %s units but only %s were packed', v_shipped + NEW.units_shipped, v_proc.units_packed));
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER shipments_rules BEFORE INSERT OR UPDATE OR DELETE ON shipments
    FOR EACH ROW EXECUTE FUNCTION trg_shipment_rules();

-- ---------------------------------------------------------------------
-- R-A1  An anchor's batch_id must be the batch the anchored record belongs to
-- R-A2  Anchors are never deleted (they are evidence)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_anchor_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_batch INT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'blockchain anchors are never deleted');
    END IF;
    -- Missing/extra FK columns are reported by CHECK anchor_entity_fk_matches
    IF num_nonnulls(NEW.lab_report_id, NEW.processing_id, NEW.shipment_id) <> 1
       AND NEW.entity_type <> 'BATCH_ORIGIN' THEN
        RETURN NEW;
    END IF;
    v_batch := CASE NEW.entity_type
        WHEN 'BATCH_ORIGIN'      THEN NEW.batch_id
        WHEN 'LAB_REPORT'        THEN (SELECT batch_id FROM lab_reports        WHERE lab_report_id = NEW.lab_report_id)
        WHEN 'PROCESSING_RECORD' THEN (SELECT batch_id FROM processing_records WHERE processing_id = NEW.processing_id)
        WHEN 'SHIPMENT'          THEN (SELECT batch_id FROM shipments          WHERE shipment_id   = NEW.shipment_id)
    END;
    IF v_batch IS DISTINCT FROM NEW.batch_id THEN
        PERFORM hc_raise('ANCHOR_BATCH_MISMATCH', 'anchor batch_id does not match the anchored record');
    END IF;
    IF NEW.entity_type = 'LAB_REPORT' AND NOT EXISTS (
        SELECT 1 FROM lab_reports WHERE lab_report_id = NEW.lab_report_id AND report_state = 'SUBMITTED') THEN
        PERFORM hc_raise('ANCHOR_DRAFT', 'only SUBMITTED lab reports can be anchored');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER anchors_rules BEFORE INSERT OR UPDATE OF entity_type, batch_id, lab_report_id, processing_id, shipment_id
    OR DELETE ON blockchain_anchors
    FOR EACH ROW EXECUTE FUNCTION trg_anchor_rules();

COMMIT;
