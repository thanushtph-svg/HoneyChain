// The six HoneyChain roles and what each may do.
// This file is the single description of the permission model: route guards use the ROLE
// constants, and the admin "Role management" page shows PERMISSIONS as the matrix.
// (The server enforces every rule in requireRole + row-level scopes + database triggers;
//  this matrix documents them, it does not replace them.)

export const ROLES = Object.freeze({
  BEEKEEPER: 'BEEKEEPER',
  PROCESSOR: 'PROCESSOR',
  LAB_TESTER: 'LAB_TESTER',
  DISTRIBUTOR: 'DISTRIBUTOR',
  ADMIN: 'ADMIN',
  CONSUMER: 'CONSUMER',
});
export const ALL_ROLES = Object.values(ROLES);
/** Roles that belong to an organization (and the organization type they need) */
export const ORG_TYPE_FOR_ROLE = { LAB_TESTER: 'LABORATORY', PROCESSOR: 'PROCESSOR', DISTRIBUTOR: 'DISTRIBUTOR' };
/** Roles that work with supply-chain records (everyone except consumers) */
export const STAFF_ROLES = ['BEEKEEPER', 'PROCESSOR', 'LAB_TESTER', 'DISTRIBUTOR', 'ADMIN'];

/** Where each role lands after login (must match frontend/src/roles.js) */
export const HOME_PATH = {
  BEEKEEPER: '/beekeeper',
  PROCESSOR: '/processor',
  LAB_TESTER: '/lab',
  DISTRIBUTOR: '/distributor',
  ADMIN: '/admin',
  CONSUMER: '/consumer',
};

export const ROLE_LABEL = {
  BEEKEEPER: 'Beekeeper',
  PROCESSOR: 'Processor',
  LAB_TESTER: 'Lab Tester',
  DISTRIBUTOR: 'Distributor',
  ADMIN: 'Administrator',
  CONSUMER: 'Consumer',
};

// [permission, description, roles allowed]
export const PERMISSIONS = [
  ['hive.manage', 'Register and manage own hives', ['BEEKEEPER']],
  ['harvest.record', 'Record own harvests', ['BEEKEEPER']],
  ['batch.create', 'Create / split batches from own harvests', ['BEEKEEPER']],
  ['transfer.toProcessor', 'Transfer own batch to a processor', ['BEEKEEPER']],
  ['transfer.respond.processor', 'Accept / reject batches sent to own processing unit', ['PROCESSOR']],
  ['processing.record', 'Record processing for batches in own custody', ['PROCESSOR']],
  ['labRequest.create', 'Request laboratory testing for batches in own custody', ['PROCESSOR']],
  ['transfer.toDistributor', 'Transfer lab-passed batches to a distributor', ['PROCESSOR']],
  ['labRequest.respond', 'Accept / reject testing requests sent to own laboratory', ['LAB_TESTER']],
  ['labReport.write', 'Enter measurements and submit PASS / FAIL / INCONCLUSIVE', ['LAB_TESTER']],
  ['labReport.document', 'Upload supporting documents to own lab reports', ['LAB_TESTER']],
  ['labCorrection.request', 'Request an audited correction of a submitted result', ['LAB_TESTER']],
  ['ai.run', 'Run AI decision support on own lab reports', ['LAB_TESTER']],
  ['transfer.respond.distributor', 'Accept / reject batches sent to own distribution company', ['DISTRIBUTOR']],
  ['shipment.record', 'Record shipments and delivery status for batches in own custody', ['DISTRIBUTOR']],
  ['batch.read.own', 'Read batches in own custody / ownership (with traceability history)', ['BEEKEEPER', 'PROCESSOR', 'LAB_TESTER', 'DISTRIBUTOR']],
  ['batch.read.all', 'Read every batch and record (monitoring, read-only)', ['ADMIN']],
  ['user.manage', 'Create, activate and deactivate users; assign roles', ['ADMIN']],
  ['organization.manage', 'Create and activate organizations', ['ADMIN']],
  ['labCorrection.review', 'Approve or reject audited lab corrections (never own requests)', ['ADMIN']],
  ['settings.manage', 'Change application settings and the active standards profile', ['ADMIN']],
  ['blockchain.manage', 'Anchor, retry and verify blockchain records', ['ADMIN']],
  ['audit.read', 'Read audit logs, anomalies and security events', ['ADMIN']],
  ['verify.public', 'Verify a product by QR code (no account needed)', ['CONSUMER']],
  ['verify.history', 'Keep a personal verification history (optional account)', ['CONSUMER']],
];
