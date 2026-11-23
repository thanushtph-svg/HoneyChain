-- =====================================================================
-- HoneyChain - schema self-test
-- Runs the full lifecycle plus every rule violation we expect the DB to
-- reject, then ROLLS BACK (leaves the database unchanged).
--
-- Run:  psql -v ON_ERROR_STOP=1 -o NUL -d <db> -f backend/db/tests/schema_tests.sql   (Windows; use -o /dev/null on Linux)
-- Every check prints "PASS: ..." ; any failure stops with an error.
-- =====================================================================
\set QUIET on
BEGIN;

-- Helper: run a statement and require it to FAIL with a given message fragment
CREATE FUNCTION pg_temp.expect_error(p_sql TEXT, p_fragment TEXT, p_label TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        IF position(p_fragment IN SQLERRM) > 0 THEN
            RAISE NOTICE 'PASS: % (rejected: %)', p_label, SQLERRM;
            RETURN;
        END IF;
        RAISE EXCEPTION 'FAIL: % - wrong error: %', p_label, SQLERRM;
    END;
    RAISE EXCEPTION 'FAIL: % - statement was accepted but should have been rejected', p_label;
END $$;

CREATE FUNCTION pg_temp.ok(p_cond BOOLEAN, p_label TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF p_cond THEN RAISE NOTICE 'PASS: %', p_label;
    ELSE RAISE EXCEPTION 'FAIL: %', p_label; END IF;
END $$;

-- ---------------- roles, organizations & users ----------------
SELECT pg_temp.ok((SELECT string_agg(role_code, ',' ORDER BY role_code) FROM roles)
                  = 'ADMIN,BEEKEEPER,CONSUMER,DISTRIBUTOR,LAB_TESTER,PROCESSOR', 'exactly the six roles exist');

INSERT INTO organizations (org_id, name, org_type, city, state) VALUES
 (901, 'Test Honey Lab',        'LABORATORY',  'Bengaluru', 'Karnataka'),
 (902, 'Test Processing Unit',  'PROCESSOR',   'Mysuru',    'Karnataka'),
 (903, 'Test Logistics',        'DISTRIBUTOR', 'Bengaluru', 'Karnataka'),
 (904, 'Other Processing Unit', 'PROCESSOR',   'Hubballi',  'Karnataka');

INSERT INTO users (user_id, email, password_hash, full_name, role_code, org_id) VALUES
 (901, 'bk@test.local',    'x', 'Test Beekeeper',   'BEEKEEPER',   NULL),
 (902, 'lab@test.local',   'x', 'Test Lab Tester',  'LAB_TESTER',  901),
 (903, 'proc@test.local',  'x', 'Test Processor',   'PROCESSOR',   902),
 (904, 'dist@test.local',  'x', 'Test Distributor', 'DISTRIBUTOR', 903),
 (905, 'bk2@test.local',   'x', 'Other Beekeeper',  'BEEKEEPER',   NULL),
 (906, 'admin@test.local', 'x', 'Test Admin',       'ADMIN',       NULL),
 (907, 'cons@test.local',  'x', 'Test Consumer',    'CONSUMER',    NULL),
 (908, 'proc2@test.local', 'x', 'Other Processor',  'PROCESSOR',   904);

SELECT pg_temp.expect_error($$INSERT INTO users (email,password_hash,full_name,role_code,org_id)
    VALUES ('BK@TEST.local','x','dup','ADMIN',NULL)$$, 'users_email_lower_uq', 'email unique ignoring case');
SELECT pg_temp.expect_error($$INSERT INTO users (email,password_hash,full_name,role_code,org_id)
    VALUES ('nolab@test.local','x','n','LAB_TESTER',NULL)$$, 'users_org_matches_role', 'LAB_TESTER must have an organization');
SELECT pg_temp.expect_error($$INSERT INTO users (email,password_hash,full_name,role_code,org_id)
    VALUES ('wrong@test.local','x','n','LAB_TESTER',902)$$, 'ORG_ROLE_MISMATCH', 'LAB_TESTER cannot belong to a PROCESSOR org');
SELECT pg_temp.expect_error($$INSERT INTO users (email,password_hash,full_name,role_code,org_id)
    VALUES ('c2@test.local','x','n','CONSUMER',903)$$, 'users_org_matches_role', 'CONSUMER cannot belong to an organization');
SELECT pg_temp.expect_error($$INSERT INTO users (email,password_hash,full_name,role_code,org_id)
    VALUES ('old@test.local','x','n','LAB',NULL)$$, 'users_role_code_fkey', 'legacy role LAB no longer exists');
SELECT pg_temp.expect_error($$INSERT INTO users (email,password_hash,full_name,role_code,org_id)
    VALUES ('bad-email','x','n','ADMIN',NULL)$$, 'users_email_check', 'email format check');

-- role changes are audited by a trigger
SELECT set_config('app.user_id', '906', true);
UPDATE users SET role_code = 'DISTRIBUTOR', org_id = 903 WHERE user_id = 908;
SELECT pg_temp.ok((SELECT count(*) FROM user_role_changes WHERE user_id = 908 AND old_role = 'PROCESSOR' AND new_role = 'DISTRIBUTOR' AND changed_by = 906) = 1,
                  'role change recorded with the acting admin');
UPDATE users SET role_code = 'PROCESSOR', org_id = 904 WHERE user_id = 908;

-- ---------------- beekeeper, hive, harvest ----------------
INSERT INTO beekeepers (beekeeper_id, user_id, public_display_name, show_name_publicly, district, state)
VALUES (901, 901, 'Lakshmi Devi (demo)', TRUE, 'Chikkaballapur', 'Karnataka');
SELECT pg_temp.expect_error($$INSERT INTO beekeepers (user_id, public_display_name, district, state)
    VALUES (902,'x','d','s')$$, 'NOT_A_BEEKEEPER', 'beekeeper profile requires BEEKEEPER user');

INSERT INTO hives (hive_id, beekeeper_id, hive_type, bee_species, apiary_location, district, state, installed_on)
VALUES (901, 901, 'NEWTON', 'Apis cerana indica', 'Near village tank', 'Chikkaballapur', 'Karnataka', CURRENT_DATE - 400);

SELECT pg_temp.expect_error($$INSERT INTO harvests (hive_id,harvest_date,quantity_kg,floral_source,recorded_by)
    VALUES (901, CURRENT_DATE + 1, 10, 'Multifloral', 901)$$, 'harvests_harvest_date_check', 'harvest date cannot be in the future');
SELECT pg_temp.expect_error($$INSERT INTO harvests (hive_id,harvest_date,quantity_kg,floral_source,recorded_by)
    VALUES (901, CURRENT_DATE - 500, 10, 'Multifloral', 901)$$, 'HARVEST_BEFORE_HIVE', 'harvest before hive installation');
SELECT pg_temp.expect_error($$INSERT INTO harvests (hive_id,harvest_date,quantity_kg,floral_source,recorded_by)
    VALUES (901, CURRENT_DATE - 30, 0, 'Multifloral', 901)$$, 'harvests_quantity_kg_check', 'harvest quantity must be > 0');

INSERT INTO harvests (harvest_id, hive_id, harvest_date, quantity_kg, floral_source, recorded_by)
VALUES (901, 901, CURRENT_DATE - 30, 20.00, 'Multifloral', 901);
SELECT pg_temp.ok((SELECT harvest_code FROM harvests WHERE harvest_id = 901) ~ '^HRV-\d{4}-\d{6}$', 'harvest code generated');

-- ---------------- batches (split one harvest into two) ----------------
SELECT set_config('app.user_id', '901', true);
INSERT INTO batches (batch_id, harvest_id, quantity_kg, honey_type, created_by) VALUES
 (901, 901, 12.00, 'Multifloral', 901),
 (902, 901,  8.00, 'Multifloral', 901);
SELECT pg_temp.ok((SELECT batch_code FROM batches WHERE batch_id = 901) ~ '^HC-\d{4}-\d{6}$', 'batch code generated');
SELECT pg_temp.ok((SELECT count(*) FROM batch_status_history WHERE batch_id IN (901,902) AND to_status='CREATED' AND changed_by=901) = 2,
                  'initial CREATED status recorded in history with acting user');

SELECT pg_temp.expect_error($$INSERT INTO batches (harvest_id,quantity_kg,honey_type,created_by)
    VALUES (901, 0.50, 'Multifloral', 901)$$, 'HARVEST_OVER_ALLOCATED', 'batches cannot exceed harvest quantity');
SELECT pg_temp.expect_error($$UPDATE harvests SET quantity_kg = 25 WHERE harvest_id = 901$$,
    'HARVEST_LOCKED', 'harvest frozen once batches exist');
SELECT pg_temp.expect_error($$INSERT INTO batches (harvest_id,quantity_kg,honey_type,created_by,status)
    VALUES (901, 0.1, 'Multifloral', 901, 'LAB_PASSED')$$, 'BAD_INITIAL_STATUS', 'new batch must start CREATED');
SELECT pg_temp.expect_error($$UPDATE batches SET status = 'PROCESSED' WHERE batch_id = 901$$,
    'INVALID_TRANSITION', 'cannot skip the custody transfer (CREATED -> PROCESSED)');

-- ---------------- custody: beekeeper -> processor ----------------
SELECT pg_temp.expect_error($$INSERT INTO batch_transfers (batch_id,transfer_type,to_org_id,quantity_kg,initiated_by)
    VALUES (901,'TO_PROCESSOR',902,12,905)$$, 'NOT_OWNER', 'only the owning beekeeper can send a batch');
SELECT pg_temp.expect_error($$INSERT INTO batch_transfers (batch_id,transfer_type,to_org_id,quantity_kg,initiated_by)
    VALUES (901,'TO_PROCESSOR',901,12,901)$$, 'NOT_A_PROCESSOR', 'a beekeeper can only send to a processor');
SELECT pg_temp.expect_error($$INSERT INTO batch_transfers (batch_id,transfer_type,to_org_id,quantity_kg,initiated_by)
    VALUES (901,'TO_PROCESSOR',902,5,901)$$, 'QUANTITY_MISMATCH', 'the whole batch quantity is transferred');

INSERT INTO batch_transfers (transfer_id, batch_id, transfer_type, to_org_id, quantity_kg, initiated_by)
VALUES (901, 901, 'TO_PROCESSOR', 902, 12.00, 901), (902, 902, 'TO_PROCESSOR', 902, 8.00, 901);
SELECT pg_temp.ok((SELECT status FROM batches WHERE batch_id = 901) = 'PENDING_PROCESSOR', 'transfer puts the batch in PENDING_PROCESSOR');
SELECT pg_temp.expect_error($$INSERT INTO batch_transfers (batch_id,transfer_type,to_org_id,quantity_kg,initiated_by)
    VALUES (901,'TO_PROCESSOR',904,12,901)$$, 'BATCH_NOT_TRANSFERABLE', 'a batch cannot be sent twice');
SELECT pg_temp.expect_error($$UPDATE batch_transfers SET status='ACCEPTED', responded_by=908, responded_at=now() WHERE transfer_id=901$$,
    'NOT_RECEIVER', 'another processor cannot accept the transfer');
SELECT pg_temp.expect_error($$UPDATE batch_transfers SET status='REJECTED', responded_by=903, responded_at=now() WHERE transfer_id=902$$,
    'transfer_reject_has_reason', 'rejection needs a reason');

SELECT set_config('app.user_id', '903', true);
UPDATE batch_transfers SET status='REJECTED', responded_by=903, responded_at=now(), response_reason='Containers leaking' WHERE transfer_id=902;
SELECT pg_temp.ok((SELECT status FROM batches WHERE batch_id = 902) = 'CREATED', 'rejected batch returns to the beekeeper');
UPDATE batch_transfers SET status='ACCEPTED', responded_by=903, responded_at=now() WHERE transfer_id=901;
SELECT pg_temp.ok((SELECT status FROM batches WHERE batch_id = 901) = 'IN_PROCESSING', 'accepted batch is IN_PROCESSING');
SELECT pg_temp.ok(batch_processor_org(901) = 902, 'custodian processor derived from the accepted transfer');
SELECT pg_temp.expect_error($$UPDATE batch_transfers SET status='PENDING', responded_by=NULL, responded_at=NULL WHERE transfer_id=901$$,
    'RECORD_IMMUTABLE', 'an answered transfer cannot change');
SELECT pg_temp.expect_error($$DELETE FROM batch_transfers WHERE transfer_id = 902$$, 'RECORD_IMMUTABLE', 'transfers are never deleted');

-- ---------------- processing ----------------
SELECT pg_temp.expect_error($$INSERT INTO processing_records (batch_id,processor_org_id,recorded_by,processing_date,method,
    operator_name,input_quantity_kg,output_quantity_kg,packaging_date,packaging_type,unit_size_g,units_packed,best_before)
    VALUES (902,902,903,CURRENT_DATE,'FILTRATION','Op',8,7.8,CURRENT_DATE,'GLASS_JAR',500,10,CURRENT_DATE+365)$$,
    'BATCH_NOT_PROCESSABLE', 'a batch not accepted by the processor cannot be processed');
SELECT pg_temp.expect_error($$INSERT INTO processing_records (batch_id,processor_org_id,recorded_by,processing_date,method,
    operator_name,input_quantity_kg,output_quantity_kg,packaging_date,packaging_type,unit_size_g,units_packed,best_before)
    VALUES (901,904,908,CURRENT_DATE,'FILTRATION','Op',12,11.8,CURRENT_DATE,'GLASS_JAR',500,20,CURRENT_DATE+365)$$,
    'NOT_CUSTODIAN', 'another processing unit cannot record processing');
SELECT pg_temp.expect_error($$INSERT INTO processing_records (batch_id,processor_org_id,recorded_by,processing_date,method,
    operator_name,input_quantity_kg,output_quantity_kg,packaging_date,packaging_type,unit_size_g,units_packed,best_before)
    VALUES (901,902,903,CURRENT_DATE,'FILTRATION','Op',13,12,CURRENT_DATE,'GLASS_JAR',500,20,CURRENT_DATE+365)$$,
    'INPUT_EXCEEDS_BATCH', 'processing input cannot exceed batch quantity');
SELECT pg_temp.expect_error($$INSERT INTO processing_records (batch_id,processor_org_id,recorded_by,processing_date,method,
    operator_name,input_quantity_kg,output_quantity_kg,packaging_date,packaging_type,unit_size_g,units_packed,best_before)
    VALUES (901,902,903,CURRENT_DATE,'FILTRATION','Op',12,11.8,CURRENT_DATE,'GLASS_JAR',500,30,CURRENT_DATE+365)$$,
    'proc_packed_le_output', 'packed mass cannot exceed processed output');

-- processing steps (migration 007): several methods per batch, each saved independently, never edited
INSERT INTO processing_steps (batch_id, processor_org_id, recorded_by, step_no, method, step_date, parameters)
VALUES (901, 902, 903, 1, 'FILTRATION', CURRENT_DATE, '{"meshMicron": 200}'),
       (901, 902, 903, 2, 'SETTLING', CURRENT_DATE, '{"durationHours": 24}');
SELECT pg_temp.ok((SELECT count(*) FROM processing_steps WHERE batch_id = 901) = 2, 'two processing methods saved for one batch');
SELECT pg_temp.ok((SELECT status FROM batches WHERE batch_id = 901) = 'IN_PROCESSING', 'saving steps does not finalize processing');
SELECT pg_temp.expect_error($$INSERT INTO processing_steps (batch_id, processor_org_id, recorded_by, step_no, method, step_date)
    VALUES (901, 902, 903, 2, 'CREAMING', CURRENT_DATE)$$, 'processing_steps_batch_id_step_no_key', 'a step cannot overwrite another step');
SELECT pg_temp.expect_error($$UPDATE processing_steps SET method = 'OTHER' WHERE batch_id = 901 AND step_no = 1$$,
    'RECORD_IMMUTABLE', 'a saved processing step cannot be edited');
SELECT pg_temp.expect_error($$INSERT INTO processing_steps (batch_id, processor_org_id, recorded_by, step_no, method, step_date)
    VALUES (901, 904, 908, 3, 'OTHER', CURRENT_DATE)$$, 'NOT_CUSTODIAN', 'another unit cannot add processing steps');

INSERT INTO processing_records (processing_id, batch_id, processor_org_id, recorded_by, processing_date, method,
    operator_name, input_quantity_kg, output_quantity_kg, packaging_date, packaging_type, unit_size_g, units_packed, best_before)
VALUES (901, 901, 902, 903, CURRENT_DATE, 'FILTRATION', 'Operator A', 12.00, 11.80, CURRENT_DATE,
        'GLASS_JAR', 500, 23, CURRENT_DATE + 540);
UPDATE batches SET status = 'PROCESSED' WHERE batch_id = 901;
SELECT pg_temp.expect_error($$INSERT INTO processing_steps (batch_id, processor_org_id, recorded_by, step_no, method, step_date)
    VALUES (901, 902, 903, 3, 'OTHER', CURRENT_DATE)$$, 'PROCESSING_FINALIZED', 'no steps can be added after finalization');
SELECT pg_temp.expect_error($$DELETE FROM processing_steps WHERE batch_id = 901$$, 'PROCESSING_FINALIZED', 'steps are locked after finalization');

SELECT pg_temp.expect_error($$UPDATE processing_records SET units_packed = 1 WHERE processing_id = 901$$,
    'RECORD_IMMUTABLE', 'processing record is append-only');
UPDATE processing_records SET is_demo = TRUE WHERE processing_id = 901;
SELECT pg_temp.ok((SELECT is_demo FROM processing_records WHERE processing_id = 901), 'record may be labelled as demo data');
SELECT pg_temp.expect_error($$UPDATE processing_records SET is_demo = FALSE WHERE processing_id = 901$$,
    'RECORD_IMMUTABLE', 'demo label can never be removed');

-- ---------------- laboratory: request -> accept -> result ----------------
SELECT pg_temp.expect_error($$INSERT INTO batch_transfers (batch_id,transfer_type,from_org_id,to_org_id,quantity_kg,units,initiated_by)
    VALUES (901,'TO_DISTRIBUTOR',902,903,11.80,23,903)$$, 'BATCH_NOT_TRANSFERABLE', 'no distribution before a PASS result');
SELECT pg_temp.expect_error($$INSERT INTO lab_reports (batch_id,lab_org_id,tested_by,sample_code,received_on,tested_on,
    moisture_pct,hmf_mg_kg,sucrose_g_100g,pollen_identification) VALUES
    (901,901,902,'S-1',CURRENT_DATE,CURRENT_DATE,17.8,9.6,3.1,'Multifloral')$$,
    'NO_ACCEPTED_REQUEST', 'lab cannot test without an accepted request');
SELECT pg_temp.expect_error($$INSERT INTO lab_test_requests (batch_id,lab_org_id,requester_org_id,requested_by)
    VALUES (901,901,904,908)$$, 'NOT_CUSTODIAN', 'only the custodian processor can request testing');

INSERT INTO lab_test_requests (request_id, batch_id, lab_org_id, requester_org_id, requested_by) VALUES (901, 901, 901, 902, 903);
SELECT pg_temp.ok((SELECT status FROM batches WHERE batch_id = 901) = 'PENDING_LAB', 'testing request puts the batch in PENDING_LAB');
SELECT pg_temp.expect_error($$INSERT INTO lab_test_requests (batch_id,lab_org_id,requester_org_id,requested_by)
    VALUES (901,901,902,903)$$, 'BATCH_NOT_TESTABLE', 'only one open testing request');
SELECT pg_temp.expect_error($$UPDATE lab_test_requests SET status='ACCEPTED', responded_by=903, responded_at=now() WHERE request_id=901$$,
    'NOT_LAB_STAFF', 'only the requested laboratory can accept');
SELECT set_config('app.user_id', '902', true);
UPDATE lab_test_requests SET status='ACCEPTED', responded_by=902, responded_at=now() WHERE request_id=901;
SELECT pg_temp.ok((SELECT status FROM batches WHERE batch_id = 901) = 'IN_TESTING', 'accepted request puts the batch IN_TESTING');

SELECT pg_temp.expect_error($$INSERT INTO lab_reports (batch_id,lab_org_id,tested_by,request_id,sample_code,received_on,tested_on,
    moisture_pct,hmf_mg_kg,sucrose_g_100g,pollen_identification) VALUES
    (901,901,903,901,'S-1',CURRENT_DATE,CURRENT_DATE,17.8,9.6,3.1,'Multifloral')$$,
    'NOT_LAB_STAFF', 'only LAB_TESTER staff of that lab can enter results');
SELECT pg_temp.expect_error($$INSERT INTO lab_reports (batch_id,lab_org_id,tested_by,request_id,sample_code,received_on,tested_on,
    moisture_pct,hmf_mg_kg,sucrose_g_100g,pollen_identification) VALUES
    (901,901,902,901,'S-1',CURRENT_DATE,CURRENT_DATE,117.8,9.6,3.1,'Multifloral')$$,
    'lab_reports_moisture_pct_check', 'moisture must be 0-100');
SELECT pg_temp.expect_error($$INSERT INTO lab_reports (batch_id,lab_org_id,tested_by,request_id,sample_code,received_on,tested_on,
    moisture_pct,hmf_mg_kg,sucrose_g_100g,pollen_identification,adulteration_result) VALUES
    (901,901,902,901,'S-1',CURRENT_DATE,CURRENT_DATE,17.8,9.6,3.1,'Multifloral','NOT_DETECTED')$$,
    'lab_method_if_tested', 'adulteration result requires the test method');

INSERT INTO lab_reports (lab_report_id, batch_id, lab_org_id, tested_by, request_id, sample_code, received_on, tested_on,
    moisture_pct, hmf_mg_kg, sucrose_g_100g, pollen_identification, adulteration_method, adulteration_result)
VALUES (901, 901, 901, 902, 901, 'S-1', CURRENT_DATE, CURRENT_DATE,
    17.8, 9.6, 3.1, 'Multifloral pollen observed', 'C4 sugar (SCIRA)', 'NOT_DETECTED');

SELECT pg_temp.expect_error($$INSERT INTO lab_reports (batch_id,lab_org_id,tested_by,request_id,sample_code,received_on,tested_on,
    moisture_pct,hmf_mg_kg,sucrose_g_100g,pollen_identification) VALUES
    (901,901,902,901,'S-2',CURRENT_DATE,CURRENT_DATE,18,9,3,'x')$$,
    'lab_reports_one_draft_uq', 'only one open draft per batch');
-- compulsory automatic analysis (migration 006)
SELECT pg_temp.expect_error($$UPDATE lab_reports SET report_state='SUBMITTED', decision='PASS', submitted_at=now() WHERE lab_report_id=901$$,
    'ANALYSIS_REQUIRED', 'approval requires an automatic analysis report');
INSERT INTO lab_report_analyses (analysis_id, lab_report_id, batch_id, values_fingerprint, honey_category, standards_profile, requested_by)
SELECT 901, 901, 901, lab_report_values_fingerprint(lr), 'BLOSSOM', 'FSSAI', 902 FROM lab_reports lr WHERE lab_report_id = 901;
SELECT pg_temp.expect_error($$UPDATE lab_reports SET report_state='SUBMITTED', decision='PASS', submitted_at=now(), ai_analysis_id=901 WHERE lab_report_id=901$$,
    'ANALYSIS_NOT_COMPLETED', 'approval requires a completed analysis');
UPDATE lab_report_analyses SET status='COMPLETED', standards_status='ALL_PASSED', ml_status='NOT_TRAINED', overall_status='COMPLETED_WITH_LIMITATIONS',
    mongo_report_id='0123456789abcdef01234567', automatic_outcome='PASS', completed_at=now() WHERE analysis_id = 901;
-- migration 007: the outcome is automatic; nobody can store a different decision
SELECT pg_temp.expect_error($$UPDATE lab_reports SET report_state='SUBMITTED', decision='FAIL', submitted_at=now(), ai_analysis_id=901 WHERE lab_report_id=901$$,
    'AUTO_DECISION_MISMATCH', 'the decision must equal the automatic outcome');
SELECT pg_temp.expect_error($$UPDATE lab_report_analyses SET overall_status='COMPLETED' WHERE analysis_id=901$$,
    'RECORD_IMMUTABLE', 'a completed analysis cannot be changed');
SELECT pg_temp.expect_error($$UPDATE lab_report_analyses SET automatic_outcome='FAIL' WHERE analysis_id=901$$,
    'RECORD_IMMUTABLE', 'an automatic outcome cannot be changed');
SELECT pg_temp.expect_error($$UPDATE lab_reports SET report_state='SUBMITTED', ai_analysis_id=901 WHERE lab_report_id=901$$,
    'lab_submit_complete', 'cannot submit without a decision');
SELECT pg_temp.expect_error($$UPDATE lab_reports SET report_state='SUBMITTED', decision='MAYBE', submitted_at=now(), ai_analysis_id=901 WHERE lab_report_id=901$$,
    'lab_reports_decision_check', 'decision must be PASS, FAIL or INCONCLUSIVE');

UPDATE lab_reports SET report_state = 'SUBMITTED', decision = 'PASS', submitted_at = now(), ai_analysis_id = 901 WHERE lab_report_id = 901;
UPDATE lab_test_requests SET status = 'COMPLETED', completed_at = now() WHERE request_id = 901;
UPDATE batches SET status = 'LAB_PASSED' WHERE batch_id = 901;

SELECT pg_temp.expect_error($$UPDATE lab_reports SET moisture_pct = 15 WHERE lab_report_id = 901$$,
    'REPORT_IMMUTABLE', 'submitted lab report cannot be edited');
SELECT pg_temp.expect_error($$DELETE FROM lab_reports WHERE lab_report_id = 901$$,
    'REPORT_IMMUTABLE', 'submitted lab report cannot be deleted');
SELECT pg_temp.expect_error($$UPDATE lab_reports SET report_state='SUPERSEDED', superseded_at=now() WHERE lab_report_id = 901$$,
    'REPORT_IMMUTABLE', 'a report cannot be superseded outside an approved correction');
SELECT pg_temp.expect_error($$UPDATE batches SET status = 'LAB_FAILED' WHERE batch_id = 901$$,
    'CORRECTION_REQUIRED', 'a lab result cannot be flipped without a correction');

INSERT INTO lab_report_corrections (correction_id, lab_report_id, requested_by, reason, proposed_changes, previous_values)
VALUES (901, 901, 902, 'Transcription error in HMF', '{"hmfMgKg": "8.60"}', '{"hmfMgKg": "9.60"}');
SELECT pg_temp.expect_error($$UPDATE lab_report_corrections SET status='APPROVED', reviewed_by=902, reviewed_at=now(), new_lab_report_id=901
    WHERE correction_id=901$$, 'NOT_ADMIN', 'corrections are reviewed by an administrator, not the requester');
SELECT pg_temp.expect_error($$DELETE FROM lab_report_corrections WHERE correction_id=901$$, 'RECORD_IMMUTABLE', 'correction requests are kept');
UPDATE lab_report_corrections SET status='REJECTED', reviewed_by=906, reviewed_at=now(), review_note='Printout matches the report' WHERE correction_id=901;

-- ---------------- custody: processor -> distributor, distribution ----------------
SELECT set_config('app.user_id', '903', true);
SELECT pg_temp.expect_error($$INSERT INTO batch_transfers (batch_id,transfer_type,from_org_id,to_org_id,quantity_kg,units,initiated_by)
    VALUES (901,'TO_DISTRIBUTOR',902,903,11.80,10,903)$$, 'QUANTITY_MISMATCH', 'all packed units are handed over');
INSERT INTO batch_transfers (transfer_id, batch_id, transfer_type, from_org_id, to_org_id, quantity_kg, units, initiated_by)
VALUES (903, 901, 'TO_DISTRIBUTOR', 902, 903, 11.80, 23, 903);
SELECT pg_temp.expect_error($$INSERT INTO shipments (batch_id,distributor_org_id,recorded_by,dispatch_date,origin_location,
    destination_name,destination_type,destination_city,destination_state,units_shipped)
    VALUES (901,903,904,CURRENT_DATE,'Hub','Shop','RETAILER','Mysuru','Karnataka',5)$$,
    'BATCH_NOT_DISPATCHABLE', 'cannot ship before the distributor accepts');
SELECT set_config('app.user_id', '904', true);
UPDATE batch_transfers SET status='ACCEPTED', responded_by=904, responded_at=now() WHERE transfer_id=903;
SELECT pg_temp.ok((SELECT status FROM batches WHERE batch_id = 901) = 'IN_DISTRIBUTION', 'accepted by the distributor');

INSERT INTO shipments (shipment_id, batch_id, distributor_org_id, recorded_by, dispatch_date, origin_location,
    destination_name, destination_type, destination_city, destination_state, units_shipped)
VALUES (901, 901, 903, 904, CURRENT_DATE, 'Bengaluru hub', 'Bengaluru Retail Store', 'RETAILER',
        'Bengaluru', 'Karnataka', 20);

SELECT pg_temp.expect_error($$INSERT INTO shipments (batch_id,distributor_org_id,recorded_by,dispatch_date,origin_location,
    destination_name,destination_type,destination_city,destination_state,units_shipped)
    VALUES (901,903,904,CURRENT_DATE,'Hub','Shop 2','RETAILER','Mysuru','Karnataka',5)$$,
    'SHIPPED_EXCEEDS_PACKED', 'distributed units cannot exceed packed units');
SELECT pg_temp.expect_error($$UPDATE shipments SET status='DELIVERED' WHERE shipment_id=901$$,
    'ship_delivered_has_date', 'DELIVERED requires a delivery date');
SELECT pg_temp.expect_error($$UPDATE shipments SET units_shipped = 2 WHERE shipment_id = 901$$,
    'RECORD_IMMUTABLE', 'shipment quantities cannot be edited');

UPDATE shipments SET status = 'IN_TRANSIT' WHERE shipment_id = 901;
UPDATE shipments SET status = 'DELIVERED', delivered_on = CURRENT_DATE WHERE shipment_id = 901;
SELECT pg_temp.expect_error($$UPDATE shipments SET status='IN_TRANSIT', delivered_on=NULL WHERE shipment_id=901$$,
    'INVALID_TRANSITION', 'delivered shipment cannot go back in transit');
UPDATE batches SET status = 'DELIVERED' WHERE batch_id = 901;

SELECT pg_temp.ok((SELECT string_agg(to_status, '>' ORDER BY history_id) FROM batch_status_history WHERE batch_id = 901)
                  = 'CREATED>PENDING_PROCESSOR>IN_PROCESSING>PROCESSED>PENDING_LAB>IN_TESTING>LAB_PASSED>PENDING_DISTRIBUTOR>IN_DISTRIBUTION>DELIVERED',
                  'full beekeeper -> processor -> lab -> distributor lifecycle recorded in history');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM batch_status_history WHERE batch_id = 901 AND changed_by IS NULL),
                  'every status change has a responsible user');

