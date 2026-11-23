-- =====================================================================
-- HoneyChain - DBMS demonstration queries (run on the seeded database)
--   psql -U postgres -d honeychain -f docs/sql/demo_queries.sql
-- =====================================================================

-- Q1  INNER JOIN across 4 tables: full origin of every batch
SELECT b.batch_code, b.honey_type, b.quantity_kg, h.harvest_code, h.harvest_date,
       hv.hive_code, bk.public_display_name AS beekeeper, bk.district
  FROM batches b
  JOIN harvests   h  ON h.harvest_id    = b.harvest_id
  JOIN hives      hv ON hv.hive_id      = h.hive_id
  JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
 ORDER BY b.batch_code;

-- Q2  LEFT JOIN: every batch with its (optional) submitted lab result - untested batches show NULLs
SELECT b.batch_code, b.status, lr.report_code, lr.moisture_pct, lr.hmf_mg_kg, lr.decision
  FROM batches b
  LEFT JOIN lab_reports lr ON lr.batch_id = b.batch_id AND lr.report_state = 'SUBMITTED'
 ORDER BY b.batch_code;

-- Q3  GROUP BY + aggregates: harvest totals per beekeeper
SELECT bk.beekeeper_code, bk.public_display_name,
       count(DISTINCT hv.hive_id) AS hives, count(h.harvest_id) AS harvests,
       COALESCE(sum(h.quantity_kg), 0) AS total_kg, round(avg(h.quantity_kg), 2) AS avg_kg
  FROM beekeepers bk
  LEFT JOIN hives hv   ON hv.beekeeper_id = bk.beekeeper_id
  LEFT JOIN harvests h ON h.hive_id = hv.hive_id
 GROUP BY bk.beekeeper_id
 ORDER BY total_kg DESC;

-- Q4  GROUP BY + HAVING: harvests that still have unbatched honey
SELECT h.harvest_code, h.quantity_kg, COALESCE(sum(b.quantity_kg), 0) AS batched_kg,
       h.quantity_kg - COALESCE(sum(b.quantity_kg), 0) AS remaining_kg
  FROM harvests h LEFT JOIN batches b ON b.harvest_id = h.harvest_id
 GROUP BY h.harvest_id
HAVING h.quantity_kg - COALESCE(sum(b.quantity_kg), 0) > 0;

-- Q5  Scalar subquery + CASE: processing yield and loss per processed batch
SELECT b.batch_code, p.input_quantity_kg, p.output_quantity_kg,
       round(100 * (p.input_quantity_kg - p.output_quantity_kg) / p.input_quantity_kg, 2) AS loss_pct,
       p.units_packed,
       (SELECT COALESCE(sum(s.units_shipped), 0) FROM shipments s
         WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED') AS units_shipped,
       CASE WHEN p.units_packed = (SELECT COALESCE(sum(s.units_shipped), 0) FROM shipments s
                                    WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED')
            THEN 'fully shipped' ELSE 'units remaining' END AS shipping_state
  FROM processing_records p JOIN batches b ON b.batch_id = p.batch_id;

-- Q6  Correlated subquery with EXISTS: beekeepers with at least one FAILED batch
SELECT bk.beekeeper_code, bk.public_display_name
  FROM beekeepers bk
 WHERE EXISTS (SELECT 1 FROM hives hv JOIN harvests h ON h.hive_id = hv.hive_id
                 JOIN batches b ON b.harvest_id = h.harvest_id
                WHERE hv.beekeeper_id = bk.beekeeper_id AND b.status = 'LAB_FAILED');

-- Q7  IN-subquery + comparison with an aggregate: lab results above the average HMF
SELECT lr.report_code, lr.hmf_mg_kg
  FROM lab_reports lr
 WHERE lr.report_state = 'SUBMITTED'
   AND lr.hmf_mg_kg > (SELECT avg(hmf_mg_kg) FROM lab_reports WHERE report_state = 'SUBMITTED');

-- Q8  Window function: rank harvests within each hive by quantity
SELECT hv.hive_code, h.harvest_code, h.quantity_kg,
       rank() OVER (PARTITION BY hv.hive_id ORDER BY h.quantity_kg DESC) AS rank_in_hive
  FROM harvests h JOIN hives hv ON hv.hive_id = h.hive_id;

-- Q9  Batch lifecycle timeline from the audit table (trigger-written)
SELECT b.batch_code, bh.from_status, bh.to_status, bh.changed_at, u.full_name AS changed_by
  FROM batch_status_history bh
  JOIN batches b ON b.batch_id = bh.batch_id
  LEFT JOIN users u ON u.user_id = bh.changed_by
 WHERE b.batch_code = 'HC-2026-000001'
 ORDER BY bh.history_id;

-- Q10 Blockchain anchors and latest verification per record (view with LATERAL join)
SELECT batch_code, entity_type, entity_code, anchor_status, block_number, last_result
  FROM v_anchor_status ORDER BY anchor_id;

-- Q11 Public view: exactly what a consumer can see (no private columns exist in it)
SELECT batch_code, producer_name, origin_district, harvest_date, lab_name, moisture_pct, lab_decision, processor_name
  FROM v_public_batch ORDER BY batch_code;

-- Q12 Index use: the lab's incoming testing requests use lab_requests_lab_idx (lab_org_id, status)
EXPLAIN SELECT request_code FROM lab_test_requests WHERE lab_org_id = 1 AND status = 'PENDING';

-- Q13 Transaction demo: an over-allocation is rolled back as a whole
BEGIN;
  INSERT INTO batches (harvest_id, quantity_kg, honey_type, created_by)
  SELECT harvest_id, quantity_kg + 1, 'too much', 1 FROM harvests ORDER BY harvest_id LIMIT 1;   -- fails: HARVEST_OVER_ALLOCATED
ROLLBACK;
