/**
 * JSDOM harness for beads-sigma-fah8 — the "hard DAX" gap workarounds (browser
 * surface), mirroring src/powerbi.hard-dax.test.ts in the MCP repo:
 *
 *   Family 1 — USERELATIONSHIP inside CALCULATE → inactive relationship
 *     activated as a distinctly-named alternate join path (TOTABLE_VIA_FROMCOL);
 *     derived View surfaces alternate-keyed columns and SKIPS join keys;
 *     metrics combining measures on different join paths are refused.
 *   Family 2 — bare EARLIER idioms (running total / group total / peer count)
 *     lower onto kind:'sql' window helper elements; unrecognized EARLIER
 *     flag-not-drop with the DAX preserved.
 *   Family 3 — complex FILTER predicates in CALCULATE → conditional
 *     aggregates; IN {…} → or-chain; FILTER(ALL(T), pred) → GrandTotal(AggIf);
 *     ALLEXCEPT/ALLSELECTED → flag-not-drop.
 *
 * Run (repo root, after `npm install --no-save jsdom`):
 *   node test/pbi-hard-dax.jsdom.test.mjs
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

function ensureEl(id, tag = 'div') {
  let el = window.document.getElementById(id);
  if (!el) { el = window.document.createElement(tag); el.id = id; window.document.body.appendChild(el); }
  return el;
}
const out = ensureEl('pbiJsonOutput', 'textarea');
const warnBox = ensureEl('pbiWarningBox');
ensureEl('pbiOutputStats'); ensureEl('pbiFileList'); ensureEl('pbiInputStats');
ensureEl('pbiConvertBtn', 'button');
['pbiCopyBtn', 'pbiLoadBtn', 'pbiSaveBtn'].forEach(id => ensureEl(id, 'button'));
ensureEl('pbiConnectionId', 'input').value = '';
ensureEl('pbiDatabase', 'input').value = '';
ensureEl('pbiSchema', 'input').value = '';

// ── shared inline TMSL fixture (mirror of the MCP test fixture) ──────────────
const M_NAV = (table) => [
  'let Source = Snowflake.Databases("x.snowflakecomputing.com","WH"),',
  'N1 = Source{[Name="CSA",Kind="Database"]}[Data],',
  'N2 = N1{[Name="TJ",Kind="Schema"]}[Data],',
  `N3 = N2{[Name="${table}",Kind="Table"]}[Data] in N3`,
].join('\n');

const col = (name, dataType = 'string') => ({ name, dataType, sourceColumn: name });

function ordersModel(opts = {}) {
  return {
    model: {
      tables: [
        {
          name: 'ORDERS',
          columns: [
            col('ORDER_ID'), col('REGION'), col('STATUS'),
            col('AMOUNT', 'double'), col('ORDER_DATE_KEY', 'int64'), col('SHIP_DATE_KEY', 'int64'),
            ...(opts.calcCols || []).map(c => ({ ...c, type: 'calculated' })),
          ],
          partitions: [{ source: { type: 'm', expression: M_NAV('ORDER_FACT') } }],
          measures: opts.measures || [],
        },
        {
          name: 'DATE_DIM',
          columns: [col('DATE_KEY', 'int64'), col('FULL_DATE', 'dateTime'), col('MONTH_NAME')],
          partitions: [{ source: { type: 'm', expression: M_NAV('DATE_DIM') } }],
        },
      ],
      relationships: opts.relationships ?? [
        { name: 'r1', fromTable: 'ORDERS', fromColumn: 'ORDER_DATE_KEY', toTable: 'DATE_DIM', toColumn: 'DATE_KEY' },
        { name: 'r2', fromTable: 'ORDERS', fromColumn: 'SHIP_DATE_KEY', toTable: 'DATE_DIM', toColumn: 'DATE_KEY', isActive: false },
      ],
    },
  };
}

async function convert(modelObj) {
  const text = JSON.stringify(modelObj);
  const file = new window.File([text], 'hard-dax.bim', { type: 'application/json' });
  if (typeof file.text !== 'function') file.text = async () => text;
  out.value = '';
  warnBox.innerHTML = '';
  await window.processPbiFile(file);
  window.runPbiConversion();
  assert.ok(out.value && out.value.trim().length,
    `pbiJsonOutput empty — conversion failed. jsdomErrors:\n${consoleErrors.join('\n')}`);
  return { result: JSON.parse(out.value), warnText: warnBox.textContent || '' };
}

const els = (r) => r.pages[0].elements;
const elByName = (r, name) => els(r).find(e => e.name === name);
function metricsOf(r) {
  const m = {};
  for (const el of els(r)) for (const x of (el.metrics || [])) m[x.name] = x.formula;
  return m;
}
const sqlStatements = (r) => els(r).filter(e => e?.source?.kind === 'sql').map(e => e.source.statement);

let passed = 0;
const ok = (label) => { passed++; console.log('  ✓ ' + label); };

// ════ Family 3: unit tests on window.pbiDaxToSigma ════════════════════════════
const dax = (expr, w = [], name = 'x') => window.pbiDaxToSigma(expr, w, name);

assert.equal(
  dax('CALCULATE(SUM(T[AMT]), FILTER(T, T[REGION] = "West" && T[STATUS] = "Active" || T[PRIORITY] = "High"))'),
  'SumIf([AMT], [REGION] = "West" and [STATUS] = "Active" or [PRIORITY] = "High")');
ok('f3: boolean AND/OR predicate → SumIf with and/or');

assert.equal(
  dax('CALCULATE(SUM(E[SAL]), E[STATUS] = "Active", E[TYPE] = "Full-Time")'),
  'SumIf([SAL], [STATUS] = "Active" and [TYPE] = "Full-Time")');
ok('f3: multi-predicate CALCULATE args AND together');

assert.equal(
  dax('CALCULATE(COUNTROWS(T), T[TYPE] IN {"A", "B", "C"})'),
  'CountIf(([TYPE] = "A" or [TYPE] = "B" or [TYPE] = "C"))');
assert.equal(
  dax('CALCULATE(COUNTROWS(T), NOT T[TYPE] IN {"A", "B"})'),
  'CountIf(([TYPE] != "A" and [TYPE] != "B"))');
assert.ok(!/\bIsIn\b/.test(dax('CALCULATE(SUM(T[V]), T[TYPE] IN {"A", "B"})') || ''), 'IsIn must never be emitted');
ok('f3: IN {…} → or-chain; NOT IN → and-chain of !=; no IsIn');

assert.equal(
  dax('CALCULATE(DISTINCTCOUNT(S[ID]), FILTER(S, S[SEV] <> "Low"))'),
  'CountDistinctIf([ID], [SEV] != "Low")');
assert.equal(dax('CALCULATE(COUNTROWS(S), S[FLAG] = TRUE())'), 'CountIf([FLAG] = True)');
ok('f3: <> → != ; TRUE() → True');

assert.equal(
  dax('CALCULATE(SUM(T[AMT]), FILTER(ALL(T), T[AMT] > 100))'),
  'GrandTotal(SumIf([AMT], [AMT] > 100))');
ok('f3: FILTER(ALL(T), pred) → GrandTotal(AggIf(…))');

{
  const w1 = [];
  assert.equal(dax('CALCULATE(SUM(T[AMT]), REMOVEFILTERS(T[REGION]))', w1, 'm1'), 'GrandTotal(Sum([AMT]))');
  assert.ok(w1.some(w => /EXACT when \[REGION\] is the only grouping/.test(w)));
  const w2 = [];
  assert.equal(dax('CALCULATE(SUM(T[AMT]), ALL(T[REGION]))', w2, 'm2'), 'GrandTotal(Sum([AMT]))');
  assert.ok(w2.some(w => /window total over the remaining dimensions/.test(w)));
  ok('f3: REMOVEFILTERS/ALL(T[col]) → GrandTotal + loud caveat');
}

{
  const w = [];
  assert.equal(dax('CALCULATE(SUM(T[AMT]), ALLEXCEPT(T, T[DEPT]))', w, 'pct'), null);
  assert.ok(w.some(x => /pct/.test(x) && /subtotal semantics/.test(x) && x.includes('ALLEXCEPT(T, T[DEPT])')),
    'warning must preserve the original DAX');
  ok('f3: ALLEXCEPT → flag-not-drop with the DAX preserved');
}

{
  const w = [];
  assert.equal(dax('CALCULATE(SUM(T[AMT]), FILTER(T, T[X] > [Avg X]))', w, 'm'), null);
  assert.ok(w.some(x => /aggregate\/measure/.test(x)));
  ok('f3: predicate comparing to a measure/aggregate refuses');
}

assert.equal(
  dax('DIVIDE(CALCULATE(SUM(T[AMT]), T[A] = 1), CALCULATE(SUM(T[AMT]), T[B] = 2))'),
  '(SumIf([AMT], [A] = 1)) / (SumIf([AMT], [B] = 2))');
ok('f3: spliced conditional aggregates survive inside DIVIDE wrappers');

// ════ Family 2: unit tests on window.pbiParseEarlierWindow ════════════════════
{
  const w = window.pbiParseEarlierWindow(
    'CALCULATE(SUM(ORDERS[AMOUNT]), FILTER(ALL(ORDERS), ORDERS[ORDER_DATE_KEY] <= EARLIER(ORDERS[ORDER_DATE_KEY])))');
  assert.ok(w);
  assert.equal(w.op, 'AGG_RUNNING');
  assert.equal(w.valueFn, 'SUM');
  assert.equal(w.valueColSql, 'AMOUNT');
  assert.equal(w.orderColSql, 'ORDER_DATE_KEY');
  assert.equal(w.orderDir, 'ASC');
  ok('f2 parse: running total → AGG_RUNNING SUM ordered ASC');
}
{
  const w = window.pbiParseEarlierWindow(
    "SUMX(FILTER(ALL('ORDERS'), 'ORDERS'[REGION] = EARLIER('ORDERS'[REGION]) && 'ORDERS'[ORDER_DATE_KEY] <= EARLIER('ORDERS'[ORDER_DATE_KEY])), 'ORDERS'[AMOUNT])");
  assert.ok(w);
  assert.equal(w.op, 'AGG_RUNNING');
  assert.deepEqual(JSON.parse(JSON.stringify(w.partitionRaw)), ['REGION']);
  ok('f2 parse: partitioned running total keeps equality terms as PARTITION BY');
}
{
  const g = window.pbiParseEarlierWindow(
    'SUMX(FILTER(ALL(ORDERS), ORDERS[REGION] = EARLIER(ORDERS[REGION])), ORDERS[AMOUNT])');
  assert.equal(g.op, 'AGG_PARTITION');
  assert.deepEqual(JSON.parse(JSON.stringify(g.partitionRaw)), ['REGION']);
  const c = window.pbiParseEarlierWindow(
    'COUNTROWS(FILTER(ALL(ORDERS), ORDERS[REGION] = EARLIER(ORDERS[REGION])))');
  assert.equal(c.op, 'AGG_PARTITION');
  assert.equal(c.valueColSql, '*');
  const p = window.pbiParseEarlierWindow('COUNTROWS(FILTER(ALL(ORDERS), ORDERS[AMOUNT] >= EARLIER(ORDERS[AMOUNT])))');
  assert.equal(p.op, 'AGG_RUNNING');
  assert.equal(p.valueColSql, '*');
  assert.equal(p.orderDir, 'DESC');
  ok('f2 parse: group total → AGG_PARTITION; peer count → COUNT(*); at-or-above → DESC');
}
assert.equal(window.pbiParseEarlierWindow(
  'COUNTROWS(FILTER(ALL(ORDERS), ORDERS[AMOUNT] > EARLIER(ORDERS[AMOUNT])))'), null,
  'strict > without +1 is NOT the running/rank tie semantics');
assert.equal(window.pbiParseEarlierWindow(
  'SUMX(FILTER(ALL(ORDERS), ORDERS[X] >= EARLIER(ORDERS[Y]) + 1), ORDERS[AMOUNT])'), null);
ok('f2 parse: unrecognized shapes degrade to null');

// ════ Family 1: unit test on window.pbiExtractUseRelationships ════════════════
{
  const r = window.pbiExtractUseRelationships(
    'CALCULATE(SUM(ORDERS[AMOUNT]), USERELATIONSHIP(ORDERS[SHIP_DATE_KEY], DATE_DIM[DATE_KEY]), ORDERS[STATUS] = "Done")');
  assert.equal(r.pairs.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(r.pairs[0])), {
    a: { table: 'ORDERS', column: 'SHIP_DATE_KEY' },
    b: { table: 'DATE_DIM', column: 'DATE_KEY' },
  });
  assert.equal(r.dax, 'CALCULATE(SUM(ORDERS[AMOUNT]), ORDERS[STATUS] = "Done")');
  ok('f1: extractUseRelationships strips the filter arg and collects the pair');
}

// ════ Family 1: integration through the real convert path ════════════════════
{
  const { result, warnText } = await convert(ordersModel({
    measures: [
      { name: 'Total Amount', expression: 'SUM(ORDERS[AMOUNT])' },
      { name: 'Ordered Amount', expression: 'CALCULATE(SUM(ORDERS[AMOUNT]), USERELATIONSHIP(ORDERS[ORDER_DATE_KEY], DATE_DIM[DATE_KEY]))' },
      { name: 'Shipped Amount', expression: 'CALCULATE(SUM(ORDERS[AMOUNT]), USERELATIONSHIP(ORDERS[SHIP_DATE_KEY], DATE_DIM[DATE_KEY]))' },
      { name: 'In Transit Amount', expression: '[Ordered Amount] - [Shipped Amount]' },
      { name: 'Shipped Done', expression: 'CALCULATE(SUM(ORDERS[AMOUNT]), USERELATIONSHIP(ORDERS[SHIP_DATE_KEY], DATE_DIM[DATE_KEY]), ORDERS[STATUS] = "Done")' },
    ],
  }));
  const orders = elByName(result, 'ORDER_FACT');
  assert.ok(orders, 'ORDER_FACT base element must exist');
  const relNames = (orders.relationships || []).map(r => r.name).sort();
  assert.deepEqual(relNames, ['DATE_DIM', 'DATE_DIM_VIA_SHIP_DATE_KEY']);
  ok('f1: inactive relationship activated as TOTABLE_VIA_FROMCOL');

  const m = metricsOf(result);
  assert.equal(m['Shipped Amount'], 'Sum([Amount])', 'the aggregate itself is unchanged');
  assert.ok(/Shipped Amount/.test(warnText) && /DATE_DIM_VIA_SHIP_DATE_KEY/.test(warnText) && /✅/.test(warnText),
    'expected an activation warning naming the alternate path');
  ok('f1: USERELATIONSHIP measure emits the plain aggregate + ✅ warning');

  assert.equal(m['Shipped Done'], 'SumIf([Amount], [Status] = "Done")');
  ok('f1: USERELATIONSHIP plus an extra predicate still becomes a conditional aggregate');

  assert.ok(!('In Transit Amount' in m), 'cross-path combination must not ship as a same-element scalar');
  assert.ok(/In Transit Amount/.test(warnText) && /DIFFERENT relationship paths/i.test(warnText));
  ok('f1: a metric COMBINING measures on different join paths is refused');

  const view = elByName(result, 'ORDER_FACT View');
  assert.ok(view, 'derived view must exist');
  const formulas = view.columns.map(c => c.formula);
  assert.ok(formulas.includes('[ORDER_FACT/DATE_DIM_VIA_SHIP_DATE_KEY/Full Date]'),
    `expected alternate-keyed Full Date, got: ${formulas.join(' | ')}`);
  assert.ok(formulas.includes('[ORDER_FACT/DATE_DIM/Full Date]'));
  assert.ok(!formulas.includes('[ORDER_FACT/DATE_DIM/Date Key]'), 'active-path join key must be skipped');
  assert.ok(!formulas.includes('[ORDER_FACT/DATE_DIM_VIA_SHIP_DATE_KEY/Date Key]'), 'alternate-path join key must be skipped');
  ok('f1: derived View carries alternate-path columns and SKIPS join-key passthroughs');
}

{
  const { result, warnText } = await convert(ordersModel({
    measures: [{ name: 'Total Amount', expression: 'SUM(ORDERS[AMOUNT])' }],
  }));
  const orders = elByName(result, 'ORDER_FACT');
  assert.deepEqual((orders.relationships || []).map(r => r.name), ['DATE_DIM']);
  assert.ok(/Inactive relationship/.test(warnText) && /skipped/.test(warnText));
  ok('f1: inactive relationship with NO USERELATIONSHIP usage is skipped');
}

// ════ Family 2: integration — calc-column idioms lower onto SQL helpers ═══════
{
  const { result, warnText } = await convert(ordersModel({
    calcCols: [
      { name: 'Running Amount', expression: 'CALCULATE(SUM(ORDERS[AMOUNT]), FILTER(ALL(ORDERS), ORDERS[ORDER_DATE_KEY] <= EARLIER(ORDERS[ORDER_DATE_KEY])))' },
      { name: 'Region Total', expression: 'SUMX(FILTER(ALL(ORDERS), ORDERS[REGION] = EARLIER(ORDERS[REGION])), ORDERS[AMOUNT])' },
      { name: 'Region Peers', expression: 'COUNTROWS(FILTER(ALL(ORDERS), ORDERS[REGION] = EARLIER(ORDERS[REGION])))' },
    ],
  }));
  const sqls = sqlStatements(result).join('\n;;\n');
  assert.match(sqls, /SUM\(AMOUNT\) OVER \(ORDER BY ORDER_DATE_KEY ASC\)/, 'running total OVER clause');
  assert.match(sqls, /SUM\(AMOUNT\) OVER \(PARTITION BY REGION\)/, 'group total OVER clause');
  assert.match(sqls, /COUNT\(\*\) OVER \(PARTITION BY REGION\)/, 'peer count OVER clause');
  assert.match(sqls, /FROM CSA\.TJ\.ORDER_FACT/, 'helpers select from the real warehouse table');
  assert.ok((warnText.match(/SQL window helper/g) || []).length >= 3, 'expected ✅ lowering warnings');
  const orders = elByName(result, 'ORDER_FACT');
  for (const c of orders.columns) {
    assert.ok(!/EARLIER|CumulativeSum|RankDense/i.test(c.formula || ''), `raw idiom leaked: ${c.formula}`);
  }
  ok('f2: calc-column idioms lower onto SQL window helper elements');

  // helpers sharing a partition reuse ONE sql element
  const partitioned = sqlStatements(result).filter(s => /PARTITION BY REGION/.test(s));
  assert.equal(partitioned.length, 1, 'one shared helper element for the REGION partition');
  assert.match(partitioned[0], /SUM\(AMOUNT\) OVER \(PARTITION BY REGION\)/);
  assert.match(partitioned[0], /COUNT\(\*\) OVER \(PARTITION BY REGION\)/);
  ok('f2: helpers sharing a partition reuse ONE sql element (cols unioned)');
}

{
  const weird = 'SUMX(FILTER(ALL(ORDERS), ORDERS[AMOUNT] >= EARLIER(ORDERS[ORDER_DATE_KEY]) * 2), ORDERS[AMOUNT])';
  const { result, warnText } = await convert(ordersModel({
    calcCols: [{ name: 'Weird Earlier', expression: weird }],
  }));
  assert.ok(/Weird Earlier/.test(warnText) && /unrecognized EARLIER/i.test(warnText)
    && warnText.includes('EARLIER(ORDERS[ORDER_DATE_KEY])'),
    'flag must preserve the original DAX');
  for (const el of els(result)) {
    for (const c of (el.columns || [])) assert.ok(!/EARLIER/i.test(c.formula || ''), `EARLIER leaked: ${c.formula}`);
  }
  ok('f2: unrecognized EARLIER flags with the original DAX preserved, drops the column');
}

// ════ Family 3: integration — metrics emit clean Sigma ════════════════════════
{
  const { result } = await convert(ordersModel({
    measures: [
      { name: 'West Active Amount', expression: 'CALCULATE(SUM(ORDERS[AMOUNT]), FILTER(ORDERS, ORDERS[REGION] = "West" && ORDERS[STATUS] = "Active"))' },
      { name: 'Priority Orders', expression: 'CALCULATE(COUNTROWS(ORDERS), ORDERS[STATUS] IN {"Open", "Rush"})' },
      { name: 'Big Order Total All', expression: 'CALCULATE(SUM(ORDERS[AMOUNT]), FILTER(ALL(ORDERS), ORDERS[AMOUNT] >= 500))' },
    ],
  }));
  const m = metricsOf(result);
  assert.equal(m['West Active Amount'], 'SumIf([Amount], [Region] = "West" and [Status] = "Active")');
  assert.equal(m['Priority Orders'], 'CountIf(([Status] = "Open" or [Status] = "Rush"))');
  assert.equal(m['Big Order Total All'], 'GrandTotal(SumIf([Amount], [Amount] >= 500))');
  for (const [name, formula] of Object.entries(m)) {
    assert.ok(!/&&|\|\||\bIN\s*\{|\bCALCULATE\b|\bFILTER\b|\bIsIn\b|<>/.test(formula),
      `raw DAX token leaked in "${name}": ${formula}`);
  }
  ok('f3: integration — metrics emit clean Sigma, no raw DAX tokens');
}

console.log(`PASS browser/JSDOM hard-dax (beads-sigma-fah8): ${passed} checks across Families 1/2/3`);
