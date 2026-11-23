// Run demonstration lab-result CSV files through the SAME pipeline as the laboratory form:
//   1. the lab form's own measurement validation (lab.routes.js measurementFields, zod)
//   2. the Python AI service POST /v1/lab-analysis (standards engine + Random Forest status)
//   3. the same automatic-outcome rule as the app (outcomeFor: PASS / FAIL / INCOMPLETE / ANALYSIS_ERROR)
//
// TEST FIXTURES ONLY. Nothing is written to any database. The outcome is computed from the measured
// values only: sample ids and any "expected_*" column are NEVER used as inputs - an expected column is
// read only to compare with the computed outcome afterwards.
//
// Usage (from backend/, AI service running):
//   node scripts/lab-csv-fixtures.js tests/fixtures/honeychain_lab_results_correct_demo.csv tests/fixtures/honeychain_lab_results_incorrect_demo.csv
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { measurementFields } from '../src/modules/lab.routes.js';
import { ai } from '../src/services/aiClient.js';
import { outcomeFor } from '../src/services/labAnalysis.js';

// header aliases -> lab form field names (case/spacing/units ignored)
const ALIASES = {
  moisturePct: ['moisture', 'moisturepct', 'moisture%', 'moisturepercent', 'moisturepercentage'],
  hmfMgKg: ['hmf', 'hmfmgkg', 'hmfmg/kg', 'hydroxymethylfurfural'],
  sucroseG100g: ['sucrose', 'sucroseg100g', 'sucrosepct', 'sucrose%', 'sucrosepercent'],
  glucoseG100g: ['glucose', 'glucoseg100g', 'glucosepct', 'glucose%', 'glucosepercent'],
  fructoseG100g: ['fructose', 'fructoseg100g', 'fructosepct', 'fructose%', 'fructosepercent'],
  freeAcidityMeqKg: ['freeacidity', 'freeaciditymeqkg', 'acidity', 'freeacidity(meq/kg)'],
  electricalConductivityMsCm: ['electricalconductivity', 'electricalconductivitymscm', 'ec', 'conductivity', 'ecmscm'],
  ph: ['ph'],
  brix: ['brix', 'degreesbrix'],
  waterActivity: ['wateractivity', 'aw'],
};
const SNAKE = {
  moisturePct: 'moisture_pct', hmfMgKg: 'hmf_mg_kg', sucroseG100g: 'sucrose_g_100g', glucoseG100g: 'glucose_g_100g', fructoseG100g: 'fructose_g_100g',
  freeAcidityMeqKg: 'free_acidity_meq_kg', electricalConductivityMsCm: 'electrical_conductivity_ms_cm', ph: 'ph', brix: 'brix', waterActivity: 'water_activity',
};
const CATEGORY_ALIASES = { blossom: 'BLOSSOM', nectar: 'BLOSSOM', multifloral: 'BLOSSOM', honeydew: 'HONEYDEW', carviacallosa: 'CARVIA_CALLOSA',
  blend: 'BLEND_HONEYDEW_BLOSSOM', blendhoneydewblossom: 'BLEND_HONEYDEW_BLOSSOM' };
const norm = (h) => String(h).toLowerCase().replace(/[\s_\-()/.]/g, '').replace('g100g', 'g100g');

export function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  const header = rows.shift().map((h) => h.trim());
  return { header, records: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

/** Map one CSV record to lab-form fields. Unknown / id / expected columns are ignored as inputs. */
export function mapRecord(header, rec) {
  const byNorm = Object.fromEntries(header.map((h) => [norm(h), h]));
  const values = {};
  const mapped = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const h = aliases.map(norm).find((a) => a in byNorm);
    if (h) { values[field] = rec[byNorm[h]] === '' ? null : rec[byNorm[h]]; mapped[field] = byNorm[h]; }
  }
  const catHeader = ['honeycategory', 'category', 'honeytype', 'type'].find((a) => a in byNorm);
  const catRaw = catHeader ? norm(rec[byNorm[catHeader]]) : '';
  const honeyCategory = CATEGORY_ALIASES[catRaw] ?? (catRaw.toUpperCase() || 'BLOSSOM');
  const idHeader = ['sampleid', 'sample', 'id', 'samplecode', 'recordid'].find((a) => a in byNorm);
  const expHeader = header.find((h) => /^expected/i.test(h));
  return { values, mapped, honeyCategory, sampleId: idHeader ? rec[byNorm[idHeader]] : null,
    expected: expHeader ? String(rec[expHeader]).trim().toUpperCase() : null };
}

