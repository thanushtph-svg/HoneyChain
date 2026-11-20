// Canonical serialization + hashing, scheme "hc-v1" (docs/06-blockchain-hashing-spec.md).
// - every field present (null when empty), decimals as fixed-scale strings, dates YYYY-MM-DD
// - references by code, no personal data (names, emails, phones, operator names, tracking refs)
// - keys sorted recursively, no whitespace (RFC 8785 / JCS via `canonicalize`), SHA-256
import crypto from 'node:crypto';
import canonicalize from 'canonicalize';

export const HASH_SCHEME = 'hc-v1';
export const SCHEME_NUMBER = 1;

const sha256Hex = (s) => '0x' + crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const nfc = (v) => (typeof v === 'string' ? v.normalize('NFC') : v);
const n = (v) => (v === undefined ? null : nfc(v));

export function canonicalJson(obj) {
  return canonicalize(obj);
}
export function hashCanonical(json) {
  return sha256Hex(json);
}
export function recordKey(entityType, entityCode) {
  return sha256Hex(`honeychain|${entityType}|${entityCode}`);
}

function envelope(entityType, entityCode, batchCode, data) {
  return { scheme: HASH_SCHEME, entityType, entityCode, batchCode, data };
}

// --- loaders: read the current DB row(s) and build the canonical object -----------------
// `db` is either the pool (query fn) or a transaction client; both expose .query().

export async function buildBatchOrigin(db, batchId) {
  const { rows } = await db.query(
    `SELECT b.batch_code, b.quantity_kg, b.honey_type, to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS created_on,
            bk.beekeeper_code, h.harvest_code, h.harvest_date, h.quantity_kg AS harvest_kg, h.floral_source,
            hv.hive_code, hv.hive_type, hv.bee_species, hv.district, hv.state
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id
       JOIN hives hv ON hv.hive_id = h.hive_id JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
      WHERE b.batch_id = $1`,
    [batchId],
  );
  const r = rows[0];
  if (!r) return null;
  return envelope('BATCH_ORIGIN', r.batch_code, r.batch_code, {
    quantityKg: n(r.quantity_kg),
    honeyType: n(r.honey_type),
    createdOn: n(r.created_on),
    beekeeperCode: n(r.beekeeper_code),
    harvest: { harvestCode: n(r.harvest_code), harvestDate: n(r.harvest_date), quantityKg: n(r.harvest_kg), floralSource: n(r.floral_source) },
    hive: { hiveCode: n(r.hive_code), hiveType: n(r.hive_type), beeSpecies: n(r.bee_species), district: n(r.district), state: n(r.state) },
  });
}

export async function buildLabReport(db, labReportId) {
  const { rows } = await db.query(
    `SELECT lr.*, b.batch_code, o.org_code FROM lab_reports lr
       JOIN batches b ON b.batch_id = lr.batch_id JOIN organizations o ON o.org_id = lr.lab_org_id
      WHERE lr.lab_report_id = $1`,
    [labReportId],
  );
  const r = rows[0];
  if (!r) return null;
  return envelope('LAB_REPORT', r.report_code, r.batch_code, {
    labOrgCode: n(r.org_code),
    sampleCode: n(r.sample_code),
    receivedOn: n(r.received_on),
    testedOn: n(r.tested_on),
    moisturePct: n(r.moisture_pct),
    hmfMgKg: n(r.hmf_mg_kg),
    sucroseG100g: n(r.sucrose_g_100g),
    glucoseG100g: n(r.glucose_g_100g),
    fructoseG100g: n(r.fructose_g_100g),
    brix: n(r.brix),
    ph: n(r.ph),
    freeAcidityMeqKg: n(r.free_acidity_meq_kg),
    waterActivity: n(r.water_activity),
    electricalConductivityMsCm: n(r.electrical_conductivity_ms_cm),
    pollenIdentification: n(r.pollen_identification),
    adulterationMethod: n(r.adulteration_method),
    adulterationResult: n(r.adulteration_result),
    decision: n(r.decision),
    decisionRemarks: n(r.decision_remarks),
  });
}

export async function buildProcessingRecord(db, processingId) {
  const { rows } = await db.query(
    `SELECT p.*, b.batch_code, o.org_code FROM processing_records p
       JOIN batches b ON b.batch_id = p.batch_id JOIN organizations o ON o.org_id = p.processor_org_id
      WHERE p.processing_id = $1`,
    [processingId],
  );
  const r = rows[0];
  if (!r) return null;
  return envelope('PROCESSING_RECORD', r.processing_code, r.batch_code, {
    processorOrgCode: n(r.org_code),
    processingDate: n(r.processing_date),
    method: n(r.method),
    methodDetails: n(r.method_details),
    inputQuantityKg: n(r.input_quantity_kg),
    outputQuantityKg: n(r.output_quantity_kg),
    packagingDate: n(r.packaging_date),
    packagingType: n(r.packaging_type),
    unitSizeG: r.unit_size_g,
    unitsPacked: r.units_packed,
    bestBefore: n(r.best_before),
  });
}

export async function buildShipment(db, shipmentId) {
  const { rows } = await db.query(
    `SELECT s.*, b.batch_code, o.org_code FROM shipments s
       JOIN batches b ON b.batch_id = s.batch_id JOIN organizations o ON o.org_id = s.distributor_org_id
      WHERE s.shipment_id = $1`,
    [shipmentId],
  );
  const r = rows[0];
  if (!r) return null;
  return envelope('SHIPMENT', r.shipment_code, r.batch_code, {
    distributorOrgCode: n(r.org_code),
    dispatchDate: n(r.dispatch_date),
    originLocation: n(r.origin_location),
    destinationName: n(r.destination_name),
    destinationType: n(r.destination_type),
    destinationCity: n(r.destination_city),
    destinationState: n(r.destination_state),
    carrierName: n(r.carrier_name),
    unitsShipped: r.units_shipped,
    status: n(r.status),
    deliveredOn: n(r.delivered_on),
  });
}

/** Build canonical object for an anchor row (or entity spec). */
export async function buildForEntity(db, { entity_type, batch_id, lab_report_id, processing_id, shipment_id }) {
  switch (entity_type) {
    case 'BATCH_ORIGIN': return buildBatchOrigin(db, batch_id);
    case 'LAB_REPORT': return buildLabReport(db, lab_report_id);
    case 'PROCESSING_RECORD': return buildProcessingRecord(db, processing_id);
    case 'SHIPMENT': return buildShipment(db, shipment_id);
    default: throw new Error(`Unknown entity type ${entity_type}`);
  }
}
