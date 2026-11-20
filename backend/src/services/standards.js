// Standards-based screening of lab values against published limits. This is a RULE, not AI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/standards.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

export function standardsProfile(name = process.env.STANDARDS_PROFILE || cfg.defaultProfile) {
  return { key: name, ...(cfg.profiles[name] ?? cfg.profiles[cfg.defaultProfile]) };
}

/** report: a lab_reports row (snake_case, numeric strings). */
export function screenReport(report, profileName) {
  const p = standardsProfile(profileName);
  const values = {
    ...report,
    fructose_plus_glucose:
      report.fructose_g_100g != null && report.glucose_g_100g != null
        ? Number(report.fructose_g_100g) + Number(report.glucose_g_100g)
        : null,
  };
  const checks = p.checks.map((c) => {
    const raw = values[c.parameter];
    const value = raw == null ? null : Number(raw);
    let outcome = 'NOT_MEASURED';
    if (value != null) {
      const bad = (c.max != null && value > c.max) || (c.min != null && value < c.min);
      outcome = bad ? 'EXCEEDS_LIMIT' : 'WITHIN_LIMIT';
    }
    return {
      parameter: c.parameter,
      label: c.label,
      value,
      limit: c.max != null ? `<= ${c.max}` : `>= ${c.min}`,
      unit: c.unit,
      outcome,
      ...(c.exceptions ? { exceptions: c.exceptions } : {}),
    };
  });
  return { kind: 'RULE_BASED', standard: p.name, source: p.source, profile: p.key, checks };
}
