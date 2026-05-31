/**
 * JSDOM harness for beads-sigma-f0p / 862 / m1a (browser surface).
 *
 * Loads index.html into JSDOM, runs fixture_06_kitchen_sink.bim through the
 * real processPbiFile() + runPbiConversion() path (NO db/schema overrides),
 * and asserts the three DAX-gap fixes mirror the MCP node test:
 *   f0p — DATEDIFF(start, end, UNIT) -> DateDiff("unit", start, end)
 *   862 — CALCULATE(COUNTROWS, pred) -> single-arg CountIf(pred); no 2-arg CountIf
 *   m1a — cross-table ratio NOT emitted as a silently-null same-element metric
 *
 * Run (repo root, after `npm install --no-save jsdom`):
 *   node test/pbi-dax-gaps.jsdom.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', 'index.html');
const FIXTURE = '/Users/tjwells/sigma-skills-staging/powerbi-to-sigma/fixtures/fixture_06_kitchen_sink.bim';

const html = readFileSync(INDEX_HTML, 'utf8');
const bimText = readFileSync(FIXTURE, 'utf8');

const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + (e.detail?.stack || e.message)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://localhost/', virtualConsole: vc,
});
const { window } = dom;
window.sessionStorage.setItem('sigma_standalone_dev_mode', 'true');

function ensureEl(id, tag = 'div') {
  let el = window.document.getElementById(id);
  if (!el) { el = window.document.createElement(tag); el.id = id; window.document.body.appendChild(el); }
  return el;
}
const out = ensureEl('pbiJsonOutput', 'textarea');
const warnBox = ensureEl('pbiWarningBox');
ensureEl('pbiOutputStats'); ensureEl('pbiFileList');
ensureEl('pbiConvertBtn', 'button');
['pbiCopyBtn', 'pbiLoadBtn', 'pbiSaveBtn'].forEach(id => ensureEl(id, 'button'));
ensureEl('pbiConnectionId', 'input').value = '';
ensureEl('pbiDatabase', 'input').value = '';
ensureEl('pbiSchema', 'input').value = '';

const file = new window.File([bimText], 'fixture_06_kitchen_sink.bim', { type: 'application/json' });
if (typeof file.text !== 'function') file.text = async () => bimText;
await window.processPbiFile(file);
window.runPbiConversion();

assert.ok(out.value && out.value.trim().length,
  `pbiJsonOutput empty — conversion failed. jsdomErrors:\n${consoleErrors.join('\n')}`);

const result = JSON.parse(out.value);
const allMetrics = {};
for (const el of result.pages[0].elements)
  for (const m of (el.metrics || [])) allMetrics[m.name] = m.formula;

// warnings live in the warning box text (joined)
const warnText = warnBox.textContent || warnBox.innerHTML || '';

// f0p — Tenure Days calc col
let tenure;
for (const el of result.pages[0].elements)
  for (const c of (el.columns || [])) if (c.name === 'Tenure Days') tenure = c.formula;
assert.equal(tenure,
  'DateDiff("day", [Hire Date], If(IsNull([Termination Date]), Today(), [Termination Date]))',
  'f0p: Tenure Days DateDiff form');
assert.ok(!/\[(day|DAY|month|MONTH|year|YEAR)\]/.test(tenure), 'f0p: unit must not be bracketed');

// 862 — Active Headcount single-arg CountIf; no illegal 2-arg CountIf anywhere
assert.equal(allMetrics['Active Headcount'], 'CountIf([Status] = "Active")',
  '862: Active Headcount single-arg CountIf');
for (const [name, formula] of Object.entries(allMetrics))
  assert.ok(!/\bCountIf\(\s*\[[^\]]+\]\s*,/.test(formula),
    `862: illegal 2-arg CountIf in "${name}": ${formula}`);

// m1a — cross-table ratio not shipped as null metric
assert.ok(!('Absence Hours Per Head' in allMetrics),
  'm1a: cross-table ratio must not be a same-element (null) metric');
assert.ok(/Absence Hours Per Head/.test(warnText) && /cross-table/i.test(warnText),
  'm1a: expected a structured cross-table-ratio warning in the warning box');

console.log('PASS browser/JSDOM dax-gaps: f0p DateDiff("unit",a,b)  862 single-arg CountIf  m1a cross-table ratio refused');
console.log('  Active Headcount =>', allMetrics['Active Headcount']);
console.log('  Tenure Days      =>', tenure);