-- ---------------- consumer history & settings audit ----------------
SELECT pg_temp.expect_error($$INSERT INTO consumer_verifications (user_id,batch_id,overall_result) VALUES (901,901,'VERIFIED')$$,
    'NOT_A_CONSUMER', 'verification history is only for consumer accounts');
INSERT INTO consumer_verifications (user_id, batch_id, overall_result) VALUES (907, 901, 'PARTIAL');
SELECT set_config('app.user_id', '906', true);
UPDATE app_settings SET value = '"CODEX"' WHERE setting_key = 'standards_profile';
SELECT pg_temp.ok((SELECT changed_by FROM app_settings_history WHERE setting_key='standards_profile' ORDER BY history_id DESC LIMIT 1) = 906,
                  'settings change recorded with the acting admin');

-- ---------------- QR, anchors, verification ----------------
INSERT INTO qr_records (batch_id, public_url, generated_by)
SELECT batch_id, 'http://localhost:5173/verify/' || batch_code, 901 FROM batches WHERE batch_id IN (901, 902);
SELECT pg_temp.ok((SELECT count(DISTINCT public_url) FROM qr_records WHERE batch_id IN (901,902)) = 2, 'each batch has a distinct QR URL');

SELECT pg_temp.expect_error($$INSERT INTO blockchain_anchors (entity_type,batch_id,record_key,record_hash,canonical_json,
    network,chain_id,contract_address,status) VALUES ('LAB_REPORT',901,
    '0x'||repeat('a',64),'0x'||repeat('b',64),'{}','hardhat',31337,'0x'||repeat('1',40),'PENDING')$$,
    'anchor_entity_fk_matches', 'LAB_REPORT anchor must reference a lab report');