// The form's own field rules (ranges, number format). Missing values are allowed here so that a
// missing mandatory test is reported by the analysis as INCOMPLETE, as it is for a saved draft.
const lenient = z.object(Object.fromEntries(Object.keys(ALIASES).map((k) => [k, z.union([measurementFields[k], z.null(), z.undefined()])])));

/** Process one record exactly like a submitted lab form. */
export async function analyseRecord(r, { profile = 'FSSAI' } = {}) {
  const parsed = lenient.safeParse(r.values);
  if (!parsed.success) {
    // the lab form rejects these values (e.g. text in a number field, moisture 120 %) -> nothing is analysed
    return { outcome: 'INCOMPLETE', rejected: true, reasons: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), failing: [] };
  }
  const measurements = Object.fromEntries(Object.entries(SNAKE).map(([k, col]) => [col, parsed.data[k] == null ? null : Number(parsed.data[k])]));
  const resp = await ai.labAnalysis({ labReportId: 1, labReportCode: `CSV-${r.sampleId ?? 'ROW'}`.slice(0, 40), batchId: 1, batchCode: 'HC-0000-000000',
    honeyType: null, honeyCategory: r.honeyCategory, profile, referenceProfile: profile === 'FSSAI' ? 'CODEX' : 'FSSAI', measurements });
  if (!resp.ok) return { outcome: 'ANALYSIS_ERROR', reasons: [resp.error], failing: [] };
  const p = resp.data.standards.applicable;
  return {
    outcome: outcomeFor(resp.data.standardsStatus),
    standardsStatus: resp.data.standardsStatus,
    mlStatus: resp.data.mlStatus,
    failing: p.checks.filter((c) => c.outcome === 'FAIL').map((c) => `${c.label} ${c.value}${c.unit === 'ratio' ? '' : ` ${c.unit}`} (limit ${c.limit})`),
    reasons: [...p.missingTests.map((x) => `missing: ${x}`), ...p.implausibleInputs.map((x) => `implausible: ${x}`)],
  };
}

export async function runFile(file, opts = {}) {
  const { header, records } = parseCsv(fs.readFileSync(file, 'utf8'));
  const results = [];
  for (const rec of records) {
    const r = mapRecord(header, rec);
    results.push({ sampleId: r.sampleId, honeyCategory: r.honeyCategory, expected: r.expected, ...(await analyseRecord(r, opts)) });
  }
  const mappedColumns = mapRecord(header, records[0] ?? {}).mapped;
  return { file: path.basename(file), header, mappedColumns, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node scripts/lab-csv-fixtures.js <file.csv> [...]'); process.exit(2); }
  let mismatches = 0;
  for (const f of files) {
    const out = await runFile(f);
    console.log(`\n=== ${out.file} (${out.results.length} records) - TEST FIXTURE, synthetic data`);
    console.log('columns used:', JSON.stringify(out.mappedColumns));
    const tally = {};
    for (const r of out.results) {
      tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
      const cmp = r.expected ? (r.expected === r.outcome ? 'matches expected' : `EXPECTED ${r.expected}`) : '';
      if (r.expected && r.expected !== r.outcome) mismatches++;
      console.log(`${String(r.sampleId ?? '-').padEnd(14)} ${r.outcome.padEnd(14)} ${cmp.padEnd(18)} ${[...r.failing, ...r.reasons].join('; ')}`);
    }
    console.log('outcomes:', JSON.stringify(tally));
  }
  console.log(mismatches ? `\n${mismatches} record(s) differ from the file's expected column (see above).` : '\nAll records with an expected column match the computed outcome.');
  process.exit(0);
}
