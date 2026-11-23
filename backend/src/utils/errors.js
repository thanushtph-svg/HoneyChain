// Consistent API errors: { error: { code, message, details? } }
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'You do not have permission for this action') => new ApiError(403, 'FORBIDDEN', msg);
export const conflict = (code, msg) => new ApiError(409, code, msg);
export const unprocessable = (code, msg, details) => new ApiError(422, code, msg, details);
export const unavailable = (code, msg) => new ApiError(503, code, msg);

// Friendly text for named constraints (shown instead of raw PostgreSQL messages)
const CONSTRAINT_MESSAGES = {
  users_email_lower_uq: 'An account with this email already exists',
  users_org_matches_role: 'Lab testers, processors and distributors must belong to an organization; admins, beekeepers and consumers must not',
  transfers_one_pending_uq: 'This batch already has a transfer waiting for a response',
  transfers_one_accepted_uq: 'This batch has already been accepted by an organization of this type',
  transfer_reject_has_reason: 'A reason is required when rejecting or cancelling a transfer',
  lab_requests_one_open_uq: 'This batch already has an open testing request',
  request_reject_has_reason: 'A reason is required when rejecting or cancelling a testing request',
  lab_reports_one_final_uq: 'This batch already has a final (PASS/FAIL) laboratory result',
  corrections_one_pending_uq: 'This report already has a correction waiting for review',
  correction_not_self_reviewed: 'A correction cannot be reviewed by the person who requested it',
  lab_report_documents_lab_report_id_sha256_key: 'This exact document is already attached to the report',
  lab_report_corrections_reason_check: 'Give a reason of at least 10 characters',
  organizations_name_org_type_key: 'An organization with this name and type already exists',
  lab_reports_lab_org_id_sample_code_key: 'This sample code is already used by your laboratory',
  lab_reports_one_draft_uq: 'This batch already has an open draft report',
  lab_reports_one_submitted_uq: 'This batch already has a submitted report',
  lab_dates_ordered: 'Test date cannot be before the sample received date',
  lab_method_if_tested: 'Enter the adulteration test method when a result is recorded',
  proc_output_le_input: 'Output quantity cannot exceed input quantity',
  proc_packed_le_output: 'Packed quantity (units x unit size) cannot exceed the processed output',
  proc_dates_ordered: 'Packaging must be on/after processing, and best-before after packaging',
  ship_delivered_has_date: 'A delivered shipment needs a delivery date (and only delivered ones have one)',
  ship_dates_ordered: 'Delivery date cannot be before dispatch date',
  harvests_harvest_date_check: 'Harvest date cannot be in the future',
  harvests_quantity_kg_check: 'Harvest quantity must be between 0 and 500 kg',
  hives_installed_on_check: 'Installation date cannot be in the future',
  processing_records_batch_id_key: 'This batch already has a processing record',
  anchors_one_live_per_record_uq: 'This record already has an active blockchain anchor on this contract',
};

/** Translate PostgreSQL errors into ApiErrors. */
export function fromPgError(err) {
  if (err.code === 'P0001') {
    const m = /^([A-Z_]+): (.*)$/s.exec(err.message);
    return m ? new ApiError(409, m[1], m[2]) : new ApiError(409, 'RULE_VIOLATION', err.message);
  }
  const c = err.constraint;
  if (err.code === '23505') return new ApiError(409, 'DUPLICATE', CONSTRAINT_MESSAGES[c] ?? `Duplicate value (${c})`);
  if (err.code === '23514') return new ApiError(422, 'CHECK_VIOLATION', CONSTRAINT_MESSAGES[c] ?? `Value not allowed (${c})`);
  if (err.code === '23503') return new ApiError(422, 'REFERENCE_ERROR', 'Referenced record does not exist');
  if (err.code === '23502') return new ApiError(422, 'MISSING_VALUE', `${err.column} is required`);
  if (err.code === '22P02' || err.code === '22007' || err.code === '22008') return new ApiError(422, 'INVALID_VALUE', 'Invalid value format');
  if (err.code === '22003') return new ApiError(422, 'OUT_OF_RANGE', 'Number out of range');
  return null;
}
