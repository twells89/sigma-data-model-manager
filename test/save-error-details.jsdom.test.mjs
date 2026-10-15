/**
 * Save error details — sigmaSaveErrorMessage tests.
 *
 * Sigma's spec endpoints put the real reasons in errors[].summary; `message` is only
 * the count. Covers:
 *   (a) message + one errors[].summary -> "message: summary"
 *   (b) two errors joined with '; '
 *   (c) no errors[] -> message only
 *   (d) non-JSON body -> first 500 chars
 *   (e) empty body -> fallback
 *   (f) end to end: saveDataModel POST failure surfaces the real cause in the toast
 *       and the banner, and the "table hasn't been synced" hint fires
 * sigmaFetch is stubbed — no network.
 *
 * Run: node test/save-error-details.jsdom.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, 'x.mjs'));
const { JSDOM, VirtualConsole } = require('jsdom');
const INDEX_HTML = process.env.SMM_INDEX_PATH || join(__dirname, '..', 'index.html');

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM(readFileSync(INDEX_HTML, 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc });
const { window } = dom;
window.sessionStorage.setItem('sigma_standalone_dev_mode', 'true');

let fail = 0;
const check = (label, ok, extra) => {
  if (ok) console.log(`✓ ${label}`);
  else { fail++; console.log(`✗ ${label}${extra ? ' — ' + extra : ''}`); }
};

const SRC = "Source not found: warehouse table 'DB.S.T' on connection 'c'.";
const body = (errors, message = '1 schema error in data model spec') => JSON.stringify({ message, errors });

// ── (a)-(e) helper unit cases ────────────────────────────────────────────────
{
  const r = window.sigmaSaveErrorMessage(body([{ summary: SRC }]), 'HTTP 400');
  check('(a) message + summary', r === `1 schema error in data model spec: ${SRC}`, r);
}
{
  const r = window.sigmaSaveErrorMessage(body([{ summary: 'First problem.' }, { summary: 'Second problem.' }]), 'HTTP 400');
  check('(b) two errors joined with "; "', r === '1 schema error in data model spec: First problem.; Second problem.', r);
}
{
  const r = window.sigmaSaveErrorMessage(JSON.stringify({ message: 'Bad request' }), 'HTTP 400');
  check('(c) no errors[] -> message only', r === 'Bad request', r);
}
{
  const raw = '<html>' + 'x'.repeat(600) + '</html>';
  const r = window.sigmaSaveErrorMessage(raw, 'HTTP 502');
  check('(d) non-JSON body -> first 500 chars', r === raw.slice(0, 500) && r.length === 500, `len=${r.length}`);
}
{
  const r = window.sigmaSaveErrorMessage('', 'HTTP 500');
  check('(e) empty body -> fallback', r === 'HTTP 500', r);
}

// ── (f) end to end through saveDataModel ─────────────────────────────────────
const toasts = () => [...window.document.querySelectorAll('#toastContainer .toast')];
const lastToast = () => toasts().slice(-1)[0] || { className: '', textContent: '' };

function smallModel() {
  return { schemaVersion: 1, name: 'Small', folderId: 'folder-1', pages: [{ id: 'p1', name: 'Page 1', elements: [
    { id: 'e1', kind: 'table', source: { kind: 'warehouse-table', path: ['DB', 'S', 'T'] },
      columns: [{ id: 'c1', formula: '[T/Amount]' }] } ] }] };
}

window.document.getElementById('toastContainer').innerHTML = '';
window.document.getElementById('jsonEditor').value = JSON.stringify(smallModel(), null, 2);
window.eval("state.accessToken = 'tok'; state.isNewModel = true; state.selectedModel = null;");
window.sigmaFetch = async (path, opts) => {
  if (opts?.method === 'POST') {
    return { ok: false, status: 400, statusText: 'Bad Request',
      headers: { get: () => 'application/json' },
      text: async () => body([{ summary: SRC }]) };
  }
  throw new Error('unexpected sigmaFetch ' + path);
};

await window.saveDataModel();

const t = lastToast();
const bannerMsg = window.document.getElementById('saveErrorMsg').textContent;
check('(f) toast contains real cause', t.textContent.includes('Source not found'), t.textContent);
check('(f) banner contains real cause', bannerMsg.includes('Source not found'), bannerMsg);
check('(f) banner hint "table hasn\'t been synced" fires', bannerMsg.includes("table hasn't been synced"), bannerMsg);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);
