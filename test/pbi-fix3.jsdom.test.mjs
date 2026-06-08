/**
 * JSDOM browser-surface test for the 2026-06-08 PBI fix batch (qx16/hs5h/jzd8),
 * mirroring src/powerbi.fix-3.test.ts in the MCP repo. Loads index.html, runs the
 * real Comp & Distribution model.bim through processPbiFile()/runPbiConversion(),
 * and asserts:
 *   qx16 — "Mgmt Headcount" (CALCULATE([Headcount], KEEPFILTERS(SEARCH..>0)))
 *          translates to a conditional aggregate (not dropped).
 *   hs5h — "Salary vs Company Median" (DIVIDE(a-b, c)) is parenthesized when present.
 *   jzd8 — no base warehouse-table element carries a window-fn calc column.
 *
 * Run (from repo root): npm install --no-save jsdom && node --test test/pbi-fix3.jsdom.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', 'index.html');
const COMP_BIM = '/tmp/pbi-migrate/workforce-comp-distribution-untested-dax/model/model.bim';

async function convert() {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const bimText = readFileSync(COMP_BIM, 'utf8');
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
  ensureEl('pbiDatabase', 'input').value = '';
  ensureEl('pbiSchema', 'input').value = '';
  const file = new window.File([bimText], 'model.bim', { type: 'application/json' });
  if (typeof file.text !== 'function') file.text = async () => bimText;
  await window.processPbiFile(file);
  window.runPbiConversion();
  assert.ok(out.value && out.value.trim().length, `conversion failed:\n${consoleErrors.join('\n')}`);
  return JSON.parse(out.value);
}

test('qx16: Mgmt Headcount translates to a conditional aggregate (not dropped)', async () => {
  const dm = await convert();
  const metrics = dm.pages[0].elements.flatMap(e => e.metrics || []);
  const mgmt = metrics.find(m => m.name === 'Mgmt Headcount');
  assert.ok(mgmt, 'Mgmt Headcount metric should be emitted');
  assert.match(String(mgmt.formula), /Count(Distinct)?If\(/, `got: ${mgmt && mgmt.formula}`);
});

test('jzd8: no base warehouse-table element carries a window-fn calc column', async () => {
  const dm = await convert();
  for (const el of dm.pages[0].elements) {
    if (el?.source?.kind !== 'warehouse-table') continue;
    for (const c of (el.columns || [])) {
      assert.doesNotMatch(String(c.formula || ''), /\b(Rank|RankDense|Lag|Lead)\s*\(/,
        `base "${el.name}" col "${c.name}" has window formula: ${c.formula}`);
    }
  }
});

test('hs5h: Salary vs Company Median is parenthesized when present', async () => {
  const dm = await convert();
  const metrics = dm.pages[0].elements.flatMap(e => e.metrics || []);
  const svc = metrics.find(m => m.name === 'Salary vs Company Median');
  if (svc) assert.match(String(svc.formula), /\)\s*\/\s*\(/, `got: ${svc.formula}`);
});