SELECT pg_temp.expect_error($$INSERT INTO blockchain_anchors (entity_type,batch_id,lab_report_id,record_key,record_hash,canonical_json,
    network,chain_id,contract_address,status) VALUES ('LAB_REPORT',902,901,
    '0x'||repeat('a',64),'0x'||repeat('b',64),'{}','hardhat',31337,'0x'||repeat('1',40),'PENDING')$$,
    'ANCHOR_BATCH_MISMATCH', 'anchor batch must match the record''s batch');
SELECT pg_temp.expect_error($$INSERT INTO blockchain_anchors (entity_type,batch_id,lab_report_id,record_key,record_hash,canonical_json,
    network,chain_id,contract_address,status) VALUES ('LAB_REPORT',901,901,
    '0x'||repeat('a',64),'0x'||repeat('b',64),'{}','hardhat',31337,'0x'||repeat('1',40),'CONFIRMED')$$,
    'anchor_confirmed_has_tx', 'CONFIRMED impossible without a real tx hash/block');

INSERT INTO blockchain_anchors (anchor_id, entity_type, batch_id, lab_report_id, record_key, record_hash, canonical_json,
    network, chain_id, contract_address, status)
VALUES (901, 'LAB_REPORT', 901, 901, '0x'||repeat('a',64), '0x'||repeat('b',64), '{}', 'hardhat', 31337, '0x'||repeat('1',40), 'PENDING');
SELECT pg_temp.expect_error($$INSERT INTO blockchain_anchors (entity_type,batch_id,lab_report_id,record_key,record_hash,canonical_json,
    network,chain_id,contract_address,status) VALUES ('LAB_REPORT',901,901,
    '0x'||repeat('a',64),'0x'||repeat('b',64),'{}','hardhat',31337,'0x'||repeat('1',40),'PENDING')$$,
    'anchors_one_live_per_record_uq', 'only one live anchor per record per contract');

