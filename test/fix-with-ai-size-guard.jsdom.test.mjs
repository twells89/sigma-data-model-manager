/**
 * Fix with AI — output-size guard + truncation detection tests.
 *
 * Fix with AI asks the AI to re-emit the ENTIRE model, but provider output is
 * capped (OpenAI 8000x3, Gemini 8000, Anthropic tool path 4096). Covers:
 *   (a) pre-flight guard: oversized model -> no fetch, "too large" warning toast
 *   (b) small model + valid JSON -> applied as before
 *   (c) OpenAI finish_reason 'length' on all attempts -> "cut off" (not a parse error)
 *   (d) non-truncated invalid JSON -> "invalid JSON"
 *   (e) Gemini MAX_TOKENS -> "cut off"
 *   (f) Anthropic tool path stop_reason max_tokens, no JSON -> "cut off", bounded calls
 * fetch is stubbed — no network.
 *
 * Run: node test/fix-with-ai-size-guard.jsdom.test.mjs
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

const SAVE_ERR = 'Cannot resolve columns formula reference Orders/Amount';

function smallModel() {
  return { schemaVersion: 1, name: 'Small', pages: [{ id: 'p1', name: 'Page 1', elements: [
    { id: 'e1', kind: 'table', source: { kind: 'warehouse-table', path: ['DB', 'S', 'ORDERS'] },
      columns: [{ id: 'c1', formula: '[ORDERS/Amount]' }, { id: 'c2', formula: '[ORDERS/Qty]' }] } ] }] };
}
function bigModel() {
  const elements = [];
  for (let e = 0; e < 41; e++) {
    const columns = [];
    for (let c = 0; c < 12; c++) {
      columns.push({ id: `c${e}_${c}`, name: `Column ${e} ${c}`, formula: `If([T${e}/Amount] > ${c}, [T${e}/Qty] * ${c} + Coalesce([T${e}/Discount], 0), Round([T${e}/Price] / Max([T${e}/Qty], 1), 2))` });
    }
    elements.push({ id: `e${e}`, kind: 'table', source: { kind: 'warehouse-table', path: ['DB', 'S', `T${e}`] }, columns });
  }
  return { schemaVersion: 1, name: 'Big', pages: [{ id: 'p1', name: 'Page 1', elements }] };
}

const toasts = () => [...window.document.querySelectorAll('#toastContainer .toast')].map(t => ({ cls: t.className, text: t.textContent }));
const lastToast = () => toasts().slice(-1)[0] || { cls: '', text: '' };

let calls;
function setup(model, provider, fetchImpl) {
  window.document.getElementById('toastContainer').innerHTML = '';
  window.document.getElementById('jsonEditor').value = JSON.stringify(model, null, 2);
  window.document.getElementById('fixAIProvider').value = provider;
  window.document.getElementById('fixAIKey').value = 'sk-test';
  window.showSaveErrorBanner(SAVE_ERR);
  window.document.getElementById('fixAIProvider').value = provider;
  calls = [];
  window.fetch = async (url, opts) => { calls.push({ url: String(url), body: opts?.body }); return fetchImpl(String(url), opts, calls.length); };
}
const jsonRes = (obj, headers = {}) => ({ ok: true, status: 200, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => obj, text: async () => JSON.stringify(obj) });
const openaiRes = (content, finish) => jsonRes({ choices: [{ message: { content }, finish_reason: finish }] });

// ── (a) oversized model: no fetch ────────────────────────────────────────────
for (const provider of ['openai', 'gemini', 'anthropic']) {
  setup(bigModel(), provider, () => { throw new Error('fetch must not be called'); });
  const before = window.document.getElementById('jsonEditor').value;
  await window.fixWithAI();
  const t = lastToast();
  check(`(a) ${provider}: no fetch for oversized model`, calls.length === 0, `calls=${calls.length}`);
  check(`(a) ${provider}: warning toast says "too large"`, /too large/.test(t.text) && /warning/.test(t.cls), t.text);
  check(`(a) ${provider}: toast has save-error excerpt`, t.text.includes('Cannot resolve columns'), t.text);
  check(`(a) ${provider}: editor untouched + banner visible`, window.document.getElementById('jsonEditor').value === before && window.document.getElementById('saveErrorBanner').style.display !== 'none');
}
check('(a) budget constants', window.eval("_fixAIOutputBudget('openai')") === 24000 && window.eval("_fixAIOutputBudget('gemini')") === 8000 && window.eval("_fixAIOutputBudget('anthropic')") === 4096);

// ── (b) small model + valid JSON applied ─────────────────────────────────────
{
  const fixed = smallModel(); fixed.name = 'Fixed';
  setup(smallModel(), 'openai', () => openaiRes(JSON.stringify(fixed), 'stop'));
  await window.fixWithAI();
  const ed = window.document.getElementById('jsonEditor').value;
  check('(b) one call, editor updated with AI model', calls.length === 1 && JSON.parse(ed).name === 'Fixed', `calls=${calls.length}`);
  check('(b) success toast', /AI fix applied/.test(lastToast().text), lastToast().text);
}

// ── (c) truncated on all 3 attempts ──────────────────────────────────────────
{
  const partial = JSON.stringify(smallModel(), null, 2);
  setup(smallModel(), 'openai', () => openaiRes(partial.slice(0, partial.indexOf('"columns"') + 20) + '[{"id":"c1",', 'length'));
  await window.fixWithAI();
  const t = lastToast();
  check('(c) 3 bounded calls', calls.length === 3, `calls=${calls.length}`);
  check('(c) error says "cut off", not "Expected double-quoted"', /cut off/.test(t.text) && !/Expected double-quoted/.test(t.text), t.text);
}

// ── (d) invalid JSON, not truncated ──────────────────────────────────────────
{
  setup(smallModel(), 'openai', () => openaiRes('Sorry, here is my analysis: {not json', 'stop'));
  await window.fixWithAI();
  const t = lastToast();
  check('(d) "invalid JSON" error, not cut off', /invalid JSON/.test(t.text) && !/cut off/.test(t.text) && calls.length === 1, t.text);
}

// ── (e) Gemini MAX_TOKENS ────────────────────────────────────────────────────
{
  setup(smallModel(), 'gemini', () => jsonRes({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"schemaVersion":1,"pages":[{"elements":[' }] } }] }));
  await window.fixWithAI();
  const t = lastToast();
  check('(e) gemini MAX_TOKENS -> cut off', /cut off/.test(t.text) && calls.length === 1, t.text);
  // and a normal Gemini STOP still works
  const fixed = smallModel(); fixed.name = 'GemFixed';
  setup(smallModel(), 'gemini', () => jsonRes({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(fixed) }] } }] }));
  await window.fixWithAI();
  check('(e) gemini STOP still applies', JSON.parse(window.document.getElementById('jsonEditor').value).name === 'GemFixed');
}

// ── (f) Anthropic tool path, max_tokens, no JSON ─────────────────────────────
{
  setup(smallModel(), 'anthropic', (url, opts, n) => {
    if (JSON.parse(opts.body).max_tokens === 1) return jsonRes({}, { 'anthropic-ratelimit-input-tokens-limit': '400000', 'anthropic-ratelimit-input-tokens-remaining': '400000' });
    return jsonRes({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"schemaVersion":1,"pages":[{"elements":[{"id":"e1",' }] });
  });
  await window.fixWithAI();
  const t = lastToast();
  check('(f) anthropic max_tokens -> cut off', /cut off/.test(t.text), t.text);
  check('(f) bounded calls (probe + 1 reply, no re-prompt loop)', calls.length === 2, `calls=${calls.length}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);
