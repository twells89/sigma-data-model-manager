/**
 * Snowflake semantic view converter tests (browser surface) — shared semantic-tools engine.
 *
 * Drives the real panel (#snowYamlInput / #snowConnectionId / ... / #snowJsonOutput) in JSDOM:
 *   1. Every upstream golden fixture (fixtures/*.sql -> golden/*.json) through the panel;
 *      output JSON minus the top-level `name` equals the golden.
 *   2. Refusal fixtures (03,04,06,07,11): findings with codes shown, no spec, buttons disabled;
 *      03 -> best-effort button -> "Convert anyway" -> ok + overridden finding; 11 -> no best-effort button.
 *   3. Fixture 12 without database/schema: inputs revealed + NEEDS_* findings; fill -> golden.
 *   4. PLUGS YAML -> metrics exactly Profit, Profit Margin, Revenue (nothing invented).
 *   5. Synonyms / number-format checkboxes, column types (valid / invalid JSON), empty connection
 *      placeholder, friendly-names-off warning, multiple files + view picker, XSS-safe rendering,
 *      Load into Editor, bundled example, sync-script --check.
 *
 * Run: node test/snowflake-semantic-tools.jsdom.test.mjs
 * Env: SMM_INDEX_PATH (alternate index.html, used for mutation checks),
 *      ST_UPSTREAM (semantic-tools checkout __tests__ dir), MCP_REPO (sigma-data-model-mcp checkout).
 * jsdom resolves via createRequire from this directory (same as lookml-layered.jsdom.test.mjs).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, 'x.mjs'));
const { JSDOM, VirtualConsole } = require('jsdom');

const INDEX_HTML = process.env.SMM_INDEX_PATH || join(__dirname, '..', 'index.html');
const MCP = process.env.MCP_REPO || '/Users/tjwells/sst-merge/sigma-data-model-mcp';
const UP = process.env.ST_UPSTREAM || join(MCP, '.cache/semantic-tools/packages/cli/src/__tests__');
const FIX = join(UP, 'fixtures');
const GOLD = join(UP, 'golden');
const PLUGS = join(MCP, 'semantic-tools-embed/test/fixtures/plugs.yaml');
const CONN = '9ad28df9-5f5f-4bae-8985-bb12d25829de';

const html = readFileSync(INDEX_HTML, 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc });
const { window } = dom;
const doc = window.document;
window.sessionStorage.setItem('sigma_standalone_dev_mode', 'true');
let alertCalled = false;
window.alert = () => { alertCalled = true; };

let fail = 0, pass = 0;
const check = (label, ok, extra) => {
  if (ok) { pass++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}${extra ? ' — ' + extra : ''}`); }
};
const $ = (id) => doc.getElementById(id);

function setConn(id) {
  const sel = $('snowConnectionId');
  if (id && ![...sel.options].some(o => o.value === id)) {
    const o = doc.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o);
  }
  sel.value = id || '';
}

// Read before any reset(): reset() turns synonyms off so outputs compare byte-for-byte with the upstream goldens.
check('synonyms checkbox is on by default (page load)', $('snowSynonyms').checked === true);

function reset() {
  window.snowClearFiles();
  $('snowYamlInput').value = '';
  $('snowDatabase').value = '';
  $('snowSchema').value = '';
  $('snowSynonyms').checked = false;
  $('snowNumberFormats').checked = false;
  $('snowColumnTypes').value = '';
  $('snowDbSchemaRow').style.display = 'none';
  setConn(CONN);
  window.eval('wizardState.connections = []');
}

function convert(text, { db = '', schema = '', conn = CONN } = {}) {
  reset();
  setConn(conn);
  $('snowYamlInput').value = text;
  $('snowDatabase').value = db;
  $('snowSchema').value = schema;
  window.runSnowConversion();
  return read();
}

function read() {
  const raw = $('snowJsonOutput').value;
  let model = null;
  if (raw && !raw.startsWith('//')) { try { model = JSON.parse(raw); } catch (_) {} }
  const codes = [...$('snowFindings').querySelectorAll('.snow-finding')].map(e => e.dataset.code);
  const overCodes = [...$('snowOverridden').querySelectorAll('.snow-finding')].map(e => e.dataset.code);
  return {
    raw, model, codes, overCodes,
    copy: !$('snowCopyBtn').disabled, load: !$('snowLoadBtn').disabled, save: !$('snowSaveBtn').disabled,
    bestEffortVisible: $('snowBestEffortRow').style.display !== 'none',
    dbRowVisible: $('snowDbSchemaRow').style.display !== 'none',
  };
}
const stripName = (m) => { const { name, ...rest } = m; return rest; };
const metricNames = (m) => (m.pages || []).flatMap(p => p.elements || []).flatMap(e => (e.metrics || []).map(x => x.name));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. Golden fixtures ──────────────────────────────────────────────────────
const goldens = readdirSync(GOLD).filter(f => f.endsWith('.json')).sort();
check('found upstream goldens', goldens.length >= 12, String(goldens.length));
for (const g of goldens) {
  const base = g.replace(/\.json$/, '');
  const src = readFileSync(join(FIX, base + '.sql'), 'utf8');
  const golden = JSON.parse(readFileSync(join(GOLD, g), 'utf8'));
  // 12 needs db/schema only when absent; here supply both for the golden comparison.
  const r = convert(src, { db: 'ANALYTICS', schema: 'MODELS', conn: '' + CONN });
  let goldenCase = r.model && sameJson(stripName(r.model), golden);
  if (base === '02-star-schema' && r.model) {
    // The panel uses the default crossTableReferences:'derived': the golden's one cross-table column
    // (orders.customer_name) moves to orders__joined; every other element equals the golden.
    const els = r.model.pages[0].elements;
    const orders = els.find(e => e.id === 'orders');
    const joined = els.find(e => e.id === 'orders__joined');
    const gEls = golden.pages[0].elements;
    const rest = (list) => JSON.stringify(list.filter(e => e.id !== 'orders' && e.id !== 'orders__joined' && e.id !== 'lineitem'));
    // lineitem's relationship into orders is retargeted at the derived element (so related tables reach the moved column); nothing else on it changes.
    const li = els.find(e => e.id === 'lineitem');
    const gLi = gEls.find(e => e.id === 'lineitem');
    const liOk = !!li && li.relationships[0].targetElementId === 'orders__joined'
      && JSON.stringify({ ...li, relationships: [{ ...li.relationships[0], targetElementId: 'orders' }, ...li.relationships.slice(1)] }) === JSON.stringify(gLi);
    const cn = joined && joined.columns.find(c => c.id === 'orders__customer_name');
    goldenCase = !!orders && !!joined && liOk && rest(els) === rest(gEls)
      && joined.name === 'ORDERS (joined)'
      && joined.source.elementId === 'orders'
      && !/\[[^\]\/]+\/[^\]\/]+\/[^\]\/]+\]/.test(JSON.stringify(orders))
      && !!cn && cn.formula === '[ORDERS/Orders To Customer/C Name]'
      && els.length === gEls.length + 1
      && r.codes.includes('CROSS_TABLE_REFERENCES_MOVED');
  }
  check(`golden ${base}: panel output equals upstream golden${base === '02-star-schema' ? ' (fixed shape: cross-table column on orders__joined)' : ''}`, !!goldenCase,
    r.model ? 'differs' : 'no model; codes=' + r.codes.join(','));
  check(`golden ${base}: Copy/Load/Save enabled`, r.copy && r.load && r.save);
  if (r.model) check(`golden ${base}: model has top-level name`, typeof r.model.name === 'string' && r.model.name.length > 0);
}

// ── 2. Refusals ─────────────────────────────────────────────────────────────
const refusals = { '03-non-additive-metric': 'SEMI_ADDITIVE_METRIC', '04-asof-relationship': null, '06-range-join': null, '07-window-metric': null, '11-tables-only': 'MISSING_DIMENSIONS_OR_METRICS' };
for (const [base, expectCode] of Object.entries(refusals)) {
  const r = convert(readFileSync(join(FIX, base + '.sql'), 'utf8'), { db: 'ANALYTICS', schema: 'MODELS' });
  check(`refusal ${base}: no spec, output is a comment`, r.model === null && r.raw.startsWith('//'));
  check(`refusal ${base}: Copy/Load/Save disabled`, !r.copy && !r.load && !r.save);
  const errCodes = r.codes.filter(c => c !== 'COLUMN_TYPES_SKIPPED');
  check(`refusal ${base}: error finding(s) shown`, errCodes.length > 0, r.codes.join(','));
  if (expectCode) check(`refusal ${base}: shows ${expectCode}`, r.codes.includes(expectCode), r.codes.join(','));
}
{
  let r = convert(readFileSync(join(FIX, '03-non-additive-metric.sql'), 'utf8'), { db: 'ANALYTICS', schema: 'MODELS' });
  check('03: best-effort button visible', r.bestEffortVisible);
  $('snowBestEffortBtn').click();
  r = read();
  check('03: Convert anyway -> ok spec', !!r.model && r.copy && r.load && r.save);
  check('03: overridden finding shown prominently', r.overCodes.includes('SEMI_ADDITIVE_METRIC') && $('snowOverridden').style.display !== 'none',
    r.overCodes.join(','));
  check('03: best-effort button hidden after success', !r.bestEffortVisible);
  r = convert(readFileSync(join(FIX, '11-tables-only.sql'), 'utf8'), { db: 'ANALYTICS', schema: 'MODELS' });
  check('11: no best-effort button', !r.bestEffortVisible);
}

// ── 3. Fixture 12: needs database/schema ────────────────────────────────────
{
  const src12 = readFileSync(join(FIX, '12-unqualified-names.sql'), 'utf8');
  let r = convert(src12);
  check('12 without db/schema: refused', r.model === null && !r.save);
  check('12: NEEDS_DATABASE and NEEDS_SCHEMA findings', r.codes.includes('NEEDS_DATABASE') && r.codes.includes('NEEDS_SCHEMA'), r.codes.join(','));
  check('12: Database/Schema inputs revealed + highlighted', r.dbRowVisible && $('snowDatabase').style.borderColor !== '' && $('snowSchema').style.borderColor !== '');
  // fill in then re-run
  convert(src12);
  $('snowDatabase').value = 'ANALYTICS'; $('snowSchema').value = 'MODELS';
  window.runSnowConversion();
  r = read();
  check('12 after filling db/schema: equals golden',
    !!r.model && sameJson(stripName(r.model), JSON.parse(readFileSync(join(GOLD, '12-unqualified-names.json'), 'utf8'))));
  const h2 = convert(readFileSync(join(FIX, '01-single-table.sql'), 'utf8'), { db: 'ANALYTICS', schema: 'MODELS' });
  check('fully qualified view: Database/Schema row stays hidden', !h2.dbRowVisible);
  convert(src12);
  $('snowYamlInput').value = readFileSync(join(FIX, '01-single-table.sql'), 'utf8');
  window.runSnowConversion();
  check('switching from unqualified to qualified view hides Database/Schema row', !read().dbRowVisible);
  $('snowYamlInput').value = '';
  window.runSnowConversion();
  check('empty conversion hides Database/Schema row', !read().dbRowVisible);
}

// ── 3b. Warehouse references use Sigma's small-word casing ─────────────────
{
  const yaml = `name: CALENDAR
tables:
  - name: dates
    base_table: { database: ANALYTICS, schema: MODELS, table: DATES }
    dimensions:
      - { name: day_of_week, expr: day_of_week }
    metrics:
      - { name: days_to_date, expr: COUNT(day_of_week) }
`;
  const r = convert(yaml);
  const formulas = r.model
    ? r.model.pages.flatMap(p => p.elements).flatMap(e =>
        [...(e.columns || []), ...(e.metrics || [])].map(item => item.formula))
    : [];
  check('warehouse refs lowercase Sigma small words', formulas.includes('[DATES/Day of Week]') && formulas.includes('Count([Day of Week])'), formulas.join('|'));
  check('warehouse refs do not retain title-cased small words', !formulas.some(f => /Day Of Week/.test(f)), formulas.join('|'));
}

// ── 4. PLUGS: nothing invented ──────────────────────────────────────────────
{
  const r = convert(readFileSync(PLUGS, 'utf8'));
  const names = r.model ? metricNames(r.model).sort() : [];
  check('PLUGS converts', !!r.model, r.codes.join(','));
  check('PLUGS metrics are exactly Profit, Profit Margin, Revenue', sameJson(names, ['Profit', 'Profit Margin', 'Revenue']), names.join('|'));
  const stats = $('snowOutputStats').textContent;
  check('PLUGS stats badges show 3 metrics', /3 metrics/.test(stats) && /columns/.test(stats), stats);
  check('PLUGS has no #snowAutoMetrics control', !$('snowAutoMetrics'));
}

// ── 5. Options ──────────────────────────────────────────────────────────────
{
  const plugs = readFileSync(PLUGS, 'utf8');
  reset(); $('snowYamlInput').value = plugs; window.runSnowConversion();
  const off = read();
  check('synonyms off by default: no "Also known as:"', off.model && !off.raw.includes('Also known as:'));
  check('synonyms off: SYNONYMS_DROPPED reported', off.codes.includes('SYNONYMS_DROPPED'), off.codes.join(','));
  $('snowSynonyms').checked = true; window.runSnowConversion();
  const syn = read();
  check('synonyms checkbox: descriptions contain "Also known as:"', syn.raw.includes('Also known as:'));
  check('synonyms checkbox: SYNONYMS_DROPPED gone', !syn.codes.includes('SYNONYMS_DROPPED'));
  $('snowSynonyms').checked = false; $('snowNumberFormats').checked = true; window.runSnowConversion();
  const nf = read();
  const cnt = (s) => (s.match(/"format"/g) || []).length;
  check('number formats checkbox adds formats', cnt(nf.raw) > cnt(off.raw), `${cnt(off.raw)} -> ${cnt(nf.raw)}`);
}
{
  const src = readFileSync(join(FIX, '01-single-table.sql'), 'utf8');
  let r = convert(src, { db: 'ANALYTICS', schema: 'MODELS' });
  check('no column types: COLUMN_TYPES_SKIPPED shown', r.codes.includes('COLUMN_TYPES_SKIPPED'));
  $('snowColumnTypes').value = '{"ANALYTICS.MODELS.T": {"C": "TIMESTAMP_TZ"}}';
  window.runSnowConversion(); r = read();
  check('valid column types: COLUMN_TYPES_SKIPPED gone, still ok', !r.codes.includes('COLUMN_TYPES_SKIPPED') && !!r.model, r.codes.join(','));
  $('snowColumnTypes').value = '{not json';
  window.runSnowConversion(); r = read();
  check('invalid column types JSON: inline error shown', /not valid JSON/.test($('snowColumnTypesError').textContent));
  check('invalid column types JSON: conversion still runs', !!r.model && r.codes.includes('COLUMN_TYPES_SKIPPED') && r.codes.includes('COLUMN_TYPES_INVALID'), r.codes.join(','));
  $('snowColumnTypes').value = '{"T": "TIMESTAMP_TZ"}';
  window.runSnowConversion(); r = read();
  check('wrong-shaped column types: rejected, conversion still runs', !!r.model && /must map column names/.test($('snowColumnTypesError').textContent));
  const sql = $('snowColumnTypesSql').textContent;
  check('column-types SQL present (OBJECT_AGG / INFORMATION_SCHEMA / TIMESTAMP_TZ)', /OBJECT_AGG/.test(sql) && /INFORMATION_SCHEMA\.COLUMNS/.test(sql) && /ILIKE 'TIMESTAMP_TZ%'/.test(sql));
  $('snowDatabase').value = 'MYDB'; $('snowSchema').value = 'MYSCH';
  $('snowDatabase').dispatchEvent(new window.Event('input'));
  check('column-types SQL parameterised by database/schema', /MYDB\.INFORMATION_SCHEMA/.test($('snowColumnTypesSql').textContent) && /MYSCH/.test($('snowColumnTypesSql').textContent));
}
{
  const src = readFileSync(join(FIX, '01-single-table.sql'), 'utf8');
  let r = convert(src, { db: 'ANALYTICS', schema: 'MODELS', conn: '' });
  check('empty connection: placeholder in spec', r.raw.includes('<CONNECTION_ID>'));
  check('empty connection: "Connection ID not set" warning', r.codes.includes('CONNECTION_NOT_SET') && /Connection ID not set/.test($('snowFindings').textContent));
  reset(); setConn(CONN);
  window.eval(`wizardState.connections = [{ connectionId: '${CONN}', friendlyName: false }]`);
  $('snowYamlInput').value = src; $('snowDatabase').value = 'ANALYTICS'; $('snowSchema').value = 'MODELS';
  window.runSnowConversion(); r = read();
  check('friendly names off: FRIENDLY_NAMES_OFF warning, not blocked', r.codes.includes('FRIENDLY_NAMES_OFF') && !!r.model && r.save);
  window.eval(`wizardState.connections = [{ connectionId: '${CONN}', friendlyName: true }]`);
  window.runSnowConversion(); r = read();
  check('friendly names on: no FRIENDLY_NAMES_OFF', !r.codes.includes('FRIENDLY_NAMES_OFF'));
  window.eval('wizardState.connections = []');
}

// ── 6. Multiple files + picker ──────────────────────────────────────────────
{
  reset();
  const f1 = { name: 'one.sql', size: 10, text: async () => readFileSync(join(FIX, '01-single-table.sql'), 'utf8') };
  const f2 = { name: 'two.sql', size: 10, text: async () => readFileSync(join(FIX, '02-star-schema.sql'), 'utf8') };
  const f3 = { name: 'three.sql', size: 10, text: async () => readFileSync(join(FIX, '03-non-additive-metric.sql'), 'utf8') };
  $('snowDatabase').value = 'ANALYTICS'; $('snowSchema').value = 'MODELS';
  await window.loadSnowFiles([f1, f2, f3]);
  const picker = $('snowViewPicker');
  check('two+ files: picker visible with 3 views', picker.style.display !== 'none' && picker.options.length === 3, String(picker.options.length));
  check('picker labels include file names + refused marker', [...picker.options].some(o => /two\.sql/.test(o.textContent)) && [...picker.options].some(o => /\(refused\)/.test(o.textContent)));
  check('file list shows 3 rows', $('snowFileList').children.length === 3);
  const firstOut = $('snowJsonOutput').value;
  const keys = [...picker.options].map(o => o.value);
  const outs = keys.map(k => { picker.value = k; picker.dispatchEvent(new window.Event('change')); return read(); });
  check('selecting a view switches output', outs[0].model && outs[1].model && outs[0].raw !== outs[1].raw);
  check('selecting the refused view disables buttons', outs[2].model === null && !outs[2].save);
  check('selecting an ok view re-enables buttons', (() => { picker.value = keys[1]; picker.dispatchEvent(new window.Event('change')); return read().save; })());
  void firstOut;
  // single file goes to the textarea
  reset();
  await window.loadSnowFiles([f1]);
  check('single file: text placed in textarea, picker hidden', $('snowYamlInput').value.includes('SEMANTIC VIEW') && $('snowViewPicker').style.display === 'none');
  // pasting after multi-file clears files
  await window.loadSnowFiles([f1, f2]);
  $('snowYamlInput').value = readFileSync(join(FIX, '01-single-table.sql'), 'utf8');
  $('snowYamlInput').dispatchEvent(new window.Event('input'));
  window.runSnowConversion();
  check('typing in textarea drops multi-file sources', $('snowViewPicker').style.display === 'none');
  // multiple views in ONE file
  reset();
  const two = readFileSync(join(FIX, '01-single-table.sql'), 'utf8') + '\n;\n' + readFileSync(join(FIX, '02-star-schema.sql'), 'utf8');
  $('snowDatabase').value = 'ANALYTICS'; $('snowSchema').value = 'MODELS';
  $('snowYamlInput').value = two; window.runSnowConversion();
  check('one file with two statements: picker shows 2 views', $('snowViewPicker').options.length === 2, String($('snowViewPicker').options.length));
}

// ── 6b. Review #5/#7: best-effort scoping, empty input, file-read failures, YAML overridden box ──
const YAML_SEMI = `name: INV
tables:
  - name: inventory
    base_table: { database: D, schema: S, table: PARTSUPP }
    dimensions:
      - { name: ps_partkey, expr: ps_partkey }
    facts:
      - { name: ps_availqty, expr: ps_availqty }
    metrics:
      - name: closing_stock
        expr: SUM(ps_availqty)
        non_additive_dimensions: [ { dimension: ps_partkey } ]
`;
{
  // #5: YAML best-effort refusal: the overridden box shows the message and the main list does not repeat the code as an error
  let r = convert(YAML_SEMI, { db: 'D', schema: 'S' });
  check('yaml SEMI_ADDITIVE: refused, best-effort offered', r.model === null && r.bestEffortVisible && r.codes.includes('SEMI_ADDITIVE_METRIC'), r.codes.join(','));
  $('snowBestEffortBtn').click();
  r = read();
  check('yaml best effort: converts', !!r.model && r.save);
  const overTxt = $('snowOverridden').textContent;
  check('yaml best effort: overridden box lists SEMI_ADDITIVE_METRIC with its message', r.overCodes.includes('SEMI_ADDITIVE_METRIC') && /closing_stock|Closing Stock/i.test(overTxt) && overTxt.replace(/\s+/g, ' ').length > 120, overTxt.slice(0, 200));
  check('yaml best effort: the code is NOT also an error in the main list', !r.codes.includes('SEMI_ADDITIVE_METRIC'), r.codes.join(','));
}
{
  // #5 (DMM half): the overridden-vs-findings match must not depend on `line`: stub an engine whose overriddenErrors say line 1 and findings say none.
  window.eval(`var __realST = SemanticTools; SemanticTools = Object.assign({}, __realST, { convertSemanticView: function (t, o) {
    var run = __realST.convertSemanticView(t, o);
    run.results.forEach(function (v) { v.overriddenErrors = v.overriddenErrors.map(function (e) { return Object.assign({}, e, { line: 1 }); }); v.findings = v.findings.map(function (f) { var c = Object.assign({}, f); delete c.line; return c; }); });
    return run; } });`);
  try {
    convert(YAML_SEMI, { db: 'D', schema: 'S' });
    $('snowBestEffortBtn').click();
    const r = read();
    check('overridden match ignores line: box shows it, main list does not repeat it', r.overCodes.includes('SEMI_ADDITIVE_METRIC') && !r.codes.includes('SEMI_ADDITIVE_METRIC') && $('snowOverridden').textContent.length > 120, r.codes.join(',') + ' | ' + $('snowOverridden').textContent.slice(0, 100));
  } finally { window.eval('SemanticTools = __realST'); }
}
{
  // #7c: best effort applies ONLY to the selected view
  reset();
  const f3 = { name: 'three.sql', size: 10, text: async () => readFileSync(join(FIX, '03-non-additive-metric.sql'), 'utf8') };
  const fy = { name: 'inv.yaml', size: 10, text: async () => YAML_SEMI };
  $('snowDatabase').value = 'ANALYTICS'; $('snowSchema').value = 'MODELS';
  await window.loadSnowFiles([f3, fy]);
  const picker = $('snowViewPicker');
  const keys = [...picker.options].map(o => o.value);
  const state = () => keys.map(k => { picker.value = k; picker.dispatchEvent(new window.Event('change')); return !!read().model; });
  check('best-effort scope: both views refused at first', sameJson(state(), [false, false]), JSON.stringify(state()));
  picker.value = keys[1]; picker.dispatchEvent(new window.Event('change'));
  check('best-effort scope: best-effort button shown for the selected refused view', read().bestEffortVisible);
  $('snowBestEffortBtn').click();
  check('best-effort scope: ONLY the selected view converted', sameJson(state(), [false, true]), JSON.stringify(state()));
  picker.value = keys[0]; picker.dispatchEvent(new window.Event('change'));
  $('snowBestEffortBtn').click();
  check('best-effort scope: second click converts the other, first stays converted', sameJson(state(), [true, true]), JSON.stringify(state()));
  window.runSnowConversion();
  check('plain Convert after best effort goes back to strict for every view', sameJson(state(), [false, false]), JSON.stringify(state()));
}
{
  // #7c (same file): two refused views in ONE source; best effort on the selected one leaves the other refused
  reset();
  const d3 = readFileSync(join(FIX, '03-non-additive-metric.sql'), 'utf8');
  const d3b = d3.replace(/(SEMANTIC VIEW\s+)(\S+)/i, '$1$2_B');
  check('same-file setup: second statement is a distinct view', d3b !== d3);
  $('snowDatabase').value = 'ANALYTICS'; $('snowSchema').value = 'MODELS';
  $('snowYamlInput').value = d3 + '\n;\n' + d3b;
  window.runSnowConversion();
  const picker = $('snowViewPicker');
  const keys = [...picker.options].map(o => o.value);
  const state = () => keys.map(k => { picker.value = k; picker.dispatchEvent(new window.Event('change')); return !!read().model; });
  check('same-file: two views, both refused', keys.length === 2 && sameJson(state(), [false, false]), JSON.stringify(state()));
  picker.value = keys[1]; picker.dispatchEvent(new window.Event('change'));
  $('snowBestEffortBtn').click();
  check('same-file: best effort converts only the selected view of the source', sameJson(state(), [false, true]), JSON.stringify(state()));
}
{
  // #7a: empty input clears the previous output
  convert(readFileSync(join(FIX, '01-single-table.sql'), 'utf8'), { db: 'ANALYTICS', schema: 'MODELS' });
  check('empty input setup: something was converted', !!read().model && $('snowOutputStats').textContent !== '');
  $('snowYamlInput').value = '   ';
  window.runSnowConversion();
  const r = read();
  check('empty input: output cleared', $('snowJsonOutput').value === '', $('snowJsonOutput').value.slice(0, 40));
  check('empty input: findings and stats cleared', $('snowFindings').textContent === '' && $('snowOutputStats').textContent === '' && $('snowOverridden').textContent === '');
  check('empty input: Copy/Load/Save disabled, best-effort hidden', !r.copy && !r.load && !r.save && !r.bestEffortVisible);
}
{
  // #7b: file read failure -> toast + finding, no unhandled rejection; awaited
  reset();
  let unhandled = null;
  const onRej = (e) => { unhandled = e; };
  process.on('unhandledRejection', onRej);
  const bad = { name: 'bad.sql', size: 1, text: async () => { throw new Error('boom read'); } };
  const good = { name: 'good.sql', size: 1, text: async () => readFileSync(join(FIX, '01-single-table.sql'), 'utf8') };
  $('snowDatabase').value = 'ANALYTICS'; $('snowSchema').value = 'MODELS';
  let threw = null;
  try { await window.loadSnowFiles([bad]); } catch (e) { threw = e; }
  check('file read failure (all files): loadSnowFiles does not reject', !threw, threw && threw.message);
  check('file read failure: finding shown with file name and message', /bad\.sql/.test($('snowFindings').textContent) && /boom read/.test($('snowFindings').textContent), $('snowFindings').textContent);
  check('file read failure: nothing to copy', !read().copy);
  try { await window.loadSnowFiles([bad, good]); } catch (e) { threw = e; }
  check('file read failure (partial): good file still converts, failure still reported', !threw && !!read().model && /boom read/.test($('snowFindings').textContent), $('snowFindings').textContent);
  // drop + upload handlers return promises that settle
  const dropEv = { preventDefault() {}, currentTarget: { classList: { remove() {} } }, dataTransfer: { files: [bad] } };
  const pr = window.handleSnowFileDrop(dropEv);
  check('drop handler returns a promise (awaited loadSnowFiles)', pr && typeof pr.then === 'function');
  try { await pr; } catch (e) { threw = e; }
  await new Promise(r => setTimeout(r, 20));
  process.off('unhandledRejection', onRej);
  check('no unhandled rejection from file loading', !unhandled && !threw, unhandled && String(unhandled));
}

// ── 7. XSS: source-derived text is rendered as text ─────────────────────────
{
  const evil = '<img src=x onerror=alert(1)>';
  const yaml = `name: "${evil}"
description: "${evil}"
"${evil}": 1
tables:
  - name: T1
    base_table: { database: D, schema: S, table: T1 }
    dimensions:
      - name: "${evil}"
        description: "${evil}"
        expr: A
        data_type: VARCHAR(10)
    metrics:
      - name: M1
        expr: SUM(A)
`;
  const r = convert(yaml);
  const panel = $('subPanelSnow');
  const bad = [...panel.querySelectorAll('img')];
  check('XSS: no <img> element anywhere in the Snowflake panel', bad.length === 0, String(bad.length));
  check('XSS: findings/stats/picker contain the text literally',
    ($('snowFindings').textContent + $('snowViewPicker').textContent).includes(evil), r.codes.join(','));
  check('XSS: no alert fired', !alertCalled);
  check('XSS: converted ok (payload is data, not code)', !!r.model || r.codes.length > 0);
  // file name with markup
  reset();
  await window.loadSnowFiles([{ name: `a${evil}.sql`, size: 1, text: async () => readFileSync(join(FIX, '01-single-table.sql'), 'utf8') }]);
  check('XSS: hostile file name rendered as text', !$('snowFileList').querySelector('img') && $('snowFileList').textContent.includes('<img'));
}

// ── 8. Load into Editor ─────────────────────────────────────────────────────
{
  const r = convert(readFileSync(join(FIX, '02-star-schema.sql'), 'utf8'), { db: 'ANALYTICS', schema: 'MODELS' });
  let threw = null;
  try { window.loadSnowOutputToEditor(); } catch (e) { threw = e; }
  check('Load into Editor: no exception', !threw, threw && threw.message);
  const st = window.eval('state');
  check('Load into Editor: state.isNewModel set, nothing selected', st.isNewModel === true && st.selectedModel === null);
  let edited = null;
  try { edited = JSON.parse($('jsonEditor').value); } catch (_) {}
  check('Load into Editor: editor holds the converted spec', !!edited && edited.name === r.model.name && Array.isArray(edited.pages) && edited.schemaVersion === r.model.schemaVersion);
  check('Load into Editor: title updated', /Snowflake Semantic View/.test($('editorTitle').textContent));
}

// ── 9. Example + wiring ─────────────────────────────────────────────────────
{
  reset();
  window.loadSnowExample();
  window.runSnowConversion();
  const r = read();
  const mets = r.model ? metricNames(r.model) : [];
  check('example converts ok with >= 1 metric', !!r.model && mets.length >= 1, r.codes.join(',') + ' ' + r.raw.slice(0, 80));
  check('example converts without error-severity findings', ![...$('snowFindings').querySelectorAll('.snow-finding')].some(e => e.textContent.startsWith('⛔')));
  check('upload input accepts .sql,.ddl,.yml,.yaml and multiple', $('snowYamlUpload').getAttribute('accept') === '.sql,.ddl,.yml,.yaml' && $('snowYamlUpload').multiple);
  check('removed legacy helpers', !('snowIsIndicator' in window) && !('snowConvertTable' in window) && !('snowBuildDesc' in window));
  check('engine global present', typeof window.SemanticTools === 'object' && typeof window.SemanticTools.ENGINE.semanticToolsCommit === 'string');
  const help = window.eval('HELP_CONTENT.snow');
  check('HELP_CONTENT.snow updated (engine, DDL, best effort, column types)', /semantic-tools/.test(help) && /GET_DDL/.test(help) && /best effort/i.test(help) && /TIMESTAMP_TZ/.test(help) && /Sum\(\)/.test(help));
}

// ── 10. Sync script --check ─────────────────────────────────────────────────
if (!process.env.SMM_INDEX_PATH && existsSync(join(MCP, 'vendor/semantic-tools/PROVENANCE.json'))) {
  const res = spawnSync('node', [join(__dirname, '..', 'scripts/sync-semantic-tools.mjs'), MCP, '--check'], { encoding: 'utf8' });
  check('sync-semantic-tools --check passes', res.status === 0, (res.stderr || '').trim());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
