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
