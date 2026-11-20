// Row-level access rules for batches (server-side; the UI only mirrors them).
//   ADMIN        all batches
//   BEEKEEPER    batches from their own hives
//   LAB          batches assigned to their lab, or that their lab has reported on
//   PROCESSOR    batches eligible for processing (LAB_PASSED) or processed by their org
//   DISTRIBUTOR  batches eligible for dispatch (PROCESSED / IN_DISTRIBUTION) or shipped by their org
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
    case 'LAB':
      return [`(b.assigned_lab_id = ${p} OR EXISTS (SELECT 1 FROM lab_reports slr WHERE slr.batch_id = b.batch_id AND slr.lab_org_id = ${p}))`, [user.orgId]];
    case 'PROCESSOR':
      return [`(b.status = 'LAB_PASSED' OR EXISTS (SELECT 1 FROM processing_records sp WHERE sp.batch_id = b.batch_id AND sp.processor_org_id = ${p}))`, [user.orgId]];
    case 'DISTRIBUTOR':
      return [`(b.status IN ('PROCESSED','IN_DISTRIBUTION') OR EXISTS (SELECT 1 FROM shipments ss WHERE ss.batch_id = b.batch_id AND ss.distributor_org_id = ${p}))`, [user.orgId]];
    default:
      return ['FALSE', []];
  }
}

/** Fetch a batch by code if the user may see it; otherwise 404 (no information leak). */
export async function getVisibleBatch(user, batchCode) {
  const [cond, params] = batchScope(user, 2);
  const b = await one(
    `SELECT b.*, h.harvest_code, h.harvest_date, h.floral_source, hv.hive_code, hv.beekeeper_id
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id
      WHERE b.batch_code = $1 AND ${cond}`,
    [batchCode, ...params],
  );
  if (!b) throw notFound('Batch');
  return b;
}
