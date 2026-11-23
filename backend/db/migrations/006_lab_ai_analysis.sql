-- =====================================================================
-- 006  Compulsory automatic laboratory analysis (AI lab analysis subsystem)
--
--  * lab_report_analyses : one row per analysis attempt of a lab report's values. The full
--    structured report lives in MongoDB (ai_analysis_results, analysisType LAB_ANALYSIS);
--    PostgreSQL keeps the reference, statuses, review and final-decision audit fields.
--  * lab_reports.ai_analysis_id : the analysis the laboratory approved against.
--  * A lab report can move DRAFT -> SUBMITTED only with a COMPLETED, REVIEWED, non-INCOMPLETE
--    analysis of exactly its current values (enforced here as well as in the API).
--  * Existing submitted reports are untouched (legacy, approved before this feature).
--  * The blockchain hash of a lab report is unchanged (canonical field list does not include
--    the new column), so existing anchors stay valid.
-- =====================================================================
BEGIN;

-- Deterministic fingerprint of the values an analysis was run on.
CREATE OR REPLACE FUNCTION lab_report_values_fingerprint(r lab_reports) RETURNS CHAR(64)
LANGUAGE sql IMMUTABLE AS $$
    SELECT encode(sha256(convert_to(concat_ws('|',
        coalesce(r.moisture_pct::text, ''), coalesce(r.hmf_mg_kg::text, ''), coalesce(r.sucrose_g_100g::text, ''),
        coalesce(r.glucose_g_100g::text, ''), coalesce(r.fructose_g_100g::text, ''), coalesce(r.brix::text, ''),
        coalesce(r.ph::text, ''), coalesce(r.free_acidity_meq_kg::text, ''), coalesce(r.water_activity::text, ''),
        coalesce(r.electrical_conductivity_ms_cm::text, '')), 'UTF8')), 'hex')
$$;

CREATE SEQUENCE lab_analysis_code_seq;

CREATE TABLE lab_report_analyses (
    analysis_id         SERIAL        PRIMARY KEY,
    analysis_code       VARCHAR(20)   NOT NULL UNIQUE
                        DEFAULT ('LAN-' || to_char(CURRENT_DATE,'YYYY') || '-' || lpad(nextval('lab_analysis_code_seq')::text, 6, '0')),
    lab_report_id       INT           NOT NULL REFERENCES lab_reports(lab_report_id) ON DELETE RESTRICT,
    batch_id            INT           NOT NULL REFERENCES batches(batch_id) ON DELETE RESTRICT,
    values_fingerprint  CHAR(64)      NOT NULL,
    honey_category      VARCHAR(30)   NOT NULL,
    standards_profile   VARCHAR(10)   NOT NULL,
    status              VARCHAR(10)   NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','FAILED')),
    standards_status    VARCHAR(12)   CHECK (standards_status IN ('ALL_PASSED','FAILED','INCOMPLETE')),
    ml_status           VARCHAR(22)   CHECK (ml_status IN ('PREDICTION_AVAILABLE','NOT_TRAINED','NOT_AVAILABLE','INSUFFICIENT_INPUT')),
    overall_status      VARCHAR(28)   CHECK (overall_status IN ('COMPLETED','COMPLETED_WITH_LIMITATIONS','INCOMPLETE','FAILED')),
    mongo_report_id     CHAR(24)      CHECK (mongo_report_id ~ '^[0-9a-f]{24}$'),
    ruleset_version     VARCHAR(20),
    ml_model_version    VARCHAR(40),
    failure_reason      TEXT,
    attempts            SMALLINT      NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    requested_by        INT           NOT NULL REFERENCES users(user_id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    -- human review and final decision (audit)
    reviewed_by         INT           REFERENCES users(user_id),
    reviewed_at         TIMESTAMPTZ,
    review_comment      TEXT,
    final_decision      VARCHAR(12)   CHECK (final_decision IN ('PASS','FAIL','INCONCLUSIVE')),
    decision_comment    TEXT,
    decided_by          INT           REFERENCES users(user_id),
    decided_at          TIMESTAMPTZ,
    flagged_for_review  BOOLEAN       NOT NULL DEFAULT FALSE,
    is_demo             BOOLEAN       NOT NULL DEFAULT FALSE,
    CONSTRAINT lan_completed_has_report CHECK (
        status <> 'COMPLETED' OR (mongo_report_id IS NOT NULL AND standards_status IS NOT NULL AND ml_status IS NOT NULL
                                  AND overall_status IS NOT NULL AND completed_at IS NOT NULL)),
    CONSTRAINT lan_failed_has_reason CHECK (status <> 'FAILED' OR failure_reason IS NOT NULL),
    CONSTRAINT lan_review_complete CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
    CONSTRAINT lan_review_after_completion CHECK (reviewed_at IS NULL OR status = 'COMPLETED'),
    CONSTRAINT lan_decision_complete CHECK ((final_decision IS NULL) = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL)),
    CONSTRAINT lan_decision_after_review CHECK (decided_at IS NULL OR reviewed_at IS NOT NULL),
    -- duplicate submissions of the same values/category/profile reuse one analysis
    CONSTRAINT lan_one_per_input UNIQUE (lab_report_id, values_fingerprint, honey_category, standards_profile)
);
CREATE INDEX lan_report_recent_idx ON lab_report_analyses (lab_report_id, created_at DESC);

