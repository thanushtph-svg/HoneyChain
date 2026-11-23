-- =====================================================================
-- 007  Automatic laboratory outcome + multi-step processing
--
-- A. Laboratory: the lab tester only enters measurements. The automatic analysis assigns the
--    outcome (PASS / FAIL / INCOMPLETE / ANALYSIS_ERROR). A report becomes SUBMITTED only with
--    the decision that matches its completed analysis (PASS <=> standards ALL_PASSED,
--    FAIL <=> standards FAILED). A human review step is no longer required.
-- B. Processing: a batch can have several processing steps (methods) saved independently.
--    Saving a step never finalizes. The existing processing_records row is the explicit
--    "Finalize Processing" record (unchanged, still anchored on the blockchain).
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------- A. automatic lab outcome
ALTER TABLE lab_report_analyses
    ADD COLUMN automatic_outcome VARCHAR(14)
        CHECK (automatic_outcome IN ('PASS','FAIL','INCOMPLETE','ANALYSIS_ERROR'));
UPDATE lab_report_analyses SET automatic_outcome = CASE
        WHEN status = 'FAILED' THEN 'ANALYSIS_ERROR'
        WHEN standards_status = 'ALL_PASSED' THEN 'PASS'
        WHEN standards_status = 'FAILED' THEN 'FAIL'
        WHEN standards_status = 'INCOMPLETE' THEN 'INCOMPLETE' END
  WHERE automatic_outcome IS NULL AND status <> 'PENDING';

-- the decision is automatic, so it no longer requires a prior human review
ALTER TABLE lab_report_analyses DROP CONSTRAINT lan_decision_after_review;

CREATE OR REPLACE FUNCTION trg_lab_analysis_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_rep lab_reports%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'lab analyses are never deleted');
    END IF;
    SELECT * INTO v_rep FROM lab_reports WHERE lab_report_id = NEW.lab_report_id;
    IF v_rep.batch_id IS DISTINCT FROM NEW.batch_id THEN
        PERFORM hc_raise('ANALYSIS_BATCH_MISMATCH', 'analysis batch_id must match its lab report');
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- normal path: a draft; corrected reports are analysed inside the approved-correction transaction
        IF v_rep.report_state <> 'DRAFT' AND NULLIF(current_setting('app.lab_correction', true), '') IS NULL THEN
            PERFORM hc_raise('REPORT_IMMUTABLE', 'only draft lab reports can be analysed');
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status = 'COMPLETED' AND (
         NEW.status, NEW.standards_status, NEW.ml_status, NEW.overall_status, NEW.mongo_report_id, NEW.values_fingerprint,
         NEW.honey_category, NEW.standards_profile, NEW.lab_report_id, NEW.automatic_outcome)
       IS DISTINCT FROM (
         OLD.status, OLD.standards_status, OLD.ml_status, OLD.overall_status, OLD.mongo_report_id, OLD.values_fingerprint,
         OLD.honey_category, OLD.standards_profile, OLD.lab_report_id, OLD.automatic_outcome) THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'a completed analysis cannot be changed');
    END IF;
    IF OLD.reviewed_at IS NOT NULL AND (NEW.reviewed_by, NEW.reviewed_at, NEW.review_comment)
                                       IS DISTINCT FROM (OLD.reviewed_by, OLD.reviewed_at, OLD.review_comment) THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'an analysis review is recorded once');
    END IF;
    IF OLD.decided_at IS NOT NULL AND (NEW.final_decision, NEW.decided_by, NEW.decided_at, NEW.decision_comment, NEW.flagged_for_review)
                                      IS DISTINCT FROM (OLD.final_decision, OLD.decided_by, OLD.decided_at, OLD.decision_comment, OLD.flagged_for_review) THEN
        PERFORM hc_raise('RECORD_IMMUTABLE', 'the final decision on an analysis is recorded once');
    END IF;
    IF NEW.reviewed_by IS NOT NULL AND OLD.reviewed_by IS NULL
       AND NOT user_is_staff_of(NEW.reviewed_by, v_rep.lab_org_id, 'LAB_TESTER') THEN
        PERFORM hc_raise('NOT_LAB_STAFF', 'only a LAB_TESTER of the reporting laboratory can review the analysis');
    END IF;
    RETURN NEW;
END $$;

