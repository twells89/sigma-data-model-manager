/**
 * Databricks metric view converter tests (browser surface) — bundled DbxMetricView engine.
 *
 * Drives the real panel (#dbxYamlInput / #dbxConnectionId / ... / #dbxJsonOutput) in JSDOM:
 *   1. demo_complex YAML + connection -> parseable spec, schemaVersion 1, TIME_ZONE_DEPENDENT findings shown,
 *      Copy / Load / Save enabled, every numeric metric formatted by default; "Infer number formats" off -> explicit formats only.
 *   2. A synthetic `window:` measure -> WINDOW_MEASURE_REFUSED shown, refused measure listed, the SUM metric still converted,
 *      no best-effort button.
 *   3. f_sales + d_customer dropped together -> both converted (dependency order handled by the engine); picker; file list.
 *   4. `source: orders` -> catalog / schema inputs revealed; filling them converts; row hidden for qualified sources.
 *   5. Unity Catalog table JSON (with full_name) pasted as is; several documents pasted together (`---`).
 *   6. Empty connection placeholder + warning, friendly-names-off warning, empty input clears everything.
 *   7. XSS: hostile finding / file text renders as text only.
 *   8. Load into Editor, picker, example, wiring (tab lists, help tab, connection dropdown lists).
 *   9. Sync script --check.
 *
 * Run: node test/databricks-metric-view.jsdom.test.mjs
 * Env: SMM_INDEX_PATH (alternate index.html, used for mutation checks),
 *      MCP_REPO (sigma-data-model-mcp checkout, default ~/sigma-data-model-mcp-dbx),
 *      DBX_FIXTURES (metric view YAML fixtures, default <MCP_REPO>/test-fixtures/databricks).
 * jsdom resolves via createRequire from this directory (same as the other jsdom tests).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, 'x.mjs'));
const { JSDOM, VirtualConsole } = require('jsdom');

const INDEX_HTML = process.env.SMM_INDEX_PATH || join(__dirname, '..', 'index.html');
const MCP = process.env.MCP_REPO || '/Users/tjwells/sigma-data-model-mcp-dbx';
const FIX = process.env.DBX_FIXTURES || join(MCP, 'test-fixtures', 'databricks');
const CONN = '7d66cb14-5a6b-4897-98cc-5dff96b0a89a';
const fx = (name) => readFileSync(join(FIX, name + '.yaml'), 'utf8');
const DEMO = 'customer_success.sigma_demo.demo_complex_metric_view';
const F_SALES = 'customer_success.examples__plugs_electronics_mv.f_sales_metric_view';
const D_CUSTOMER = 'customer_success.examples__plugs_electronics_mv.d_customer_metric_view';

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
  const sel = $('dbxConnectionId');
  if (id && ![...sel.options].some(o => o.value === id)) {
    const o = doc.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o);
  }
  sel.value = id || '';
}

// Read before any reset(): the number-format checkbox is on at page load (a user requirement: every metric gets a format).
check('"Infer number formats" is checked by default (page load)', !!$('dbxNumberFormats') && $('dbxNumberFormats').checked === true);
check('best-effort row hidden at page load', !!$('dbxBestEffortRow') && $('dbxBestEffortRow').style.display === 'none');
check('catalog / schema row hidden at page load', !!$('dbxCatalog') && $('dbxCatalogSchemaRow').style.display === 'none');

function reset() {
  window.dbxClearFiles();
  $('dbxYamlInput').value = '';
  $('dbxCatalog').value = '';
  $('dbxSchema').value = '';
  $('dbxNumberFormats').checked = true;
  $('dbxCatalogSchemaRow').style.display = 'none';
  setConn(CONN);
  window.eval('wizardState.connections = []');
}

function read() {
  const raw = $('dbxJsonOutput').value;
  let model = null;
  if (raw && !raw.startsWith('//')) { try { model = JSON.parse(raw); } catch (_) {} }
  const nodes = [...$('dbxFindings').querySelectorAll('.dbx-finding')];
  return {
    raw, model,
    codes: nodes.map(e => e.dataset.code),
    findingText: $('dbxFindings').textContent,
    summary: $('dbxSummary').textContent,
    copy: !$('dbxCopyBtn').disabled, load: !$('dbxLoadBtn').disabled, save: !$('dbxSaveBtn').disabled,
    bestEffortVisible: $('dbxBestEffortRow').style.display !== 'none',
    catRowVisible: $('dbxCatalogSchemaRow').style.display !== 'none',
  };
}
function convert(text, { conn = CONN, catalog = '', schema = '' } = {}) {
  reset();
  setConn(conn);
  $('dbxYamlInput').value = text;
  $('dbxCatalog').value = catalog;
  $('dbxSchema').value = schema;
  window.runDbxConversion();
  return read();
}
const allMetrics = (m) => (m.pages || []).flatMap(p => p.elements || []).flatMap(e => e.metrics || []);
const metricNames = (m) => allMetrics(m).map(x => x.name);
const file = (name, text) => ({ name, size: text.length, text: async () => text });

// ── 1. demo_complex ─────────────────────────────────────────────────────────
{
  const r = convert(fx(DEMO));
  check('demo_complex: output parses with schemaVersion 1', !!r.model && r.model.schemaVersion === 1, r.raw.slice(0, 80));
  check('demo_complex: model has a name and pages', !!r.model && typeof r.model.name === 'string' && r.model.name.length > 0 && Array.isArray(r.model.pages));
  check('demo_complex: connection id is in the spec, no placeholder', r.raw.includes(CONN) && !r.raw.includes('<CONNECTION_ID>'));
  check('demo_complex: TIME_ZONE_DEPENDENT findings listed', r.codes.includes('TIME_ZONE_DEPENDENT'), r.codes.join(','));
  check('demo_complex: finding rows show severity icon, code, object name and message',
    /⚠️/.test(r.findingText) && /TIME_ZONE_DEPENDENT/.test(r.findingText) && /DEMO_ROLLING_4_WEEK_MEASURE/.test(r.findingText) && r.findingText.length > 400);
  check('demo_complex: no CONNECTION_NOT_SET finding', !r.codes.includes('CONNECTION_NOT_SET'));
  check('demo_complex: Copy / Load / Save enabled', r.copy && r.load && r.save);
  check('demo_complex: 14 metrics; best-effort hidden', r.model && metricNames(r.model).length === 14 && !r.bestEffortVisible, r.model && String(metricNames(r.model).length));
  const sum = r.model && allMetrics(r.model).find(m => m.name === 'Demo Sum Measure');
  check('demo_complex: SUM metric has a number format by default', !!sum && !!sum.format && sum.format.kind === 'number', JSON.stringify(sum));
  const formatted = r.model ? allMetrics(r.model).filter(m => m.format).length : 0;
  check('demo_complex: most metrics formatted by default', formatted >= 12, String(formatted));
  check('demo_complex: stats badges', /14 metrics/.test($('dbxOutputStats').textContent) && /relationship/.test($('dbxOutputStats').textContent), $('dbxOutputStats').textContent);

  // Infer number formats unchecked -> explicit `format:` only
  $('dbxNumberFormats').checked = false;
  window.runDbxConversion();
  const off = read();
  const offSum = off.model && allMetrics(off.model).find(m => m.name === 'Demo Sum Measure');
  const offFormatted = off.model ? allMetrics(off.model).filter(m => m.format).length : 0;
  check('infer number formats OFF: SUM metric loses its inferred format', !!offSum && !offSum.format, JSON.stringify(offSum));
  check('infer number formats OFF: fewer formatted metrics than ON', offFormatted < formatted, `${formatted} -> ${offFormatted}`);
  $('dbxNumberFormats').checked = true;
  window.runDbxConversion();
  check('infer number formats ON again: format is back', !!(read().model && allMetrics(read().model).find(m => m.name === 'Demo Sum Measure').format));
}

// ── 2. window measure: refused; everything else converts ───────────────────
const WINDOW_YAML = `version: 1.1
source: main.sales.orders
dimensions:
  - name: order_date
    expr: order_date
measures:
  - name: total_revenue
    expr: SUM(amount)
  - name: trailing_7d_revenue
    expr: SUM(amount)
    window:
      - order: order_date
        range: trailing 7 day
`;
{
  const r = convert(WINDOW_YAML);
  check('window measure: WINDOW_MEASURE_REFUSED finding shown', r.codes.includes('WINDOW_MEASURE_REFUSED'), r.codes.join(','));
  check('window measure: the SUM metric still converts', !!r.model && metricNames(r.model).join('|') === 'Total Revenue', r.model ? metricNames(r.model).join('|') : r.raw.slice(0, 100));
  check('window measure: no window metric emitted', !!r.model && !/trailing/i.test(r.raw));
  check('window measure: refused measure listed in the summary by name', /Refused measures/i.test(r.summary) && /trailing_7d_revenue/.test(r.summary), r.summary);
  check('window measure: finding row is error severity and names the measure', /⛔/.test(r.findingText) && /trailing_7d_revenue/.test(r.findingText));
  check('window measure: no best-effort button (window is always refused)', !r.bestEffortVisible && $('dbxBestEffort') && $('dbxBestEffortRow').style.display === 'none');
  check('window measure: view itself is usable (Copy / Load / Save enabled)', r.copy && r.load && r.save);
}
{
  // Only a window measure: view converts with zero metrics or is refused — either way the finding is shown and the UI stays sane.
  const only = WINDOW_YAML.replace(/  - name: total_revenue\n    expr: SUM\(amount\)\n/, '');
  const r = convert(only);
  check('only-window view: finding shown, no best-effort', r.codes.includes('WINDOW_MEASURE_REFUSED') && !r.bestEffortVisible, r.codes.join(','));
  check('only-window view: converts with zero metrics (model present, "0 metrics" badge, Save enabled)', !!r.model && metricNames(r.model).length === 0 && /0 metrics/.test($('dbxOutputStats').textContent) && r.save, $('dbxOutputStats').textContent);
  check('only-window view: summary does not claim other measures converted', /Refused measures/.test(r.summary) && /No measure converted, so the model has no metrics/.test(r.summary) && !/every other/i.test(r.summary), r.summary);
  check('window + SUM view: summary says how many other measures converted', /The other 1 measure converted/.test(convert(WINDOW_YAML).summary));
}

// ── 3. several files together ───────────────────────────────────────────────
{
  reset();
  setConn(CONN);
  await window.loadDbxFiles([file(F_SALES + '.yaml', fx(F_SALES)), file(D_CUSTOMER + '.yaml', fx(D_CUSTOMER))]);
  const picker = $('dbxViewPicker');
  check('two files: picker visible with 2 views', picker.style.display !== 'none' && picker.options.length === 2, String(picker.options.length));
  check('two files: picker labels use the full UC names (name derived from the file name)',
    [...picker.options].some(o => o.textContent.includes(F_SALES)) && [...picker.options].some(o => o.textContent.includes(D_CUSTOMER)), [...picker.options].map(o => o.textContent).join(' | '));
  check('two files: file list shows 2 rows', $('dbxFileList').children.length === 2);
  const keys = [...picker.options].map(o => o.value);
  const outs = keys.map(k => { picker.value = k; picker.dispatchEvent(new window.Event('change')); return read(); });
  check('two files: both convert ok with Copy / Load / Save enabled', outs.every(o => o.model && o.copy && o.load && o.save), outs.map(o => !!o.model).join(','));
  check('two files: selecting a view switches the output', outs[0].raw !== outs[1].raw);
  const sales = outs.find(o => /F Sales/i.test(o.model.name));
  check('two files: model names come from the full UC names', !!sales && outs.some(o => /D Customer/i.test(o.model.name)), outs.map(o => o.model.name).join('|'));
  // f_sales joins d_customer_metric_view: supplied together it is a metric view, not an unknown (possibly-metric-view) warehouse table
  picker.value = keys[outs.indexOf(sales)]; picker.dispatchEvent(new window.Event('change'));
  check('two files: f_sales resolves its metric-view join (no POSSIBLE_METRIC_VIEW)', !read().codes.includes('POSSIBLE_METRIC_VIEW'), read().codes.join(','));
  reset();
  await window.loadDbxFiles([file(F_SALES + '.yaml', fx(F_SALES))]);
  check('f_sales alone: POSSIBLE_METRIC_VIEW warns that the joined metric view was not supplied', read().codes.includes('POSSIBLE_METRIC_VIEW'), read().codes.join(','));
  check('f_sales alone: model named from the dropped file (single file keeps its name)', /F Sales/i.test((read().model || {}).name || ''), (read().model || {}).name);
  // single dropped file goes to the textarea
  reset();
  await window.loadDbxFiles([file(D_CUSTOMER + '.yaml', fx(D_CUSTOMER))]);
  check('single file: text placed in the textarea, picker hidden, converted', $('dbxYamlInput').value.includes('d_customer') && $('dbxViewPicker').style.display === 'none' && !!read().model);
  // typing after a multi-file load drops the files
  await window.loadDbxFiles([file(F_SALES + '.yaml', fx(F_SALES)), file(D_CUSTOMER + '.yaml', fx(D_CUSTOMER))]);
  $('dbxYamlInput').value = fx(D_CUSTOMER);
  $('dbxYamlInput').dispatchEvent(new window.Event('input'));
  window.runDbxConversion();
  check('typing in the textarea drops multi-file sources', $('dbxViewPicker').style.display === 'none' && $('dbxFileList').children.length === 0);
}
{
  // file name -> view name rule: only names that look like catalog.schema.view get one
  const nm = window.dbxViewNameFromFile;
  check('file name rule: cat.schema.view.yaml -> cat.schema.view', nm('a.b.c.yaml') === 'a.b.c' && nm('a.b.c.yml') === 'a.b.c' && nm('a.b.c.json') === 'a.b.c');
  check('file name rule: other names get no view name', nm('orders.yaml') === undefined && nm('my metrics.yaml') === undefined && nm('a.b.yaml') === undefined && nm('a.b.c.d.yaml') === undefined, [nm('orders.yaml'), nm('a.b.yaml'), nm('a.b.c.d.yaml')].join(','));
}

// ── 3b. Fix round 1: unnamed sources ────────────────────────────────────────
{
  const unnamed = (n) => n === 'Metric View';
  const pick = (i) => { const p = $('dbxViewPicker'); p.value = [...p.options][i].value; p.dispatchEvent(new window.Event('change')); return read(); };
  const labels = () => [...$('dbxViewPicker').options].map(o => o.textContent);
  const typeFullName = (v) => { $('dbxFullName').value = v; $('dbxFullName').dispatchEvent(new window.Event('change')); return read(); };

  // (a) files not named catalog.schema.view: the MODEL is named after the file, the engine is not given a name
  reset(); setConn(CONN);
  await window.loadDbxFiles([file('d_customer.yaml', fx(D_CUSTOMER)), file('f_sales.yaml', fx(F_SALES))]);
  let dc = pick(0), fs_ = pick(1);
  check('unnamed files: models are named from the file names (D Customer / F Sales), not both "Metric View"',
    dc.model && fs_.model && dc.model.name === 'D Customer' && fs_.model.name === 'F Sales', `${dc.model && dc.model.name} | ${fs_.model && fs_.model.name}`);
  check('unnamed files: the two model names are distinct (no collision at save)', dc.model.name !== fs_.model.name);
  check('unnamed files: picker labels use the file names', labels().join('|') === 'D Customer|F Sales', labels().join('|'));
  check('unnamed files: dependency does NOT resolve (engine got no name): POSSIBLE_METRIC_VIEW on f_sales', fs_.codes.includes('POSSIBLE_METRIC_VIEW'), fs_.codes.join(','));
  check('unnamed files: Load into Editor carries the file-derived name', (() => { window.loadDbxOutputToEditor(); return JSON.parse($('jsonEditor').value).name === 'F Sales'; })());
  await window.loadDbxFiles([file('d_customer.yaml', fx(D_CUSTOMER))]);
  check('single unnamed file: model named from the file', read().model && read().model.name === 'D Customer', read().model && read().model.name);
  check('named file (catalog.schema.view.yaml) keeps the engine name', (await window.loadDbxFiles([file(D_CUSTOMER + '.yaml', fx(D_CUSTOMER))]), read().model.name === 'D Customer Metric View'), read().model && read().model.name);
  convert(fx(D_CUSTOMER));
  check('pasted YAML with no name stays "Metric View"', unnamed(read().model.name), read().model.name);

  // (b) full-name box
  reset(); setConn(CONN);
  await window.loadDbxFiles([file('d_customer.yaml', fx(D_CUSTOMER)), file('f_sales.yaml', fx(F_SALES))]);
  pick(0);
  check('full-name box shown for an unnamed view', $('dbxFullName').style.display !== 'none');
  const r1 = typeFullName(D_CUSTOMER);
  check('full name typed: view converts with the engine name (D Customer Metric View)', r1.model && r1.model.name === 'D Customer Metric View', r1.model && r1.model.name);
  check('full name typed: box stays visible and keeps its value after the rerun', $('dbxFullName').style.display !== 'none' && $('dbxFullName').value === D_CUSTOMER);
  check('full name typed: selection stays on the same view', $('dbxViewPicker').selectedIndex === 0);
  const f2 = pick(1);
  check('full name typed on d_customer: f_sales now resolves its join (no POSSIBLE_METRIC_VIEW)', f2.model && !f2.codes.includes('POSSIBLE_METRIC_VIEW'), f2.codes.join(','));
  check('f_sales (unnamed) is still named from its file', f2.model.name === 'F Sales', f2.model.name);
  check('full-name box shown for f_sales too (still unnamed)', $('dbxFullName').style.display !== 'none' && $('dbxFullName').value === '');
  pick(0);
  typeFullName('');
  check('clearing the full name returns to the file-derived name and the unresolved reference', read().model.name === 'D Customer' && pick(1).codes.includes('POSSIBLE_METRIC_VIEW'));
  // a full name must have exactly three parts: anything else gets an inline message and is not applied
  pick(0);
  for (const bad of ['d_customer', 'sch.d_customer', 'a.b.c.d', 'cat..view']) {
    const rb = typeFullName(bad);
    check(`invalid full name "${bad}": inline message shown, name not applied`,
      $('dbxFullNameMsg').style.display !== 'none' && /catalog\.schema\.view/.test($('dbxFullNameMsg').textContent) && rb.model && rb.model.name === 'D Customer', `${$('dbxFullNameMsg').textContent} | ${rb.model && rb.model.name}`);
  }
  typeFullName(D_CUSTOMER);
  check('valid full name: message hidden, name applied', $('dbxFullNameMsg').style.display === 'none' && read().model.name === 'D Customer Metric View');
  // an invalid entry typed AFTER a valid one must not leave the old valid name applied
  typeFullName(D_CUSTOMER);
  const stale = typeFullName('oops');
  check('invalid entry after a valid one: the old name is cleared (file-derived name again), message shown',
    stale.model && stale.model.name === 'D Customer' && $('dbxFullNameMsg').style.display !== 'none', stale.model && stale.model.name);
  check('invalid entry after a valid one: the dependent no longer resolves through the cleared name', pick(1).codes.includes('POSSIBLE_METRIC_VIEW'));
  pick(0);
  typeFullName('');
  check('empty full name: no message', $('dbxFullNameMsg').style.display === 'none');
  // hidden for views that already carry a name
  reset(); setConn(CONN);
  await window.loadDbxFiles([file(D_CUSTOMER + '.yaml', fx(D_CUSTOMER)), file(F_SALES + '.yaml', fx(F_SALES))]);
  pick(0);
  check('full-name box hidden for views named by their file name', $('dbxFullName').style.display === 'none');
  convert(JSON.stringify({ full_name: D_CUSTOMER, table_type: 'METRIC_VIEW', view_definition: fx(D_CUSTOMER) }));
  check('full-name box hidden for UC JSON (it carries full_name)', $('dbxFullName').style.display === 'none');
  // pasted --- documents: type a name for the first
  convert(fx(D_CUSTOMER) + '\n---\n' + fx(F_SALES));
  pick(1);
  check('--- pasted: f_sales unresolved without names', read().codes.includes('POSSIBLE_METRIC_VIEW'));
  pick(0); typeFullName(D_CUSTOMER);
  check('--- pasted: typing the full name of the first document resolves the second', !pick(1).codes.includes('POSSIBLE_METRIC_VIEW'));
  // plain Convert click keeps the typed names
  window.runDbxConversion();
  check('re-running Convert keeps typed full names', !pick(1).codes.includes('POSSIBLE_METRIC_VIEW'));

  // (d) the single-file name survives edits of the same view, not a different view
  reset(); setConn(CONN);
  await window.loadDbxFiles([file('d_customer.yaml', fx(D_CUSTOMER))]);
  const edit = (txt) => { $('dbxYamlInput').value = txt; $('dbxYamlInput').dispatchEvent(new window.Event('input')); window.runDbxConversion(); return read(); };
  check('single unnamed file: edit of the same view keeps the file-derived name', edit(fx(D_CUSTOMER) + '\n# edited\n').model.name === 'D Customer');
  check('single unnamed file: another edit still keeps it', edit(fx(D_CUSTOMER) + '\n# edited again\n').model.name === 'D Customer');
  check('single unnamed file: pasting a different view (other source:) drops the file name', unnamed(edit(fx(DEMO)).model.name));
  await window.loadDbxFiles([file(D_CUSTOMER + '.yaml', fx(D_CUSTOMER))]);
  check('single named file: edit of the same view keeps the full name', edit(fx(D_CUSTOMER) + '\n# edited\n').model.name === 'D Customer Metric View');
  check('single named file: pasting a different view drops the full name', unnamed(edit(fx(DEMO)).model.name));
  await window.loadDbxFiles([file('d_customer.yaml', fx(D_CUSTOMER))]);
  edit(fx(D_CUSTOMER));
  typeFullName(D_CUSTOMER);
  check('typed full name survives a same-view edit', edit(fx(D_CUSTOMER) + '\n# x\n').model.name === 'D Customer Metric View' && $('dbxFullName').value === D_CUSTOMER);
  // multi-file: typing in the textarea still drops the files (and their names)
  await window.loadDbxFiles([file('a.yaml', fx(D_CUSTOMER)), file('b.yaml', fx(F_SALES))]);
  $('dbxYamlInput').value = fx(D_CUSTOMER); $('dbxYamlInput').dispatchEvent(new window.Event('input'));
  window.runDbxConversion();
  check('multi-file: typing drops the files; the pasted view is unnamed again', $('dbxViewPicker').options.length === 1 && unnamed(read().model.name));

  // (c) wording: references resolve only with a full name; --- paste is not claimed to resolve them
  const help = window.eval('HELP_CONTENT.dbx');
  const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
  const h = strip(help);
  check('help: references resolve only with a full name (file name / UC JSON / Full name box)', /resolves only when the referenced view has its full/.test(h) && /Full name/.test(h) && /full_name/.test(h), h.slice(h.indexOf('Views that reference'), h.indexOf('Views that reference') + 200));
  check('help: says pasted/--- YAML does not resolve references until a full name is supplied', /does not resolve references until its full name is supplied/.test(h));
  check('help does not claim --- paste resolves references', !/---[^.]*(resolve|matched by full name)/.test(h.replace(/does not resolve references until its full name is supplied/, '')) );
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  check('README: same rule (only with a full name; Full name box; plain YAML does not resolve)', /resolves \*\*only\*\* when the referenced view has its full/.test(readme) && /Full name/.test(readme) && /do not resolve references until a full name is supplied/.test(readme));
  const hint = strip(html.slice(html.indexOf('id="subPanelDbx"'), html.indexOf('<!-- 🔍 LookML Converter Panel -->')));
  check('panel hint: references resolve only with a full name', /resolves only when the referenced view has its full name/.test(hint));
}

// ── 4. catalog / schema (source: orders) ────────────────────────────────────
const ORDERS_YAML = `version: 1.1
source: orders
dimensions:
  - name: status
    expr: status
measures:
  - name: order_count
    expr: COUNT(1)
`;
{
  let r = convert(ORDERS_YAML);
  check('source: orders: refused (no spec), Save disabled', r.model === null && !r.save);
  check('source: orders: output explains the missing catalog / schema', /Catalog \/ Schema/.test(r.raw) && r.raw.startsWith('//'), r.raw.slice(0, 120));
  check('source: orders: NEEDS_CATALOG / NEEDS_SCHEMA findings', r.codes.includes('NEEDS_CATALOG') && r.codes.includes('NEEDS_SCHEMA'), r.codes.join(','));
  check('source: orders: catalog / schema inputs revealed and highlighted', r.catRowVisible && $('dbxCatalog').style.borderColor !== '' && $('dbxSchema').style.borderColor !== '');
  convert(ORDERS_YAML);
  $('dbxCatalog').value = 'main'; $('dbxSchema').value = 'sales';
  window.runDbxConversion();
  r = read();
  check('after filling catalog / schema: converts', !!r.model && r.save, r.codes.join(','));
  const wh = r.model ? r.model.pages.flatMap(p => p.elements).filter(e => e.source && e.source.kind === 'warehouse-table').map(e => e.source.path.join('.')) : [];
  check('after filling: table path is main.sales.orders', wh.includes('main.sales.orders'), wh.join('|'));
  const q = convert(fx(DEMO));
  check('fully qualified view: catalog / schema row stays hidden', !q.catRowVisible);
  convert(ORDERS_YAML);
  $('dbxYamlInput').value = fx(DEMO);
  window.runDbxConversion();
  check('switching from unqualified to qualified view hides the catalog / schema row', !read().catRowVisible);
  $('dbxYamlInput').value = '';
  window.runDbxConversion();
  check('empty conversion hides the catalog / schema row', !read().catRowVisible);
  // unqualified JOIN source: the view is refused with NEEDS_* findings and the output still carries the catalog / schema hint
  const j = convert(`version: 1.1\nsource: main.s.t\njoins:\n  - name: j\n    source: orders2\n    "on": source.a = j.a\ndimensions:\n  - name: d\n    expr: source.a\nmeasures:\n  - name: s\n    expr: SUM(source.x)\n`);
  check('unqualified join source: refused, catalog / schema row revealed, output hints at it', j.model === null && j.catRowVisible && /Catalog \/ Schema/.test(j.raw) && j.codes.includes('NEEDS_CATALOG'), j.raw.slice(0, 100) + ' ' + j.codes.join(','));
  // the hint is driven by the view's own NEEDS_* findings, not only by a per-view `needs` field
  window.eval(`var __realDbx = DbxMetricView; DbxMetricView = Object.assign({}, __realDbx, { convertDatabricksMetricViews: function (v, o) { var r = __realDbx.convertDatabricksMetricViews(v, o); r.results.forEach(function (x) { delete x.needs; }); return r; } });`);
  try {
    const k = convert(ORDERS_YAML);
    check('hint shown even when the per-view result carries no `needs` (top-level needs + NEEDS_* findings)', /Catalog \/ Schema/.test(k.raw) && k.catRowVisible, k.raw.slice(0, 100));
  } finally { window.eval('DbxMetricView = __realDbx'); }
}

// ── 5. Unity Catalog JSON, several documents pasted ─────────────────────────
{
  const uc = JSON.stringify({ name: 'd_customer_metric_view', full_name: D_CUSTOMER, table_type: 'METRIC_VIEW', view_definition: fx(D_CUSTOMER) });
  const r = convert(uc);
  check('UC table JSON pasted as is: converts', !!r.model && r.save, r.codes.join(',') + ' ' + r.raw.slice(0, 80));
  check('UC table JSON: picker label / model name come from full_name', /D Customer/i.test(r.model ? r.model.name : ''), r.model && r.model.name);
  const two = convert(JSON.stringify([
    { full_name: D_CUSTOMER, table_type: 'METRIC_VIEW', view_definition: fx(D_CUSTOMER) },
    { full_name: F_SALES, table_type: 'METRIC_VIEW', view_definition: fx(F_SALES) },
  ]));
  check('JSON array of UC objects pasted: 2 views in the picker', $('dbxViewPicker').options.length === 2 && !!two.model, String($('dbxViewPicker').options.length));
  const multi = convert(fx(D_CUSTOMER) + '\n---\n' + fx(F_SALES));
  check('two YAML documents separated by --- : 2 views in the picker', $('dbxViewPicker').options.length === 2 && !!multi.model, String($('dbxViewPicker').options.length));
}

// ── 6. connection / friendly names / empty input ───────────────────────────
{
  let r = convert(fx(DEMO), { conn: '' });
  check('empty connection: placeholder in spec', r.raw.includes('<CONNECTION_ID>'));
  check('empty connection: "Connection ID not set" warning', r.codes.includes('CONNECTION_NOT_SET') && /Connection ID not set/.test(r.findingText));
  reset(); setConn(CONN);
  window.eval(`wizardState.connections = [{ connectionId: '${CONN}', friendlyName: false }]`);
  $('dbxYamlInput').value = fx(DEMO);
  window.runDbxConversion(); r = read();
  check('friendly names off: FRIENDLY_NAMES_OFF warning, not blocked', r.codes.includes('FRIENDLY_NAMES_OFF') && !!r.model && r.save);
  window.eval(`wizardState.connections = [{ connectionId: '${CONN}', friendlyName: true }]`);
  window.runDbxConversion(); r = read();
  check('friendly names on: no FRIENDLY_NAMES_OFF', !r.codes.includes('FRIENDLY_NAMES_OFF'));
  window.eval('wizardState.connections = []');
}
{
  convert(fx(DEMO));
  check('empty input setup: something was converted', !!read().model && $('dbxOutputStats').textContent !== '');
  $('dbxYamlInput').value = '   ';
  window.runDbxConversion();
  const r = read();
  check('empty input: output cleared', $('dbxJsonOutput').value === '', $('dbxJsonOutput').value.slice(0, 40));
  check('empty input: findings, summary and stats cleared', $('dbxFindings').textContent === '' && $('dbxSummary').textContent === '' && $('dbxOutputStats').textContent === '');
  check('empty input: Copy / Load / Save disabled', !r.copy && !r.load && !r.save);
  const bad = convert('this: is: not: [valid');
  check('invalid YAML: finding shown, nothing to copy', bad.codes.length > 0 && !bad.copy, bad.codes.join(','));
}
{
  // file-read failure: finding, no rejection, readable files still convert
  reset();
  let unhandled = null, threw = null;
  const onRej = (e) => { unhandled = e; };
  process.on('unhandledRejection', onRej);
  const badFile = { name: 'bad.yaml', size: 1, text: async () => { throw new Error('boom read'); } };
  try { await window.loadDbxFiles([badFile]); } catch (e) { threw = e; }
  check('file read failure: does not reject, finding shown', !threw && /bad\.yaml/.test($('dbxFindings').textContent) && /boom read/.test($('dbxFindings').textContent), $('dbxFindings').textContent);
  try { await window.loadDbxFiles([badFile, file(D_CUSTOMER + '.yaml', fx(D_CUSTOMER))]); } catch (e) { threw = e; }
  check('file read failure (partial): good file converts, failure still reported', !threw && !!read().model && /boom read/.test($('dbxFindings').textContent));
  const dropEv = { preventDefault() {}, currentTarget: { classList: { remove() {} } }, dataTransfer: { files: [badFile] } };
  const pr = window.handleDbxFileDrop(dropEv);
  check('drop handler returns a promise', pr && typeof pr.then === 'function');
  try { await pr; } catch (e) { threw = e; }
  await new Promise(r => setTimeout(r, 20));
  process.off('unhandledRejection', onRej);
  check('no unhandled rejection from file loading', !unhandled && !threw, unhandled && String(unhandled));
}

// ── 7. XSS ─────────────────────────────────────────────────────────────────
{
  const evil = '<img src=x onerror=alert(1)>';
  const yaml = `version: 1.1
source: main.s.t
dimensions:
  - name: "${evil}"
    expr: a
  - name: ok_dim
    expr: b
measures:
  - name: "${evil}_w"
    expr: SUM(a)
    window:
      - order: ok_dim
        range: cumulative
  - name: m1
    expr: SUM(a)
`;
  const r = convert(yaml);
  const panel = $('subPanelDbx');
  check('XSS: no <img> element anywhere in the Databricks panel', panel.querySelectorAll('img').length === 0, String(panel.querySelectorAll('img').length));
  check('XSS: the hostile measure name appears as text in the findings / summary', (r.findingText + r.summary).includes(evil), r.codes.join(','));
  check('XSS: no alert fired', !alertCalled);
  reset();
  await window.loadDbxFiles([file(`a${evil}.yaml`, fx(D_CUSTOMER))]);
  check('XSS: hostile file name rendered as text', !$('dbxFileList').querySelector('img') && $('dbxFileList').textContent.includes('<img'));
  await window.loadDbxFiles([file(`a${evil}.yaml`, fx(D_CUSTOMER)), file('b.yaml', fx(DEMO))]);
  check('XSS: hostile file name in picker / file list is text', !panel.querySelector('img') && ($('dbxFileList').textContent + $('dbxViewPicker').textContent).includes('<img'));
  // the finding renderer itself, fed a hostile finding
  const node = window.dbxFindingNode({ code: evil, severity: 'error', message: evil, remediation: evil, object: { kind: 'measure', name: evil, owner: evil } });
  check('XSS: dbxFindingNode renders every field as text', node.querySelectorAll('img').length === 0 && node.textContent.split('<img').length >= 5);
}

// ── 8. Load into Editor + example + wiring ──────────────────────────────────
{
  const r = convert(fx(DEMO));
  let threw = null;
  try { window.loadDbxOutputToEditor(); } catch (e) { threw = e; }
  check('Load into Editor: no exception', !threw, threw && threw.message);
  const st = window.eval('state');
  check('Load into Editor: state.isNewModel set, nothing selected', st.isNewModel === true && st.selectedModel === null);
  let edited = null;
  try { edited = JSON.parse($('jsonEditor').value); } catch (_) {}
  check('Load into Editor: editor holds the converted spec', !!edited && edited.name === r.model.name && Array.isArray(edited.pages) && edited.schemaVersion === 1);
  check('Load into Editor: title updated', /Databricks Metric View/.test($('editorTitle').textContent));
}
{
  reset();
  window.loadDbxExample();
  window.runDbxConversion();
  const r = read();
  check('example converts ok with >= 1 metric and no error findings', !!r.model && metricNames(r.model).length >= 1 && !/⛔/.test(r.findingText), r.codes.join(',') + ' ' + r.raw.slice(0, 80));
  check('upload input accepts .yaml,.yml,.json and multiple', $('dbxYamlUpload').getAttribute('accept') === '.yaml,.yml,.json' && $('dbxYamlUpload').multiple);
  check('engine global present', typeof window.DbxMetricView === 'object' && typeof window.DbxMetricView.convertDatabricksMetricViews === 'function' && typeof window.DbxMetricView.DBX_ENGINE_VERSION === 'string');
  const opt = [...$('converterFormat').options].find(o => o.value === 'dbx');
  const order = [...$('converterFormat').options].map(o => o.value);
  check('picker option "🧱 Databricks Metric View" after snow', !!opt && opt.textContent === '🧱 Databricks Metric View' && order.indexOf('dbx') === order.indexOf('snow') + 1, order.join(','));
  window.switchConverter('dbx');
  check('switchConverter("dbx") activates #subPanelDbx and only it', $('subPanelDbx').classList.contains('active') && [...doc.querySelectorAll('.converter-panel.active')].length === 1);
  const help = window.eval('HELP_CONTENT.dbx');
  check('HELP_CONTENT.dbx: how to fetch the YAML, UC JSON, referenced views, window refusal',
    /databricks api get \/api\/2\.1\/unity-catalog\/tables\//.test(help) && /view_definition/.test(help) && /table_type|Unity Catalog/.test(help) && /window/.test(help) && /together/i.test(help));
  const tabs = [...doc.querySelectorAll('#helpTabs .help-tab')].map(b => (b.getAttribute('onclick') || '').match(/'([^']+)'/)[1]);
  check('help tab button present right after snow', tabs.indexOf('dbx') === tabs.indexOf('snow') + 1, tabs.join(','));
  window.switchHelpTab('dbx');
  check('switchHelpTab("dbx") renders the Databricks help and marks its tab active',
    /Databricks/.test($('helpContent').textContent) && doc.querySelectorAll('#helpTabs .help-tab.active').length === 1 && /Databricks/.test(doc.querySelector('#helpTabs .help-tab.active').textContent));
  const src = html;
  check('connection dropdown lists include dbxConnectionId (populate + reset)', (src.match(/'dbxConnectionId'/g) || []).length >= 2);
  const ids = ['dbxYamlInput', 'dbxDropZone', 'dbxConnectionId', 'dbxCatalog', 'dbxSchema', 'dbxBestEffort', 'dbxConvertBtn', 'dbxFindings', 'dbxJsonOutput'];
  check('brief element ids all present', ids.every(i => !!$(i)), ids.filter(i => !$(i)).join(','));
  check('save wiring: Load & Save button calls loadAndSaveDbxModel', /loadAndSaveDbxModel\(\)/.test($('dbxSaveBtn').getAttribute('onclick') || '') && typeof window.loadAndSaveDbxModel === 'function');
}

// ── 9. Sync script --check ─────────────────────────────────────────────────
if (!process.env.SMM_INDEX_PATH && existsSync(join(MCP, 'vendor/dbx-metric-view/PROVENANCE.json'))) {
  const res = spawnSync('node', [join(__dirname, '..', 'scripts/sync-dbx-metric-view.mjs'), MCP, '--check'], { encoding: 'utf8' });
  check('sync-dbx-metric-view --check passes', res.status === 0, (res.stderr || '').trim());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