SELECT pg_temp.expect_error($$INSERT INTO verification_checks (anchor_id,recomputed_hash,onchain_hash,result,trigger_source)
    VALUES (901,'0x'||repeat('b',64),'0x'||repeat('c',64),'VERIFIED','ADMIN')$$,
    'verify_result_consistent', 'VERIFIED impossible when hashes differ');
INSERT INTO verification_checks (anchor_id, recomputed_hash, onchain_hash, result, trigger_source)
VALUES (901, '0x'||repeat('c',64), '0x'||repeat('b',64), 'MISMATCH', 'ADMIN');
SELECT pg_temp.ok((SELECT last_result FROM v_anchor_status WHERE anchor_id = 901) = 'MISMATCH', 'v_anchor_status shows latest check');

-- ---------------- public view privacy ----------------
SELECT pg_temp.ok(NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name IN ('v_public_batch','v_public_shipments','v_public_custody')
       AND column_name IN ('email','phone','full_name','password_hash','operator_name','operator_staff_id',
                           'tested_by','recorded_by','tracking_reference','beekeeper_email','response_reason',
                           'initiated_by','responded_by','notes')),
    'public views expose no private columns');
SELECT pg_temp.ok((SELECT producer_name FROM v_public_batch WHERE batch_code = (SELECT batch_code FROM batches WHERE batch_id=901))
                  = 'Lakshmi Devi (demo)', 'consented beekeeper name is shown publicly');
UPDATE beekeepers SET show_name_publicly = FALSE WHERE beekeeper_id = 901;
SELECT pg_temp.ok((SELECT producer_name FROM v_public_batch WHERE batch_code = (SELECT batch_code FROM batches WHERE batch_id=901))
                  = 'Registered beekeeper', 'name hidden when consent withdrawn');

\echo 'ALL SCHEMA TESTS PASSED - rolling back'
ROLLBACK;