-- Approval gate: the decision must be exactly the automatic outcome of a completed analysis of the current values
CREATE OR REPLACE FUNCTION trg_lab_report_requires_analysis() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_a lab_report_analyses%ROWTYPE;
BEGIN
    IF NOT (OLD.report_state = 'DRAFT' AND NEW.report_state = 'SUBMITTED') THEN
        RETURN NEW;
    END IF;
    IF NEW.ai_analysis_id IS NULL THEN
        PERFORM hc_raise('ANALYSIS_REQUIRED', format('lab report %s cannot be submitted without an automatic analysis', NEW.report_code));
    END IF;
    SELECT * INTO v_a FROM lab_report_analyses WHERE analysis_id = NEW.ai_analysis_id;
    IF v_a.lab_report_id IS DISTINCT FROM NEW.lab_report_id THEN
        PERFORM hc_raise('ANALYSIS_MISMATCH', 'the analysis belongs to a different lab report');
    END IF;
    IF v_a.status <> 'COMPLETED' THEN
        PERFORM hc_raise('ANALYSIS_NOT_COMPLETED', format('analysis %s is %s', v_a.analysis_code, v_a.status));
    END IF;
    IF v_a.standards_status = 'INCOMPLETE' THEN
        PERFORM hc_raise('MANDATORY_TESTS_MISSING', 'all mandatory laboratory tests must be present and valid');
    END IF;
    IF v_a.values_fingerprint <> lab_report_values_fingerprint(NEW) THEN
        PERFORM hc_raise('ANALYSIS_STALE', 'the measurements changed after the analysis');
    END IF;
    -- (a missing or unknown decision is left to the CHECK constraints)
    IF NEW.decision IN ('PASS','FAIL','INCONCLUSIVE') AND NEW.decision IS DISTINCT FROM v_a.automatic_outcome THEN
        PERFORM hc_raise('AUTO_DECISION_MISMATCH', format('the laboratory outcome is assigned automatically (%s); it cannot be set to %s',
            v_a.automatic_outcome, NEW.decision));
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------- B. processing steps
CREATE SEQUENCE processing_step_code_seq;
CREATE TABLE processing_steps (
    step_id           SERIAL        PRIMARY KEY,
    step_code         VARCHAR(20)   NOT NULL UNIQUE
                      DEFAULT ('PST-' || to_char(CURRENT_DATE,'YYYY') || '-' || lpad(nextval('processing_step_code_seq')::text, 6, '0')),
    batch_id          INT           NOT NULL REFERENCES batches(batch_id) ON DELETE RESTRICT,
    processor_org_id  INT           NOT NULL REFERENCES organizations(org_id),
    recorded_by       INT           NOT NULL REFERENCES users(user_id),
    step_no           SMALLINT      NOT NULL CHECK (step_no >= 1),
    method            VARCHAR(20)   NOT NULL
                      CHECK (method IN ('FILTRATION','STRAINING','SETTLING','GENTLE_WARMING','CREAMING','OTHER')),
    step_date         DATE          NOT NULL CHECK (step_date <= CURRENT_DATE),
    details           TEXT,
    parameters        JSONB         NOT NULL DEFAULT '{}'::jsonb,
    is_demo           BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (batch_id, step_no)
);
CREATE INDEX processing_steps_batch_idx ON processing_steps (batch_id, step_no);

-- Steps are added/removed only while the batch is IN_PROCESSING with the recording unit; never edited.
CREATE OR REPLACE FUNCTION trg_processing_step_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_status TEXT; v_row processing_steps%ROWTYPE;
BEGIN
    v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    IF TG_OP = 'UPDATE' THEN
        IF only_demo_flag_set(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
        PERFORM hc_raise('RECORD_IMMUTABLE', 'a saved processing step cannot be edited; remove it and add a new one');
    END IF;
    SELECT status INTO v_status FROM batches WHERE batch_id = v_row.batch_id;
    IF v_status <> 'IN_PROCESSING' THEN
        PERFORM hc_raise('PROCESSING_FINALIZED', format('processing steps can only change while the batch is IN_PROCESSING (it is %s)', v_status));
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF batch_processor_org(NEW.batch_id) IS DISTINCT FROM NEW.processor_org_id THEN
            PERFORM hc_raise('NOT_CUSTODIAN', 'only the processing unit that accepted the batch can record processing steps');
        END IF;
        IF NOT user_is_staff_of(NEW.recorded_by, NEW.processor_org_id, 'PROCESSOR') THEN
            PERFORM hc_raise('NOT_PROCESSOR_STAFF', 'recorded_by must be an active PROCESSOR of the processing unit');
        END IF;
        RETURN NEW;
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER processing_step_rules BEFORE INSERT OR UPDATE OR DELETE ON processing_steps
    FOR EACH ROW EXECUTE FUNCTION trg_processing_step_rules();

COMMIT;
