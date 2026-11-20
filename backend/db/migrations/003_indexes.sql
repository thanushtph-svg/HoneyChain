-- =====================================================================
-- HoneyChain - Migration 003: indexes
--
-- PostgreSQL automatically indexes PRIMARY KEY and UNIQUE columns, but NOT
-- foreign keys. Every index below is justified by a real lookup the
-- application performs (see docs/03-postgresql-design.md section Indexes).
-- =====================================================================

BEGIN;

-- Login & admin user list
CREATE INDEX users_role_idx              ON users (role_code);
CREATE INDEX users_org_idx               ON users (org_id) WHERE org_id IS NOT NULL;

-- "My hives" (beekeeper dashboard)
CREATE INDEX hives_beekeeper_idx         ON hives (beekeeper_id);

-- "Harvest history for a hive, newest first"
CREATE INDEX harvests_hive_date_idx      ON harvests (hive_id, harvest_date DESC);

-- Batches of a harvest; queue screens filter by status
CREATE INDEX batches_harvest_idx         ON batches (harvest_id);
CREATE INDEX batches_status_idx          ON batches (status);
-- Lab queue: "batches assigned to my lab that still need testing"
CREATE INDEX batches_lab_queue_idx       ON batches (assigned_lab_id, status)
    WHERE status IN ('CREATED','IN_TESTING');

-- Timeline of a batch
CREATE INDEX status_history_batch_idx    ON batch_status_history (batch_id, changed_at);

-- Lab history screen: "reports by my lab, newest first"
CREATE INDEX lab_reports_batch_idx       ON lab_reports (batch_id);
CREATE INDEX lab_reports_org_date_idx    ON lab_reports (lab_org_id, tested_on DESC);

-- Processor / distributor history
CREATE INDEX processing_org_date_idx     ON processing_records (processor_org_id, processing_date DESC);
CREATE INDEX shipments_batch_idx         ON shipments (batch_id);
CREATE INDEX shipments_org_status_idx    ON shipments (distributor_org_id, status);

-- Blockchain: anchors of a batch; the anchor worker polls PENDING rows
CREATE INDEX anchors_batch_idx           ON blockchain_anchors (batch_id);
CREATE INDEX anchors_pending_idx         ON blockchain_anchors (created_at)
    WHERE status IN ('PENDING','SUBMITTED');

-- Latest verification of an anchor
CREATE INDEX verification_anchor_time_idx ON verification_checks (anchor_id, checked_at DESC);

-- Outbox retry worker
CREATE INDEX outbox_due_idx              ON mongo_outbox (next_attempt_at) WHERE status = 'PENDING';

COMMIT;
