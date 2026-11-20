// Hashing must reproduce the test vector in docs/06-blockchain-hashing-spec.md exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashCanonical, recordKey } from '../src/services/canonical.js';

const record = {
  scheme: 'hc-v1', entityType: 'LAB_REPORT', entityCode: 'LAB-2026-000045', batchCode: 'HC-2026-000123',
  data: { labOrgCode: 'ORG-0001', sampleCode: 'S-0828-047-A', receivedOn: '2026-08-28', testedOn: '2026-08-28',
    moisturePct: '17.80', hmfMgKg: '9.60', sucroseG100g: '3.10', glucoseG100g: null, fructoseG100g: null, brix: null, ph: null,
    freeAcidityMeqKg: null, waterActivity: null, electricalConductivityMsCm: null,
    pollenIdentification: 'Multifloral pollen observed', adulterationMethod: 'C4 sugar (SCIRA)', adulterationResult: 'NOT_DETECTED',
    decision: 'PASS', decisionRemarks: 'Within limits' },
};

test('canonical JSON sorts keys and has no whitespace', () => {
  assert.ok(canonicalJson(record).startsWith('{"batchCode":"HC-2026-000123","data":{"adulterationMethod"'));
  assert.ok(!/\s{2}|": /.test(canonicalJson(record)));
});
test('record hash matches the documented test vector', () => {
  assert.equal(hashCanonical(canonicalJson(record)), '0xd33ca2e7547e1d17afa06427a2d91073e4fcbed267ab5cdfad91df17db9d2093');
});
test('record key matches the documented test vector', () => {
  assert.equal(recordKey('LAB_REPORT', 'LAB-2026-000045'), '0xb3a2ef7b7bf86228dfb2b64934c85aa884e3d91e98fe8b17622970790960c8b6');
});
test('changing one value changes the hash completely', () => {
  const changed = structuredClone(record); changed.data.moisturePct = '15.80';
  assert.equal(hashCanonical(canonicalJson(changed)), '0xe438d34c28d36536730b967c12c6e49e12b71b92f38f0789468d9734f999a42b');
});
test('key order in the input does not matter', () => {
  const reordered = { data: record.data, batchCode: record.batchCode, entityCode: record.entityCode, entityType: record.entityType, scheme: record.scheme };
  assert.equal(hashCanonical(canonicalJson(reordered)), hashCanonical(canonicalJson(record)));
});
