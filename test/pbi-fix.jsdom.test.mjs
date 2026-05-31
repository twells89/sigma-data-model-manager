/**
 * JSDOM harness for beads-sigma-j89 + beads-sigma-tkd (browser surface).
 *
 * Loads index.html into JSDOM (runScripts: dangerously), loads model_clean.bim
 * through the real processPbiFile() upload path (so the script-scoped _pbiModel
 * is populated exactly as in the browser), then invokes runPbiConversion() with
 * NO database/schema overrides, parses #pbiJsonOutput, and asserts the same
 * three outcomes as the MCP node test:
 *   (a) Snowflake source paths auto-derived to ["CSA","TJ","<TABLE>"]
 *   (b) every base warehouse-table element has a `name`
 *   (c) top-level schemaVersion === 1
 *
 * Run (from repo root, after `npm install --no-save jsdom`):
 *   node test/pbi-fix.jsdom.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', 'index.html');
const MODEL_CLEAN = '/tmp/pbix/model_clean.bim';

const html = readFileSync(INDEX_HTML, 'utf8');
const bimText = readFileSync(MODEL_CLEAN, 'utf8');

const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + (e.detail?.stack || e.message)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://localhost/',
  virtualConsole: vc,
});
const { window } = dom;
window.sessionStorage.setItem('sigma_standalone_dev_mode', 'true');

function ensureEl(id, tag = 'div') {
  let el = window.document.getElementById(id);
  if (!el) { el = window.document.createElement(tag); el.id = id; window.document.body.appendChild(el); }
  return el;
}
const out = ensureEl('pbiJsonOutput', 'textarea');
ensureEl('pbiWarningBox'); ensureEl('pbiOutputStats'); ensureEl('pbiFileList');
ensureEl('pbiConvertBtn', 'button');
['pbiCopyBtn', 'pbiLoadBtn', 'pbiSaveBtn'].forEach(id => ensureEl(id, 'button'));
ensureEl('pbiConnectionId', 'input').value = '';   // -> <CONNECTION_ID>
ensureEl('pbiDatabase', 'input').value = '';        // NO override
ensureEl('pbiSchema', 'input').value = '';          // NO override

// Drive the real upload path so the script-scoped _pbiModel is populated.
assert.equal(typeof window.processPbiFile, 'function', 'processPbiFile must be exposed');
const file = new window.File([bimText], 'model_clean.bim', { type: 'application/json' });
// jsdom's File lacks .text()/.arrayBuffer(); polyfill what processPbiFile needs.
if (typeof file.text !== 'function') file.text = async () => bimText;
await window.processPbiFile(file);

assert.equal(typeof window.runPbiConversion, 'function', 'runPbiConversion must be exposed');
window.runPbiConversion();

assert.ok(
  out.value && out.value.trim().length,
  `pbiJsonOutput empty — conversion failed. jsdomErrors:\n${consoleErrors.join('\n')}`
);

const result = JSON.parse(out.value);
const bases = result.pages[0].elements.filter(e => e?.source?.kind === 'warehouse-table');

assert.equal(result.schemaVersion, 1, '(c) top-level schemaVersion must be 1');

assert.ok(bases.length >= 3, `expected >=3 base elements, got ${bases.length}`);
for (const el of bases) {
  assert.ok(typeof el.name === 'string' && el.name.length, `(b) base element ${el.id} missing name`);
  assert.equal(el.name, el.source.path[el.source.path.length - 1], '(b) base name must equal table');
}

const byTail = {};
for (const el of bases) byTail[el.source.path[el.source.path.length - 1]] = el.source.path;
for (const tbl of ['EMPLOYEES', 'ABSENCE_RECORDS', 'SAFETY_INCIDENTS']) {
  assert.deepEqual(byTail[tbl], ['CSA', 'TJ', tbl],
    `(a) path for ${tbl} should be ["CSA","TJ","${tbl}"], got ${JSON.stringify(byTail[tbl])}`);
}

console.log('PASS browser/JSDOM: (a) Snowflake paths auto-derived  (b) base elements named  (c) schemaVersion=1');
console.log('  base elements:', bases.map(e => `${e.name}=${JSON.stringify(e.source.path)}`).join('  '));
