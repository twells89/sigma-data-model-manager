/**
 * JSDOM harness for beads-sigma-lvdw (browser surface) — QuickSight calc-gap
 * port from sigma-data-model-mcp src/quicksight.ts (tj/calc-gap-workarounds).
 *
 * Loads index.html into JSDOM and exercises the inner converter functions
 * (quicksightFormulaToSigmaEx, qsAddAnalysisCalcCol) directly via dom.window,
 * mirroring the MCP-side src/quicksight.formula.test.ts:
 *   - sumIf/avgIf/minIf/maxIf/distinct_countIf → Sigma *If, arg order preserved
 *   - countIf(operand, cond) → CountIf(cond) (operand dropped, paren-balanced)
 *   - paren-BALANCED ifelse/switch (deep nesting no longer leaks literal ifelse()
 *   - medianIf/stdevIf/varIf family flag-not-drop (Null + description + warning)
 *   - REGEXP_* family → RegexpExtract/RegexpReplace/RegexpMatch/RegexpCount
 *   - unmapped regex tokens flag-not-drop
 *   - parseInt → Int(Number(…)), parseDecimal/decimalToInt/toString remaps
 *   - aggregate-level analysis calc fields → Sigma metrics (not calc columns)
 *
 * Run (repo root, after `npm install --no-save jsdom`):
 *   node test/qs-calc-gaps.jsdom.test.mjs
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

assert.equal(typeof window.quicksightFormulaToSigmaEx, 'function',
  `quicksightFormulaToSigmaEx not on window. jsdomErrors:\n${consoleErrors.join('\n')}`);
assert.equal(typeof window.qsAddAnalysisCalcCol, 'function', 'qsAddAnalysisCalcCol not on window');

function conv(expr) {
  const warnings = [];
  const r = window.quicksightFormulaToSigmaEx(expr, warnings);
  return { ...r, warnings };
}

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok ${label}`);
}

console.log('conditional aggregates → Sigma *If (field-first, no swap)');
const AGG_CASES = [
  ["sumIf({Sales}, {Region} = 'West')", 'SumIf([Sales], [Region] = "West")'],
  ["avgIf({Sales}, {Region} = 'West' AND {Year} = 2025)", 'AvgIf([Sales], [Region] = "West" AND [Year] = 2025)'],
  ["minIf({Sales}, {Region} = 'West')", 'MinIf([Sales], [Region] = "West")'],
  ["maxIf({Sales}, {Region} = 'West')", 'MaxIf([Sales], [Region] = "West")'],
  ["distinct_countIf({Customer Id}, {Region} = 'West')", 'CountDistinctIf([Customer Id], [Region] = "West")'],
  ["countIf({Order Id}, {Status} = 'Shipped')", 'CountIf([Status] = "Shipped")'],
  ['countIf({Is Active})', 'CountIf([Is Active])'],
  ["ifelse(sumIf({Sales}, ({Region} = 'West' OR {Region} = 'East')) > 0, 1, 0)",
    'If(SumIf([Sales], ([Region] = "West" OR [Region] = "East")) > 0, 1, 0)'],
];
for (const [input, expected] of AGG_CASES) {
  check(input, () => {
    const r = conv(input);
    assert.equal(r.formula, expected);
    assert.ok(!/\bifelse\s*\(/i.test(r.formula), `literal ifelse( leaked: ${r.formula}`);
    assert.equal(r.warnings.length, 0, `unexpected warnings: ${r.warnings.join(' | ')}`);
  });
}

check('medianIf/stdevIf/stdevpIf/varIf/varpIf flag-not-drop', () => {
  for (const fn of ['medianIf', 'stdevIf', 'stdevpIf', 'varIf', 'varpIf']) {
    const r = conv(`${fn}({Sales}, {Region} = 'West')`);
    assert.equal(r.formula, 'Null', `${fn} must degrade to Null`);
    assert.ok(r.description?.includes(fn), `${fn} description must carry the original`);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /Sigma has no/i);
  }
});

console.log('REGEXP-style functions → Sigma Regexp*');
const REGEX_CASES = [
  ["regexp_extract({Email}, '@(.*)$')", 'RegexpExtract([Email], "@(.*)$")'],
  ["REGEXP_EXTRACT({Email}, '@(.*)$')", 'RegexpExtract([Email], "@(.*)$")'],
  ["regexp_substr({Email}, '@.*')", 'RegexpExtract([Email], "@.*")'],
  ["regexp_replace({Phone}, '[^0-9]', '')", 'RegexpReplace([Phone], "[^0-9]", "")'],
  ["regexp_like({Sku}, '^AB-')", 'RegexpMatch([Sku], "^AB-")'],
  ["regexp_matches({Sku}, '^AB-')", 'RegexpMatch([Sku], "^AB-")'],
  ["rlike({Sku}, '^AB-')", 'RegexpMatch([Sku], "^AB-")'],
  ["regexp_count({Notes}, 'error')", 'RegexpCount([Notes], "error")'],
];
for (const [input, expected] of REGEX_CASES) {
  check(input, () => {
    const r = conv(input);
    assert.equal(r.formula, expected);
    assert.equal(r.warnings.length, 0, `unexpected warnings: ${r.warnings.join(' | ')}`);
  });
}

check('unmapped regex tokens flag-not-drop', () => {
  for (const expr of ["regexp_instr({Sku}, 'AB')", "regexp_split_to_array({Csv}, ',')"]) {
    const r = conv(expr);
    assert.equal(r.formula, 'Null');
    assert.ok(r.description, 'description must carry the original expression');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /no 1:1 Sigma equivalent/);
  }
});

check('regex pattern string literals are not munged', () => {
  const r = conv("regexp_extract({Code}, '([A-Z]{2})-(\\\\d+)')");
  assert.match(r.formula, /^RegexpExtract\(\[Code\], /);
  assert.equal(r.warnings.length, 0);
});

console.log('parse/convert family');
check('parseInt → Int(Number(…))', () => {
  assert.equal(conv('parseInt({Code})').formula, 'Int(Number([Code]))');
});
check('parseInt nested in ifelse', () => {
  assert.equal(conv('ifelse(parseInt({Code}) > 5, 1, 0)').formula,
    'If(Int(Number([Code])) > 5, 1, 0)');
});
check('parseDecimal → Number; toString → Text; decimalToInt → Int', () => {
  assert.equal(conv('parseDecimal({Code})').formula, 'Number([Code])');
  assert.equal(conv('toString({Qty})').formula, 'Text([Qty])');
  assert.equal(conv('decimalToInt({Qty})').formula, 'Int([Qty])');
});

console.log('existing degrades stay intact');
check('window/table-calc functions still degrade to Null', () => {
  const r = conv('runningSum(sum({Sales}), [{Order Date} ASC])');
  assert.equal(r.formula, 'Null');
  assert.equal(r.warnings.length, 1);
});
check('parameter refs still degrade to Null', () => {
  const r = conv('${BasePeriod} + 1');
  assert.equal(r.formula, 'Null');
  assert.equal(r.warnings.length, 1);
});

console.log('aggregate-level analysis calc fields → Sigma metrics');
check('no derived view: metric lands on primary element', () => {
  const primary = {
    id: 'el1', kind: 'table', name: 'ORDER_FACT',
    source: { kind: 'warehouse-table', path: ['CSA', 'TJ', 'ORDER_FACT'] },
    columns: [], metrics: [], order: [],
  };
  const warnings = [];
  window.qsAddAnalysisCalcCol(
    { primary, primaryColMap: new Map() },
    'West Sales', "sumIf({Sales}, {Region} = 'West')",
    new Map(), [primary], null, [], warnings);
  assert.equal(primary.columns.length, 0, 'must NOT add a calc column');
  assert.equal(primary.metrics.length, 1, 'must add exactly one metric');
  assert.equal(primary.metrics[0].name, 'West Sales');
  assert.equal(primary.metrics[0].formula, 'SumIf([Sales], [Region] = "West")');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /aggregate-level calculated field → Sigma metric/);
});

check('derived view: metric lands on view, cross-element refs → "Field (REL)"', () => {
  const dim = {
    id: 'dim1', kind: 'table', name: 'CUSTOMER_DIM',
    source: { kind: 'warehouse-table', path: ['CSA', 'TJ', 'CUSTOMER_DIM'] },
    columns: [{ id: 'c1', name: 'Region', formula: '[REGION]' }], order: ['c1'],
  };
  const primary = {
    id: 'el2', kind: 'table', name: 'ORDER_FACT',
    source: { kind: 'warehouse-table', path: ['CSA', 'TJ', 'ORDER_FACT'] },
    columns: [], metrics: [], order: [],
    relationships: [{ name: 'CUSTOMER_DIM', targetElementId: 'dim1' }],
  };
  const view = {
    id: 'dv1', kind: 'table', name: 'Order Fact View',
    source: { kind: 'table', elementId: 'el2' },
    columns: [{ id: 'v1', formula: '[ORDER_FACT/Sales]' }], order: ['v1'],
  };
  const warnings = [];
  window.qsAddAnalysisCalcCol(
    { primary, primaryColMap: new Map() },
    'West Sales', "sumIf({Sales}, {Region} = 'West')",
    new Map([['el2', view]]), [primary, dim, view], null, [], warnings);
  assert.equal((primary.metrics || []).length, 0, 'metric must not land on primary');
  assert.ok(view.metrics && view.metrics.length === 1, 'metric must land on the derived view');
  assert.equal(view.metrics[0].formula, 'SumIf([Sales], [REGION (CUSTOMER_DIM)] = "West")',
    'cross-element ref must use the "Field (REL)" display form');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Sigma metric/);
});

check('non-aggregate calc fields still become calc columns (not metrics)', () => {
  const primary = {
    id: 'el3', kind: 'table', name: 'ORDER_FACT',
    source: { kind: 'warehouse-table', path: ['CSA', 'TJ', 'ORDER_FACT'] },
    columns: [], metrics: [], order: [],
  };
  const warnings = [];
  window.qsAddAnalysisCalcCol(
    { primary, primaryColMap: new Map() },
    'Margin Pct', '{Profit} / {Revenue}',
    new Map(), [primary], null, [], warnings);
  assert.equal(primary.metrics.length, 0, 'must not become a metric');
  assert.equal(primary.columns.length, 1, 'must be a calc column');
  assert.equal(primary.columns[0].formula, '[Profit] / [Revenue]');
});

console.log(`PASS browser/JSDOM qs-calc-gaps: ${passed} checks green`);
