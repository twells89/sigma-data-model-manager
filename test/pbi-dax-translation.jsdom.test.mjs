/**
 * JSDOM harness for beads-sigma-9l2 / 3t9 / n9u / w9s (browser surface).
 *
 * Loads index.html into JSDOM, runs fixture_07_comp_distribution.bim and
 * fixture_08_safety_absence_patterns.bim through the real processPbiFile() +
 * runPbiConversion() path (NO db/schema overrides), and mirrors the MCP node
 * assertions:
 *   9l2 — stat-iterator DAX -> correct Sigma names; no raw-DAX error columns
 *   3t9 — EARLIER rank idiom -> RankDense
 *   n9u — SWITCH(TRUE()) -> nested If
 *   w9s — GENERATESERIES calc table -> sql element (not warehouse-table)
 *
 * Run (repo root, after `npm install --no-save jsdom`):
 *   node test/pbi-dax-translation.jsdom.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', 'index.html');
const FIXTURE_DIR = '/Users/tjwells/sigma-skills-staging/powerbi-to-sigma/fixtures';
const html = readFileSync(INDEX_HTML, 'utf8');

async function convert(fixtureName) {
  const bimText = readFileSync(join(FIXTURE_DIR, fixtureName), 'utf8');
  const consoleErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + (e.detail?.stack || e.message)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://localhost/', virtualConsole: vc,
  });
  const { window } = dom;
  window.sessionStorage.setItem('sigma_standalone_dev_mode', 'true');
  const ensureEl = (id, tag = 'div') => {
    let el = window.document.getElementById(id);
    if (!el) { el = window.document.createElement(tag); el.id = id; window.document.body.appendChild(el); }
    return el;
  };
  const out = ensureEl('pbiJsonOutput', 'textarea');
  const warnBox = ensureEl('pbiWarningBox');
  ensureEl('pbiOutputStats'); ensureEl('pbiFileList'); ensureEl('pbiConvertBtn', 'button');
  ['pbiCopyBtn', 'pbiLoadBtn', 'pbiSaveBtn'].forEach(id => ensureEl(id, 'button'));
  ensureEl('pbiConnectionId', 'input').value = '';
  ensureEl('pbiDatabase', 'input').value = '';
  ensureEl('pbiSchema', 'input').value = '';
  const file = new window.File([bimText], fixtureName, { type: 'application/json' });
  if (typeof file.text !== 'function') file.text = async () => bimText;
  await window.processPbiFile(file);
  window.runPbiConversion();
  assert.ok(out.value && out.value.trim().length,
    `pbiJsonOutput empty for ${fixtureName} — conversion failed. jsdomErrors:\n${consoleErrors.join('\n')}`);
  const result = JSON.parse(out.value);
  const metrics = {}, calcCols = {};
  for (const el of result.pages[0].elements) {
    for (const m of (el.metrics || [])) metrics[m.name] = m.formula;
    for (const c of (el.columns || [])) if (c.name) calcCols[c.name] = c.formula;
  }
  const warnText = warnBox.textContent || warnBox.innerHTML || '';
  return { result, metrics, calcCols, warnText };
}

const RAW_DAX_BANNED =
  /\b(MEDIANX|PERCENTILEX\.INC|PERCENTILEX\.EXC|STDEVX\.P|STDEVX\.S|VARX\.P|VARX\.S|GEOMEANX|DISTINCTCOUNTNOBLANK|COMBINEVALUES|EARLIER|HASONEVALUE|SELECTEDVALUE)\b|SWITCH\s*\(\s*TRUE/i;

// ── fixture_07: 9l2 + 3t9 ──
{
  const { result, metrics, calcCols, warnText } = await convert('fixture_07_comp_distribution.bim');

  // 9l2 (a): correct Sigma function names
  assert.equal(metrics['Median Salary'], 'Median([Annual Salary])', '9l2: MEDIANX -> Median');
  assert.equal(metrics['P90 Salary'], 'PercentileCont([Annual Salary], 0.9)', '9l2: PERCENTILEX.INC -> PercentileCont');
  assert.equal(metrics['Salary StdDev'], 'Sqrt(VariancePop([Annual Salary]))', '9l2: STDEVX.P -> Sqrt(VariancePop())');
  assert.equal(metrics['Salary Variance'], 'VariancePop([Annual Salary])', '9l2: VARX.P -> VariancePop');
  assert.equal(metrics['Salary GeoMean'], 'Exp(Avg(Ln([Annual Salary])))', '9l2: GEOMEANX -> Exp(Avg(Ln()))');
  assert.equal(metrics['Distinct Roles'], 'CountDistinct([Role])', '9l2: DISTINCTCOUNTNOBLANK -> CountDistinct');
  assert.equal(metrics['Selected Dept Label'],
    'If(CountDistinct([Department]) = 1, Min([Department]), "All Departments")',
    '9l2: IF(HASONEVALUE,SELECTEDVALUE,def) -> single-value If');
  assert.equal(calcCols['Dept-Role Key'], '[Department] & " | " & [Role]', '9l2: COMBINEVALUES -> & concat');

  // 9l2: wrong names must NOT appear
  for (const f of Object.values(metrics)) {
    assert.ok(!/\bPercentileInc\b/.test(f), `PercentileInc is wrong; use PercentileCont: ${f}`);
    assert.ok(!/\bStdDevP\b/.test(f), `StdDevP does not exist: ${f}`);
    assert.ok(!/\bVarianceP\b/.test(f), `VarianceP is wrong; use VariancePop: ${f}`);
  }

  // 9l2 (b): no banned raw-DAX tokens survive in any emitted formula
  for (const [name, formula] of [...Object.entries(metrics), ...Object.entries(calcCols)])
    assert.ok(!RAW_DAX_BANNED.test(formula), `raw DAX leaked in "${name}": ${formula}`);

  // 3t9 + jzd8: the EARLIER row-rank idiom must NOT post as a base-table RankDense
  // calc column — Sigma's window functions error in a base calc column. It is
  // lowered to a kind:'sql' helper element (preferred) or dropped-and-warned.
  assert.ok(!/\bRankDense\b/.test(String(calcCols['Salary Rank In Dept'] || '')),
    '3t9/jzd8: EARLIER rank must not be emitted as a base-table RankDense calc column');

  // w9s: SalaryBands GENERATESERIES -> sql element, not warehouse-table
  const sqlEls = result.pages[0].elements.filter(e => e?.source?.kind === 'sql');
  const bands = sqlEls.find(e => e.name === 'SALARYBANDS');
  assert.ok(bands, 'w9s: SalaryBands must be a sql element');
  assert.match(bands.source.statement, /VALUES\s*\(40000\)/, 'w9s: series starts at 40000');
  assert.match(bands.source.statement, /\(200000\)/, 'w9s: series includes 200000');
  const bases = result.pages[0].elements.filter(e => e?.source?.kind === 'warehouse-table');
  assert.ok(!bases.some(e => e.name === 'SALARYBANDS'), 'w9s: SalaryBands must NOT be a warehouse-table');

  console.log('PASS browser/JSDOM fixture_07: 9l2 stat-names + no-raw-DAX, 3t9 RankDense, w9s SalaryBands sql element');
}

// ── fixture_08: n9u + w9s ──
{
  const { result, metrics, calcCols } = await convert('fixture_08_safety_absence_patterns.bim');

  // n9u: value-form SWITCH stays Switch (sanity)
  assert.equal(calcCols['Severity Weight'], 'Switch([Severity], "Critical", 4, "High", 3, "Medium", 2, "Low", 1, 0)',
    'n9u: value-form SWITCH -> Sigma Switch');

  // w9s: DimMonth GENERATESERIES -> sql element
  const sqlEls = result.pages[0].elements.filter(e => e?.source?.kind === 'sql');
  const dm = sqlEls.find(e => e.name === 'DIMMONTH');
  assert.ok(dm, 'w9s: DimMonth must be a sql element');
  assert.match(dm.source.statement, /VALUES\s*\(0\)/, 'w9s: DimMonth series starts at 0');
  const bases = result.pages[0].elements.filter(e => e?.source?.kind === 'warehouse-table');
  assert.ok(!bases.some(e => e.name === 'DIMMONTH'), 'w9s: DimMonth must NOT be a warehouse-table');

  console.log('PASS browser/JSDOM fixture_08: n9u Switch, w9s DimMonth sql element');
}

// ── n9u SWITCH(TRUE()) -> nested If (direct, via window.pbiDaxToSigma) ──
{
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/' });
  const { window } = dom;
  const r = window.pbiDaxToSigma('SWITCH(TRUE(), [S] >= 90, "A", [S] >= 80, "B", "F")', [], 'x');
  assert.equal(r, 'If([S] >= 90, "A", If([S] >= 80, "B", "F"))', 'n9u: SWITCH(TRUE()) -> nested If');
  const r2 = window.pbiDaxToSigma('SWITCH(TRUE(), [S] > 0, "pos")', [], 'x');
  assert.equal(r2, 'If([S] > 0, "pos", null)', 'n9u: SWITCH(TRUE()) no-default -> null else');
  console.log('PASS browser/JSDOM n9u: SWITCH(TRUE()) -> nested If');
}

// ── 7mn: ADDCOLUMNS(CALENDAR(a,b)) -> real date-spine sql element (NOT {ok:false}) ──
{
  const { result, warnText } = await convert('fixture_06_kitchen_sink.bim');
  const sqlEls = result.pages[0].elements.filter(e => e?.source?.kind === 'sql');
  const dd = sqlEls.find(e => e.name === 'DIMDATE');
  assert.ok(dd, '7mn: DimDate must be a sql element');
  assert.notEqual(dd.ok, false, '7mn: CALENDAR is translatable — must NOT carry ok:false');
  assert.doesNotMatch(dd.source.statement, /TODO/, '7mn: real spine SQL must not be a TODO placeholder');
  assert.match(dd.source.statement, /GENERATOR\s*\(\s*ROWCOUNT\s*=>\s*3287\s*\)/i, '7mn: GENERATOR(ROWCOUNT => 3287)');
  assert.match(dd.source.statement, /DATEADD\(\s*'day'\s*,\s*SEQ4\(\)\s*,\s*CAST\('2018-01-01' AS DATE\)\)/i, '7mn: DATEADD day-offsets from 2018-01-01');
  assert.match(dd.source.statement, /EXTRACT\(YEAR FROM d\) AS "Year"/i, '7mn: Year = EXTRACT(YEAR)');
  assert.match(dd.source.statement, /EXTRACT\(MONTH FROM d\) AS "Month No"/i, '7mn: MonthNo = EXTRACT(MONTH)');
  assert.match(dd.source.statement, /TO_CHAR\(d, 'Mon'\) AS "Month"/i, "7mn: Month = TO_CHAR(,'Mon')");
  const bases = result.pages[0].elements.filter(e => e?.source?.kind === 'warehouse-table');
  assert.ok(!bases.some(e => e.name === 'DIMDATE'), '7mn: DimDate must NOT be a path-guessed warehouse-table');
  assert.ok(/DimDate/.test(warnText) && /date-spine/i.test(warnText), '7mn: expected a date-spine synthesis warning');
  console.log('PASS browser/JSDOM 7mn: CALENDAR/ADDCOLUMNS -> real date-spine sql element (3287 rows)');
}

// ── a8h: WEEKNUM -> Excel-style week formula (NOT ISO DatePart), via window.pbiDaxToSigma ──
{
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/' });
  const { window } = dom;
  const t2 = window.pbiDaxToSigma('WEEKNUM(SAFETY_INCIDENTS[DATE], 2)', [], 'Week Of Year');
  assert.ok(!/DatePart\s*\(\s*"week"/i.test(t2), 'a8h: must NOT use ISO DatePart("week")');
  assert.equal(t2, 'Floor((DateDiff("day", DateTrunc("year", [DATE]), [DATE]) + Mod(Weekday(DateTrunc("year", [DATE])) + 5, 7)) / 7) + 1',
    'a8h: WEEKNUM(d,2) -> Monday-start Excel formula (+5 offset)');
  const tDef = window.pbiDaxToSigma('WEEKNUM(SAFETY_INCIDENTS[DATE])', [], 'Week Of Year');
  const t1 = window.pbiDaxToSigma('WEEKNUM(SAFETY_INCIDENTS[DATE], 1)', [], 'Week Of Year');
  for (const out of [tDef, t1]) {
    assert.ok(!/DatePart\s*\(\s*"week"/i.test(out), 'a8h: default/type-1 must NOT use ISO DatePart');
    assert.ok(/Mod\(Weekday\(DateTrunc\("year", \[DATE\]\)\) \+ 6, 7\)/.test(out), 'a8h: Sunday-start (+6 offset)');
  }
  console.log('PASS browser/JSDOM a8h: WEEKNUM -> Excel-style week formula (type 2 +5, type 1 +6)');
}

console.log('ALL PASS browser/JSDOM pbi-dax-translation (9l2 / 3t9 / n9u / w9s / 7mn / a8h)');
