/**
 * JSDOM harness for the Qlik inter-record / window-function workarounds
 * (beads-sigma-7dgk, browser surface — mirror of mcp src/qlik.test.ts).
 *
 * Loads index.html into JSDOM and exercises the inline Qlik converter:
 *   Rank/Above/Below/Previous/Peek → Sigma Rank/Lag/Lead formulas reported as
 *     workbook patterns (GROUPED workbook element context — window functions
 *     silently error in DM calc columns/metrics; never injected into the spec)
 *   RangeSum/Avg(Above(expr, off, n)) → rolling-window Lag chain via the
 *     existing Range folding
 *   FirstSortedValue → kind:'sql' QUALIFY helper element + Min() metric, or
 *     the Rank=n-filter pattern (verify-me) when the simple form doesn't hold
 *   HRank / pivot column-axis functions / script-time Peek → flag-not-drop
 *     ('unsupported' pattern entry + warning)
 *
 * Run (repo root, after `npm install --no-save jsdom`):
 *   node test/qlik-calc-gaps.jsdom.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', 'index.html');
const html = readFileSync(INDEX_HTML, 'utf8');

const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + (e.detail?.stack || e.message)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://localhost/', virtualConsole: vc,
});
const { window } = dom;
window.sessionStorage.setItem('sigma_standalone_dev_mode', 'true');

const FSV_SENTINEL = '__QLIK_FSV__';   // const isn't a window prop; literal mirror

// ───────────────────────── unit level: qlikExprToSigma ─────────────────────

// 1. Rank(Sum(x)) → Rank(…, "desc") with ctx.window
{
  const ctx = { patterns: [] };
  const f = window.qlikExprToSigma('Rank(Sum(SALES_AMOUNT))', [], 'R', ctx);
  assert.equal(f, 'Rank(Sum(SALES_AMOUNT), "desc")', 'Rank → Rank(…, "desc")');
  assert.equal(ctx.window, true, 'Rank sets ctx.window');
  assert.equal(ctx.kind, 'rank');
}

// 1b. Rank(total …) strips the total qualifier
{
  const ctx = { patterns: [] };
  const f = window.qlikExprToSigma('Rank(total Sum(SALES_AMOUNT))', [], 'R', ctx);
  assert.equal(f, 'Rank(Sum(SALES_AMOUNT), "desc")', 'total qualifier stripped');
}

// 2. Above(Sum(x)) → Lag(…, 1); Below → Lead; negative offset flips
{
  const ctx = { patterns: [] };
  const f = window.qlikExprToSigma('Above(Sum(SALES_AMOUNT))', [], 'A', ctx);
  assert.equal(f, 'Lag(Sum(SALES_AMOUNT), 1)', 'Above → Lag');
  assert.equal(ctx.window, true);
  assert.equal(ctx.kind, 'lag');
  assert.equal(ctx.verify, true, 'Above sets verify (sort-order dependent)');
}
{
  const ctx = { patterns: [] };
  assert.equal(window.qlikExprToSigma('Below(Sum(SALES_AMOUNT))', [], 'B', ctx),
    'Lead(Sum(SALES_AMOUNT), 1)', 'Below → Lead');
  assert.equal(ctx.kind, 'lead');
}
{
  const ctx = { patterns: [] };
  assert.equal(window.qlikExprToSigma('Above(Sum(SALES_AMOUNT), -1)', [], 'N', ctx),
    'Lead(Sum(SALES_AMOUNT), 1)', 'negative offset flips Lag → Lead');
}

// 3. RangeAvg(Above(expr, 0, 3)) → 3-term Lag list folded by the Range translation
{
  const ctx = { patterns: [] };
  const f = window.qlikExprToSigma('RangeAvg(Above(Sum(SALES_AMOUNT), 0, 3))', [], 'Roll3', ctx);
  assert.equal(f,
    '((Coalesce(Sum(SALES_AMOUNT), 0) + Coalesce(Lag(Sum(SALES_AMOUNT), 1), 0) + Coalesce(Lag(Sum(SALES_AMOUNT), 2), 0)) / 3)',
    'rolling 3-window expands to a Lag chain inside the RangeAvg folding');
  assert.equal(ctx.window, true);
  assert.equal(ctx.kind, 'lag');
}

// 3b. Above range form outside a Range aggregation → flag-not-drop
{
  const ctx = { patterns: [] };
  const f = window.qlikExprToSigma('Above(Sum(SALES_AMOUNT), 0, 3)', [], 'BadRange', ctx);
  assert.equal(f, null);
  assert.equal(ctx.patterns.length, 1);
  assert.equal(ctx.patterns[0].kind, 'unsupported');
}

// 4. HRank → flag-not-drop 'unsupported' into ctx.patterns
{
  const ctx = { patterns: [] };
  const warnings = [];
  const f = window.qlikExprToSigma('HRank(Sum(SALES_AMOUNT))', warnings, 'H', ctx);
  assert.equal(f, null, 'HRank returns null (degrade)');
  assert.equal(ctx.patterns.length, 1);
  assert.equal(ctx.patterns[0].kind, 'unsupported');
  assert.match(ctx.patterns[0].note, /COLUMN dimension/);
  assert.ok(warnings.some(w => /HRank/.test(w)), 'HRank warning pushed');
  assert.ok(!ctx.window, 'HRank must NOT set ctx.window');
}

// 4b. Previous → Lag(…, 1) with load-order warning; Peek('f', -2) → Lag([f], 2)
{
  const ctx = { patterns: [] };
  const warnings = [];
  assert.equal(window.qlikExprToSigma('Previous(SALES_AMOUNT)', warnings, 'P', ctx),
    'Lag(SALES_AMOUNT, 1)');
  assert.ok(warnings.some(w => /LOAD-ORDER/.test(w)));
}
{
  const ctx = { patterns: [] };
  assert.equal(window.qlikExprToSigma("Peek('SALES_AMOUNT', -2)", [], 'P2', ctx),
    'Lag([SALES_AMOUNT], 2)');
}
{
  const ctx = { patterns: [] };
  const f = window.qlikExprToSigma("Peek('SALES_AMOUNT', 0)", [], 'Abs', ctx);
  assert.equal(f, null);
  assert.match(ctx.patterns[0].note, /ABSOLUTE load-order/);
}

// 5. standalone FirstSortedValue → FSV sentinel; nested → flag-not-drop
{
  const f = window.qlikExprToSigma('FirstSortedValue(CUSTOMER, -Sum(SALES_AMOUNT))', [], 'Top');
  assert.ok(f && f.startsWith(FSV_SENTINEL), 'standalone FSV returns the sentinel-tagged expr');
  assert.equal(f, FSV_SENTINEL + 'FirstSortedValue(CUSTOMER, -Sum(SALES_AMOUNT))');
}
{
  const ctx = { patterns: [] };
  const f = window.qlikExprToSigma('Upper(FirstSortedValue(CUSTOMER, -Sum(SALES_AMOUNT)))', [], 'Nested', ctx);
  assert.equal(f, null, 'nested FSV degrades');
  assert.equal(ctx.patterns[0].kind, 'unsupported');
  assert.match(ctx.patterns[0].note, /nested inside a larger expression/);
}

// 6. fsvRankPattern fallback builds If(Rank(…, "desc") = 1, [CUSTOMER], Null)
{
  const fp = window._qFsvRankPattern('FirstSortedValue(CUSTOMER, -Sum(SALES_AMOUNT))', [], 'Top Customer');
  assert.equal(fp.kind, 'first-sorted-value');
  assert.equal(fp.verify, true);
  assert.equal(fp.formula, 'If(Rank(Sum(SALES_AMOUNT), "desc") = 1, [CUSTOMER], Null)');
  assert.match(fp.requires, /GROUPED workbook element/);
}

// ───────────────── end-to-end: runQlikConversion via the paste path ─────────

function ensureEl(id, tag = 'div') {
  let el = window.document.getElementById(id);
  if (!el) { el = window.document.createElement(tag); el.id = id; window.document.body.appendChild(el); }
  return el;
}
const out = ensureEl('qlikJsonOutput', 'textarea');
const warnBox = ensureEl('qlikWarningBox');
const stats = ensureEl('qlikOutputStats');
ensureEl('qlikConvertBtn', 'button');
['qlikCopyBtn', 'qlikLoadBtn', 'qlikSaveBtn'].forEach(id => ensureEl(id, 'button'));
ensureEl('qlikConnectionId', 'input').value = 'conn-1';
ensureEl('qlikDatabase', 'input').value = 'CSA';
ensureEl('qlikSchema', 'input').value = 'TJ';

const fixture = {
  appName: 'IR Test',
  tables: [{
    name: 'SALES',
    noOfRows: 100,
    fields: [
      { name: 'CUSTOMER', distinctValueCount: 10 },
      { name: 'REGION', distinctValueCount: 4 },
      { name: 'SALES_AMOUNT', distinctValueCount: 90 },
    ],
  }],
  masterMeasures: [
    { title: 'Sales Rank', expr: 'Rank(Sum(SALES_AMOUNT))' },
    { title: 'Rolling 3', expr: 'RangeAvg(Above(Sum(SALES_AMOUNT), 0, 3))' },
    { title: 'Top Customer', expr: 'FirstSortedValue(CUSTOMER, -Sum(SALES_AMOUNT))' },
    { title: 'Top Cust Upper', expr: 'FirstSortedValue(Upper(CUSTOMER), -Sum(SALES_AMOUNT))' },
    { title: 'H', expr: 'HRank(Sum(SALES_AMOUNT))' },
    { title: 'Total Sales', expr: 'Sum(SALES_AMOUNT)' },
  ],
  masterDimensions: [
    { title: 'Region Rank', fieldDef: '=Rank(Sum(SALES_AMOUNT))' },
  ],
};
ensureEl('qlikJsonInput', 'textarea').value = JSON.stringify(fixture);
window.runQlikConversion();

assert.ok(out.value && out.value.trim().length,
  `qlikJsonOutput empty — conversion failed. jsdomErrors:\n${consoleErrors.join('\n')}`);
const result = JSON.parse(out.value);
const elements = result.pages[0].elements;
const allMetrics = {};
for (const el of elements) for (const m of (el.metrics || [])) allMetrics[m.name] = m.formula;

const patterns = window._qlikWorkbookPatterns;
assert.ok(Array.isArray(patterns), 'window._qlikWorkbookPatterns exposed');
const byName = {};
for (const p of patterns) byName[p.name] = p;

// Rank measure → pattern with ready formula + element placement, no DM metric
assert.ok(!('Sales Rank' in allMetrics), 'Rank measure must NOT be a DM metric');
assert.equal(byName['Sales Rank'].kind, 'rank');
assert.equal(byName['Sales Rank'].formula, 'Rank(Sum([Sales Amount]), "desc")');
assert.match(byName['Sales Rank'].requires, /GROUPED workbook element/);
assert.equal(byName['Sales Rank'].elementName, 'Sales');

// Rolling 3 → Lag-chain pattern
assert.equal(byName['Rolling 3'].kind, 'lag');
assert.equal(byName['Rolling 3'].formula,
  '((Coalesce(Sum([Sales Amount]), 0) + Coalesce(Lag(Sum([Sales Amount]), 1), 0) + Coalesce(Lag(Sum([Sales Amount]), 2), 0)) / 3)');

// FSV simple form → SQL QUALIFY helper element + Min() metric (NOT a pattern)
const fsvEl = elements.find(e => e.name === 'Top Customer (FirstSortedValue)');
assert.ok(fsvEl, 'FSV SQL helper element missing');
assert.equal(fsvEl.source.kind, 'sql');
assert.equal(fsvEl.source.statement,
  'SELECT "CUSTOMER" AS "fsv_value" FROM "CSA"."TJ"."SALES" GROUP BY 1 QUALIFY ROW_NUMBER() OVER (ORDER BY SUM("SALES_AMOUNT") DESC) = 1');
assert.equal(fsvEl.columns[0].formula, '[Custom SQL/fsv_value]');
assert.equal(fsvEl.metrics[0].formula, 'Min([Fsv Value])');
assert.ok(!('Top Customer' in byName), 'simple FSV must not also emit a pattern');

// FSV complex value expr → Rank=n-filter pattern with display-name rewrite
assert.equal(byName['Top Cust Upper'].kind, 'first-sorted-value');
assert.equal(byName['Top Cust Upper'].verify, true);
assert.equal(byName['Top Cust Upper'].formula,
  'If(Rank(Sum([Sales Amount]), "desc") = 1, Upper([Customer]), Null)');

// HRank → unsupported flag-not-drop
assert.equal(byName['H'].kind, 'unsupported');
assert.equal(byName['H'].formula, undefined);

// Calc dimension with Rank → pattern (master-dimension note), no DM column
assert.equal(byName['Region Rank'].kind, 'rank');
assert.match(byName['Region Rank'].note, /master dimension/);
const salesEl = elements.find(e => e.name === 'Sales');
assert.equal(salesEl.columns.length, 3, 'no calc column added for the windowed dimension');

// Plain aggregate still becomes a DM metric
assert.equal(allMetrics['Total Sales'], 'Sum([Sales Amount])');

// Surface: 🧩 warning lines (kind + name + formula + placement) and stat badge
const warnText = warnBox.textContent || '';
assert.ok(/🧩 Workbook pattern \[rank\] "Sales Rank" → Rank\(Sum\(\[Sales Amount\]\), "desc"\)/.test(warnText),
  'per-pattern 🧩 warning line with kind, name and formula');
assert.ok(/GROUPED workbook element/.test(warnText), 'placement note surfaced');
assert.ok(/workbook pattern/.test(stats.innerHTML) && /🧩 5 workbook patterns/.test(stats.innerHTML),
  `stat badge shows pattern count — got: ${stats.innerHTML}`);
assert.equal(patterns.length, 5,
  `expected 5 patterns (rank, lag, first-sorted-value, unsupported, dim rank) — got ${patterns.length}: ${patterns.map(p => p.name).join(', ')}`);

console.log('PASS browser/JSDOM qlik-calc-gaps:');
console.log('  Rank        =>', byName['Sales Rank'].formula);
console.log('  Rolling 3   =>', byName['Rolling 3'].formula);
console.log('  FSV (sql)   =>', fsvEl.source.statement);
console.log('  FSV (rank)  =>', byName['Top Cust Upper'].formula);
console.log('  HRank       => flagged unsupported (flag-not-drop)');
