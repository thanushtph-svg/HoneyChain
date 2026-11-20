-- =====================================================================
-- HoneyChain - Migration 004: views
--
-- v_batch_trace          internal, full join of a batch's lifecycle (admin)
-- v_public_batch         ONLY consumer-approved columns (public QR page)
-- v_public_shipments     consumer-approved shipment columns
-- v_anchor_status        each anchor with its most recent verification
--
-- The public API reads ONLY the v_public_* views and v_anchor_status, so
-- private columns (emails, phone numbers, operator names, staff ids) are
-- impossible to leak by accident - they are simply not in those views.
-- =====================================================================

BEGIN;

CREATE VIEW v_batch_trace AS
SELECT
    b.batch_id, b.batch_code, b.status, b.quantity_kg AS batch_quantity_kg, b.honey_type,
    b.is_demo, b.created_at AS batch_created_at,
    h.harvest_id, h.harvest_code, h.harvest_date, h.quantity_kg AS harvest_quantity_kg, h.floral_source,
    hv.hive_id, hv.hive_code, hv.hive_type, hv.bee_species, hv.district AS hive_district, hv.state AS hive_state,
    bk.beekeeper_id, bk.beekeeper_code, bk.public_display_name, bk.cooperative_name,
    u.user_id AS beekeeper_user_id, u.full_name AS beekeeper_full_name, u.email AS beekeeper_email,
    lab.org_id AS assigned_lab_id, lab.name AS assigned_lab_name,
    lr.lab_report_id, lr.report_code, lr.tested_on, lr.moisture_pct, lr.hmf_mg_kg, lr.sucrose_g_100g,
    lr.adulteration_result, lr.decision AS lab_decision,
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
LEFT JOIN organizations      lab ON lab.org_id = b.assigned_lab_id
LEFT JOIN lab_reports        lr  ON lr.batch_id = b.batch_id AND lr.report_state = 'SUBMITTED'
LEFT JOIN processing_records pr  ON pr.batch_id = b.batch_id;


CREATE VIEW v_public_batch AS
SELECT
    b.batch_code, b.status, b.honey_type, b.quantity_kg AS batch_quantity_kg, b.is_demo,
    -- origin: the beekeeper's name only if they consented
    CASE WHEN bk.show_name_publicly THEN bk.public_display_name
         ELSE 'Registered beekeeper' END                          AS producer_name,
    bk.cooperative_name, hv.district AS origin_district, hv.state AS origin_state,
    hv.hive_code, hv.bee_species,
    h.harvest_code, h.harvest_date, h.floral_source,
    -- laboratory (organization, never the individual tester)
    lab.name AS lab_name, lab.accreditation_no AS lab_accreditation_no,
    lr.report_code, lr.tested_on, lr.moisture_pct, lr.hmf_mg_kg, lr.sucrose_g_100g,
    lr.glucose_g_100g, lr.fructose_g_100g, lr.ph, lr.free_acidity_meq_kg,
    lr.pollen_identification, lr.adulteration_method, lr.adulteration_result,
    lr.decision AS lab_decision,
    -- processing (organization, method, packaging - not the operator's name)
    po.name AS processor_name, po.city AS processor_city,
    pr.processing_code, pr.processing_date, pr.method AS processing_method,
    pr.packaging_date, pr.packaging_type, pr.unit_size_g, pr.best_before
FROM batches b
JOIN harvests   h  ON h.harvest_id    = b.harvest_id
JOIN hives      hv ON hv.hive_id      = h.hive_id
JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
LEFT JOIN lab_reports        lr  ON lr.batch_id = b.batch_id AND lr.report_state = 'SUBMITTED'
LEFT JOIN organizations      lab ON lab.org_id  = lr.lab_org_id
LEFT JOIN processing_records pr  ON pr.batch_id = b.batch_id
LEFT JOIN organizations      po  ON po.org_id   = pr.processor_org_id;


CREATE VIEW v_public_shipments AS
SELECT
    b.batch_code, s.shipment_code, s.dispatch_date, s.origin_location,
    s.destination_type, s.destination_city, s.destination_state,
    s.status, s.delivered_on, d.name AS distributor_name
FROM shipments s
JOIN batches       b ON b.batch_id = s.batch_id
JOIN organizations d ON d.org_id   = s.distributor_org_id
WHERE s.status <> 'CANCELLED';


CREATE VIEW v_anchor_status AS
SELECT
    a.anchor_id, a.batch_id, b.batch_code, a.entity_type,
    COALESCE(lr.report_code, pr.processing_code, s.shipment_code, b.batch_code) AS entity_code,
    a.hash_scheme, a.record_hash, a.network, a.chain_id, a.contract_address,
    a.status AS anchor_status, a.tx_hash, a.block_number, a.block_timestamp,
    vc.result AS last_result, vc.checked_at AS last_checked_at
FROM blockchain_anchors a
JOIN batches b ON b.batch_id = a.batch_id
LEFT JOIN lab_reports        lr ON lr.lab_report_id = a.lab_report_id
LEFT JOIN processing_records pr ON pr.processing_id = a.processing_id
LEFT JOIN shipments          s  ON s.shipment_id    = a.shipment_id
LEFT JOIN LATERAL (
    SELECT result, checked_at FROM verification_checks v
     WHERE v.anchor_id = a.anchor_id
     ORDER BY checked_at DESC LIMIT 1
) vc ON TRUE;

COMMIT;
