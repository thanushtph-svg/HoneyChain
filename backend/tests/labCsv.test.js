// Demo lab-result CSV fixtures through the real validation + analysis pipeline (no database writes).
// Place the two files in backend/tests/fixtures/:
//   honeychain_lab_results_correct_demo.csv   -> every record must come out PASS (unless it is incomplete/invalid)
//   honeychain_lab_results_incorrect_demo.csv -> every complete, valid record must come out FAIL
// They are TEST FIXTURES ONLY (synthetic). The expected column is compared AFTER the outcome is computed,
// never used as an input. Skipped when the files or the AI service are not available.
import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFile } from '../scripts/lab-csv-fixtures.js';
import { aiHealth } from '../src/services/aiClient.js';
import { pool } from '../src/db/pg.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CORRECT = path.join(dir, 'honeychain_lab_results_correct_demo.csv');
const INCORRECT = path.join(dir, 'honeychain_lab_results_incorrect_demo.csv');

async function prerequisites(t, file) {
  if (!fs.existsSync(file)) { t.skip(`fixture not found: ${path.relative(process.cwd(), file)}`); return false; }
  if ((await aiHealth()).status !== 'up') { t.skip('AI service not running'); return false; }
  return true;
}
const print = (out) => out.results.map((r) => `${r.sampleId}: ${r.outcome}${r.expected ? ` (expected ${r.expected})` : ''} ${[...r.failing, ...r.reasons].join('; ')}`).join('\n');

test('correct demo CSV: complete, valid records are analysed as PASS', async (t) => {
  if (!(await prerequisites(t, CORRECT))) return;
  const out = await runFile(CORRECT);
  t.diagnostic(`\n${print(out)}`);
  assert.ok(out.results.length > 0);
  for (const r of out.results) {
    if (r.expected) assert.equal(r.outcome, r.expected, `${r.sampleId}: computed ${r.outcome}, file expects ${r.expected} - ${[...r.failing, ...r.reasons].join('; ')}`);
    else assert.ok(['PASS', 'INCOMPLETE'].includes(r.outcome), `${r.sampleId}: ${r.outcome} ${r.failing.join('; ')}`);
    assert.notEqual(r.outcome, 'ANALYSIS_ERROR');
  }
});

test('incorrect demo CSV: violating records are FAIL with the failing parameter named; missing/invalid are INCOMPLETE', async (t) => {
  if (!(await prerequisites(t, INCORRECT))) return;
  const out = await runFile(INCORRECT);
  t.diagnostic(`\n${print(out)}`);
  assert.ok(out.results.length > 0);
  for (const r of out.results) {
    if (r.expected) assert.equal(r.outcome, r.expected, `${r.sampleId}: computed ${r.outcome}, file expects ${r.expected} - ${[...r.failing, ...r.reasons].join('; ')}`);
    else assert.ok(['FAIL', 'INCOMPLETE'].includes(r.outcome), `${r.sampleId}: ${r.outcome}`);
    if (r.outcome === 'FAIL') assert.ok(r.failing.length > 0, `${r.sampleId}: FAIL must name the failing parameter`);
    if (r.outcome === 'INCOMPLETE') assert.ok(r.reasons.length > 0, `${r.sampleId}: INCOMPLETE must say what is missing or invalid`);
  }
});

test('AI service unavailable -> ANALYSIS_ERROR, never a PASS', async () => {
  const { env } = await import('../src/config/env.js');
  const { analyseRecord } = await import('../scripts/lab-csv-fixtures.js');
  const real = env.AI_SERVICE_URL;
  env.AI_SERVICE_URL = 'http://127.0.0.1:9';
  try {
    const r = await analyseRecord({ sampleId: 'X', honeyCategory: 'BLOSSOM', values: { moisturePct: '17.5', hmfMgKg: '12', sucroseG100g: '2',
      glucoseG100g: '31', fructoseG100g: '38.5', freeAcidityMeqKg: '22', electricalConductivityMsCm: '0.41' } });
    assert.equal(r.outcome, 'ANALYSIS_ERROR');
  } finally {
    env.AI_SERVICE_URL = real;
    await pool.end().catch(() => {});
  }
});
