/**
 * JSDOM browser-surface test for the 2026-06-12 Retail Analysis Sample fix batch,
 * mirroring src/powerbi.fix-4.test.ts in the MCP repo (beads p146 / f5kp).
 * Fixture: fixtures/retail-analysis-model.bim — the real MS Retail Analysis
 * Sample TMSL (auto date tables stripped, calc columns materialized as physical).
 *
 *   p146 — CALCULATE([TotalSales], ScenarioID=1) over a measure CHAIN
 *          (TotalSales = [m1]+[m2]) distributes the predicate over each leaf
 *          aggregate instead of cascade-dropping the TY/LY family.
 *   COUNTA — New Stores (CALCULATE(COUNTA(col), FILTER(ALL(Store), pred)))
 *          → GrandTotal(CountIf(pred)).
 *   cross-table guard — Sales Per Sq Ft (sums a Store column from a Sales
 *          measure) drops LOUDLY instead of posting an error-typed metric.
 *
 * Run (from repo root): npm install --no-save jsdom && node --test test/pbi-retail-chain.jsdom.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', 'index.html');
const RETAIL_BIM = join(__dirname, '..', 'fixtures', 'retail-analysis-model.bim');

let _cached = null;
async function convert() {
  if (_cached) return _cached;
  const html = readFileSync(INDEX_HTML, 'utf8');
  const bimText = readFileSync(RETAIL_BIM, 'utf8');
  const consoleErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + (e.detail?.stack || e.message)));
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc });
  const { window } = dom;
  window.sessionStorage.setItem('sigma_standalone_dev_mode', 'true');
  const ensureEl = (id, tag = 'div') => {
    let el = window.document.getElementById(id);
    if (!el) { el = window.document.createElement(tag); el.id = id; window.document.body.appendChild(el); }
    return el;
  };
  const out = ensureEl('pbiJsonOutput', 'textarea');
  ensureEl('pbiWarningBox'); ensureEl('pbiOutputStats'); ensureEl('pbiFileList');
  ensureEl('pbiConvertBtn', 'button');
  ['pbiCopyBtn', 'pbiLoadBtn', 'pbiSaveBtn'].forEach(id => ensureEl(id, 'button'));
  ensureEl('pbiConnectionId', 'input').value = '';
  ensureEl('pbiDatabase', 'input').value = 'CSA';
  ensureEl('pbiSchema', 'input').value = 'TJ';
  const file = new window.File([bimText], 'model.bim', { type: 'application/json' });
  if (typeof file.text !== 'function') file.text = async () => bimText;
  await window.processPbiFile(file);
  window.runPbiConversion();
  assert.ok(out.value && out.value.trim().length, `conversion failed:\n${consoleErrors.join('\n')}`);
  const warnBox = window.document.getElementById('pbiWarningBox');
  _cached = { dm: JSON.parse(out.value), warningsText: warnBox ? warnBox.textContent : '' };
  return _cached;
}

test('p146: TY/LY measure chain survives (TotalSalesTY = 2 SumIf leaves)', async () => {
  const { dm } = await convert();
  const sales = dm.pages[0].elements.find(e => e.name === 'SALES');
  assert.ok(sales, 'SALES element exists');
  const names = (sales.metrics || []).map(m => m.name);
  for (const want of ['TotalSalesTY', 'TotalSalesLY', 'This Year Sales', 'Last Year Sales', 'Total Sales Variance %']) {
    assert.ok(names.includes(want), `metric "${want}" dropped (have: ${names.join(', ')})`);
  }
  const ty = sales.metrics.find(m => m.name === 'TotalSalesTY');
  assert.equal((String(ty.formula).match(/SumIf\(/g) || []).length, 2, `TY formula: ${ty.formula}`);
});

test('COUNTA: New Stores → GrandTotal(CountIf(pred))', async () => {
  const { dm } = await convert();
  const store = dm.pages[0].elements.find(e => e.name === 'STORE');
  const ns = (store.metrics || []).find(m => m.name === 'New Stores');
  assert.ok(ns, `New Stores metric should be emitted (have: ${(store.metrics || []).map(m => m.name).join(', ')})`);
  assert.match(String(ns.formula), /GrandTotal\(CountIf\(/, `got: ${ns.formula}`);
});

test('cross-table guard: Sales Per Sq Ft drops loudly, not as a silent error metric', async () => {
  const { dm, warningsText } = await convert();
  const sales = dm.pages[0].elements.find(e => e.name === 'SALES');
  assert.ok(!(sales.metrics || []).some(m => m.name === 'Sales Per Sq Ft'),
    'cross-table metric must not be emitted on the SALES element');
  assert.match(warningsText, /Sales Per Sq Ft/, 'must warn about the dropped cross-table measure');
});

test('relationship key coercion: ReportingPeriodID calc key is Number()-wrapped (mcp #55)', async () => {
  const { dm } = await convert();
  const sales = dm.pages[0].elements.find(e => e.name === 'SALES');
  const rp = (sales.columns || []).find(c => c.name === 'ReportingPeriodID');
  assert.ok(rp, 'ReportingPeriodID calc column emitted');
  assert.match(String(rp.formula), /^Number\(/, `expected Number() wrap, got: ${rp.formula}`);
});
