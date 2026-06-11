/**
 * JSDOM harness for beads-sigma-5d9k (browser surface) — ThoughtSpot window
 * functions → grouped-element handoff.
 *
 * HARD CONSTRAINT under test: Sigma window functions (CumulativeSum, MovingAvg,
 * Rank, Lag, Lead, First, Last, …) silently compile to error-type columns in
 * data-model element calc columns and DM metrics — they only evaluate in
 * GROUPED elements. The converter must never emit a window function into a
 * host calc column or metric; instead each becomes a flagged Null placeholder
 * on the host + an auto-built grouped child element (the PBI time-intel
 * handoff pattern). Mirrors the MCP node test (src/thoughtspot.test.ts).
 *
 * Loads index.html into JSDOM, injects js-yaml (the page pulls it from a CDN,
 * which JSDOM does not fetch), pastes the shared regression fixture into the
 * real #tsYamlInput, and drives the real runThoughtSpotConversion() path.
 *
 * Run (repo root, after `npm install --no-save jsdom js-yaml`):
 *   node test/ts-window-functions.jsdom.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import jsyaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', 'index.html');
const FIXTURE = '/Users/tjwells/sigma-data-model-mcp/regression-corpus/thoughtspot/window_functions/input.yaml';

const html = readFileSync(INDEX_HTML, 'utf8');
const tmlText = readFileSync(FIXTURE, 'utf8');

const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + (e.detail?.stack || e.message)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://localhost/', virtualConsole: vc,
});
const { window } = dom;
window.sessionStorage.setItem('sigma_standalone_dev_mode', 'true');
window.jsyaml = jsyaml; // CDN script not fetched under JSDOM

// Drive the real conversion path: paste fixture → runThoughtSpotConversion()
window.document.getElementById('tsConnectionId').value = 'test-conn';
window.document.getElementById('tsDatabase').value = 'CSA';
window.document.getElementById('tsSchema').value = 'TJ';
window.document.getElementById('tsYamlInput').value = tmlText;
window.runThoughtSpotConversion();

const out = window.document.getElementById('tsJsonOutput').value;
assert.ok(out && out.trim().length && !out.startsWith('// Error'),
  `tsJsonOutput empty/error — conversion failed: ${out?.slice(0, 200)}. jsdomErrors:\n${consoleErrors.join('\n')}`);

const spec = JSON.parse(out);
const elements = spec.pages[0].elements;
const byName = n => elements.find(e => e.name === n);
const warnText = window.document.getElementById('tsWarningBox').innerHTML || '';

// ── Fixture-level expectations (expected.summary.json) ──────────────────────
assert.ok(elements.length >= 7, `expected ≥7 elements, got ${elements.length}`);
const relCount = elements.reduce((n, e) => n + (e.relationships || []).length, 0);
assert.ok(relCount >= 1, `expected ≥1 relationship, got ${relCount}`);

// ── No window function ever lands in a host calc column or metric ───────────
const winRe = /\b(CumulativeSum|CumulativeAvg|CumulativeMax|CumulativeMin|CumulativeCount|MovingAvg|MovingSum|MovingMax|MovingMin|Rank|Lag|Lead|First|Last)\s*\(/;
for (const el of elements) {
  if (el.groupings) continue; // grouped emission elements are the one allowed home
  for (const c of (el.columns || []))
    assert.ok(!winRe.test(c.formula || ''), `window fn leaked into calc col "${c.name}" on "${el.name}": ${c.formula}`);
  for (const m of (el.metrics || []))
    assert.ok(!winRe.test(m.formula || ''), `window fn leaked into metric "${m.name}" on "${el.name}": ${m.formula}`);
}

// ── cumulative_sum → grouped CumulativeSum element on host ──────────────────
{
  const el = byName('Revenue Running');
  assert.ok(el?.groupings?.length, 'Revenue Running grouped element missing');
  assert.equal(el.source.kind, 'table');
  const win = el.columns.find(c => c.name === 'Revenue Running');
  assert.equal(win.formula, 'CumulativeSum([Net Revenue])');
  const val = el.columns.find(c => c.name === 'Net Revenue');
  assert.equal(val.formula, 'Sum([Order Fact/Net Revenue])');
  const dim = el.columns.find(c => c.name === 'Order Date Key');
  assert.equal(dim.formula, '[Order Fact/Order Date Key]');
  assert.deepEqual(el.groupings[0].groupBy, [dim.id]);
  assert.deepEqual(el.groupings[0].calculations.sort(), [val.id, win.id].sort());
}

// ── moving_average(m, 2, 1, dim) → MovingAvg([v], 2, 1) ─────────────────────
{
  const el = byName('Revenue Moving Avg');
  assert.ok(el?.groupings?.length, 'Revenue Moving Avg grouped element missing');
  const win = el.columns.find(c => c.name === 'Revenue Moving Avg');
  assert.equal(win.formula, 'MovingAvg([Net Revenue], 2, 1)');
}

// ── rank_desc with cross-element dim groups on the derived view ─────────────
{
  const el = byName('Region Revenue Rank');
  assert.ok(el?.groupings?.length, 'Region Revenue Rank grouped element missing');
  const view = byName('Order Fact View');
  assert.ok(view, 'derived view missing');
  assert.equal(el.source.elementId, view.id, 'must source the derived join view');
  const win = el.columns.find(c => c.name === 'Region Revenue Rank');
  assert.equal(win.formula, 'Rank([Region Revenue Rank Base], "desc")');
  const dim = el.columns.find(c => c.name === 'Region');
  assert.equal(dim.formula, '[Order Fact View/Region (CUSTOMER_DIM)]');
  const val = el.columns.find(c => c.name === 'Region Revenue Rank Base');
  assert.equal(val.formula, 'Sum([Order Fact View/Net Revenue])');
}

// ── lag(m, dim, 1) → Lag([v], 1) grouped by dim ─────────────────────────────
{
  const el = byName('Prev Period Revenue');
  assert.ok(el?.groupings?.length, 'Prev Period Revenue grouped element missing');
  const win = el.columns.find(c => c.name === 'Prev Period Revenue');
  assert.equal(win.formula, 'Lag([Net Revenue], 1)');
}

// ── host carries flagged Null placeholders with re-author descriptions ──────
{
  const host = byName('Order Fact');
  for (const name of ['Revenue Running', 'Revenue Moving Avg', 'Region Revenue Rank', 'Prev Period Revenue', 'Running Pct']) {
    const c = host.columns.find(x => x.name === name);
    assert.ok(c, `placeholder "${name}" missing on host`);
    assert.equal(c.formula, 'Null', `placeholder "${name}" must be Null, got: ${c.formula}`);
    assert.match(c.description || '', /window function/i);
  }
}

// ── embedded window usage degrades flag-only (no grouped element) ───────────
assert.equal(byName('Running Pct'), undefined, 'embedded usage must not emit a grouped element');
assert.ok(/Running Pct/.test(warnText) && /embedded/.test(warnText),
  'expected an "embedded" warning for Running Pct in the warning box');

// ── `unique count` (two-word) → CountDistinct metric ────────────────────────
{
  const host = byName('Order Fact');
  const m = (host.metrics || []).find(x => x.name === 'Distinct Customers');
  assert.ok(m, 'Distinct Customers metric missing');
  assert.equal(m.formula, 'CountDistinct([Customer Key])');
}

console.log('PASS browser/JSDOM ts-window-functions:');
console.log(`  ${elements.length} elements, ${relCount} relationship(s)`);
console.log('  cumulative_sum  => grouped CumulativeSum([Net Revenue])');
console.log('  moving_average  => grouped MovingAvg([Net Revenue], 2, 1)');
console.log('  rank_desc       => grouped Rank([... Base], "desc") on derived view');
console.log('  lag             => grouped Lag([Net Revenue], 1)');
console.log('  embedded usage  => flag-only Null placeholder');
console.log('  unique count    => CountDistinct([Customer Key])');