ALTER TABLE lab_reports ADD COLUMN ai_analysis_id INT REFERENCES lab_report_analyses(analysis_id);

-- Analysis rows: completed results are immutable; review and decision are written once.
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
        IF v_rep.report_state <> 'DRAFT' THEN
            PERFORM hc_raise('REPORT_IMMUTABLE', 'only draft lab reports can be analysed');
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status = 'COMPLETED' AND (
         NEW.status, NEW.standards_status, NEW.ml_status, NEW.overall_status, NEW.mongo_report_id, NEW.values_fingerprint,
         NEW.honey_category, NEW.standards_profile, NEW.lab_report_id)
       IS DISTINCT FROM (
         OLD.status, OLD.standards_status, OLD.ml_status, OLD.overall_status, OLD.mongo_report_id, OLD.values_fingerprint,
         OLD.honey_category, OLD.standards_profile, OLD.lab_report_id) THEN
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
CREATE TRIGGER lab_analysis_rules BEFORE INSERT OR UPDATE OR DELETE ON lab_report_analyses
    FOR EACH ROW EXECUTE FUNCTION trg_lab_analysis_rules();

-- Approval gate: DRAFT -> SUBMITTED requires a completed, reviewed analysis of the current values.
CREATE OR REPLACE FUNCTION trg_lab_report_requires_analysis() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_a lab_report_analyses%ROWTYPE;
BEGIN
    IF NOT (OLD.report_state = 'DRAFT' AND NEW.report_state = 'SUBMITTED') THEN
        RETURN NEW;
    END IF;
    IF NEW.ai_analysis_id IS NULL THEN
        PERFORM hc_raise('ANALYSIS_REQUIRED', format('lab report %s cannot be approved without an automatic analysis report', NEW.report_code));
    END IF;
    SELECT * INTO v_a FROM lab_report_analyses WHERE analysis_id = NEW.ai_analysis_id;
    IF v_a.lab_report_id IS DISTINCT FROM NEW.lab_report_id THEN
        PERFORM hc_raise('ANALYSIS_MISMATCH', 'the analysis belongs to a different lab report');
    END IF;
    IF v_a.status <> 'COMPLETED' THEN
        PERFORM hc_raise('ANALYSIS_NOT_COMPLETED', format('analysis %s is %s', v_a.analysis_code, v_a.status));
    END IF;
    IF v_a.standards_status = 'INCOMPLETE' THEN
        PERFORM hc_raise('MANDATORY_TESTS_MISSING', 'all mandatory laboratory tests must be present before approval');
    END IF;
    IF v_a.values_fingerprint <> lab_report_values_fingerprint(NEW) THEN
        PERFORM hc_raise('ANALYSIS_STALE', 'the measurements changed after the analysis; run the analysis again');
    END IF;
    IF v_a.reviewed_at IS NULL THEN
        PERFORM hc_raise('ANALYSIS_NOT_REVIEWED', 'the laboratory tester must review the analysis report before approval');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER lab_reports_require_analysis BEFORE UPDATE ON lab_reports
    FOR EACH ROW EXECUTE FUNCTION trg_lab_report_requires_analysis();

-- Failed-standard policy for lab approval
INSERT INTO app_settings (setting_key, value, description) VALUES
 ('lab_failed_standard_policy', '"FLAG_FOR_REVIEW"',
  'When a mandatory standard fails: FLAG_FOR_REVIEW = a PASS decision needs a written justification (min. 30 characters) and is flagged; BLOCK_PASS = PASS is not allowed')
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;
