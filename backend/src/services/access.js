// Row-level access rules for batches (server-side; the UI only mirrors them).
//   ADMIN        all batches (read-only monitoring)
//   BEEKEEPER    batches from their own hives
//   PROCESSOR    batches transferred to their processing unit (pending or accepted)
//   LAB_TESTER   batches for which their laboratory received a testing request (not rejected/cancelled),
//                plus legacy batches their lab reported on
//   DISTRIBUTOR  batches transferred to their company (pending or accepted)
//   CONSUMER     none - consumers only use the public verification API
import { one } from '../db/pg.js';
import { notFound } from '../utils/errors.js';

/** Returns [sqlCondition, params] using placeholders starting at $start. Alias b = batches. */
export function batchScope(user, start = 1) {
  const p = `$${start}`;
  switch (user.role) {
    case 'ADMIN':
      return ['TRUE', []];
    case 'BEEKEEPER':
      return [`EXISTS (SELECT 1 FROM harvests sh JOIN hives shv ON shv.hive_id = sh.hive_id
                       WHERE sh.harvest_id = b.harvest_id AND shv.beekeeper_id = ${p})`, [user.beekeeperId]];
    case 'PROCESSOR':
      return [`EXISTS (SELECT 1 FROM batch_transfers st WHERE st.batch_id = b.batch_id AND st.transfer_type = 'TO_PROCESSOR'
                       AND st.to_org_id = ${p} AND st.status IN ('PENDING','ACCEPTED'))`, [user.orgId]];
    case 'LAB_TESTER':
      return [`(EXISTS (SELECT 1 FROM lab_test_requests sr WHERE sr.batch_id = b.batch_id AND sr.lab_org_id = ${p}
                        AND sr.status IN ('PENDING','ACCEPTED','COMPLETED'))
                OR EXISTS (SELECT 1 FROM lab_reports slr WHERE slr.batch_id = b.batch_id AND slr.lab_org_id = ${p}))`, [user.orgId]];
    case 'DISTRIBUTOR':
      return [`EXISTS (SELECT 1 FROM batch_transfers st WHERE st.batch_id = b.batch_id AND st.transfer_type = 'TO_DISTRIBUTOR'
                       AND st.to_org_id = ${p} AND st.status IN ('PENDING','ACCEPTED'))`, [user.orgId]];
    default:
      return ['FALSE', []];
  }
}

/** Fetch a batch by code if the user may see it; otherwise 404 (no information leak). */
export async function getVisibleBatch(user, batchCode) {
  const [cond, params] = batchScope(user, 2);
  const b = await one(
    `SELECT b.*, h.harvest_code, h.harvest_date, h.floral_source, hv.hive_code, hv.beekeeper_id,
            batch_processor_org(b.batch_id) AS processor_org_id, batch_distributor_org(b.batch_id) AS distributor_org_id
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id
      WHERE b.batch_code = $1 AND ${cond}`,
    [batchCode, ...params],
  );
  if (!b) throw notFound('Batch');
  return b;
}

/**
 * Remove fields a role must not see from a batch-detail payload.
 * Personal data of the beekeeper: owner + admin only. Operator names / staff ids: processor + admin.
 * Tracking references: distributor + admin. Rejection reasons are business records visible to the
 * parties of that transfer (both are in scope) and the admin.
 */
export function sanitizeBatchDetail(user, b, d) {
  const isAdmin = user.role === 'ADMIN';
  const isOwner = user.role === 'BEEKEEPER' && user.beekeeperId === b.beekeeper_id;
  if (!isAdmin && !isOwner && d.batch) {
    delete d.batch.beekeeper_email;
    delete d.batch.beekeeper_full_name;
    delete d.batch.beekeeper_user_id;
  }
  if (!isAdmin && user.role !== 'PROCESSOR' && d.processing) {
    delete d.processing.operator_name;
    delete d.processing.operator_staff_id;
  }
  if (!isAdmin && user.role !== 'DISTRIBUTOR') {
    d.shipments = d.shipments.map(({ tracking_reference: _t, ...s }) => s);
  }
  // staff names are shown only to the organization they belong to (and to the admin)
  if (!isAdmin) {
    const mine = (orgId, isBeekeeperSide) => (isBeekeeperSide ? isOwner : orgId != null && orgId === user.orgId);
    d.transfers = d.transfers.map((t) => ({
      ...t,
      initiated_by_name: mine(t.from_org_id, t.from_org_id == null) ? t.initiated_by_name : null,
      responded_by_name: mine(t.to_org_id, false) || (t.status === 'CANCELLED' && mine(t.from_org_id, t.from_org_id == null)) ? t.responded_by_name : null,
    }));
    d.labRequests = d.labRequests.map((r) => ({
      ...r,
      requested_by_name: user.orgId === r.requester_org_id ? r.requested_by_name : null,
      responded_by_name: user.orgId === r.lab_org_id ? r.responded_by_name : null,
    }));
    d.statusHistory = d.statusHistory.map((h) => ({ ...h, changed_by_name: null }));
  }
  return d;
}
