// The six role-based views. Each role has its OWN base path and its OWN navigation.
// Route guards (layouts/RoleLayout.jsx) only render a view for its role; the backend enforces the
// same rules on every API call, so hiding a link here is never the only protection.

export const ROLES = {
  BEEKEEPER: {
    label: 'Beekeeper',
    base: '/beekeeper',
    nav: [
      ['Dashboard', ''],
      ['My Hives', 'hives'],
      ['Harvests', 'harvests'],
      ['My Batches', 'batches'],
      ['QR Codes', 'qr-codes'],
      ['Profile', 'profile'],
    ],
  },
  PROCESSOR: {
    label: 'Processor',
    base: '/processor',
    nav: [
      ['Dashboard', ''],
      ['Incoming Batches', 'incoming'],
      ['Processing', 'processing'],
      ['Processed Batches', 'processed'],
      ['Transfers', 'transfers'],
      ['History', 'history'],
      ['Profile', 'profile'],
    ],
  },
  LAB_TESTER: {
    label: 'Lab Tester',
    base: '/lab',
    nav: [
      ['Dashboard', ''],
      ['Testing Requests', 'requests'],
      ['Pending Tests', 'pending'],
      ['Submit Results', 'submit'],
      ['Lab Reports', 'reports'],
      ['Testing History', 'history'],
      ['Profile', 'profile'],
    ],
  },
  DISTRIBUTOR: {
    label: 'Distributor',
    base: '/distributor',
    nav: [
      ['Dashboard', ''],
      ['Incoming Batches', 'incoming'],
      ['Distribution', 'distribution'],
      ['Shipments', 'shipments'],
      ['Delivery Status', 'delivery'],
      ['History', 'history'],
      ['Profile', 'profile'],
    ],
  },
  ADMIN: {
    label: 'Administrator',
    base: '/admin',
    nav: [
      ['Dashboard', ''],
      ['User Management', 'users'],
      ['Role Management', 'roles'],
      ['Hives', 'hives'],
      ['Harvests', 'harvests'],
      ['Batch Management', 'batches'],
      ['Processing Monitoring', 'processing'],
      ['Laboratory Monitoring', 'laboratory'],
      ['Distribution Monitoring', 'distribution'],
      ['Blockchain Monitoring', 'blockchain'],
      ['Audit Logs', 'audit-logs'],
      ['Anomalies', 'anomalies'],
      ['Reports', 'reports'],
      ['Settings', 'settings'],
    ],
  },
  CONSUMER: {
    label: 'Consumer',
    base: '/consumer',
    nav: [
      ['Product Verification', ''],
      ['QR Scanner', 'scan'],
      ['Verification History', 'history'],
      ['Profile', 'profile'],
    ],
  },
};

export const roleLabel = (role) => ROLES[role]?.label ?? role;
export const homeFor = (role) => ROLES[role]?.base ?? '/';
/** Absolute path inside a role's view, e.g. link('PROCESSOR', 'batches/HC-1') -> /processor/batches/HC-1 */
export const pathFor = (role, sub = '') => `${homeFor(role)}${sub ? `/${sub}` : ''}`;
/** True when `path` is inside the given role's view (used to honour "return to" after login) */
export const isInsideRole = (role, path) => Boolean(path) && (path === homeFor(role) || path.startsWith(`${homeFor(role)}/`));
