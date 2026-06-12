/**
 * Tableau table-calc → Sigma window-function tests (browser surface).
 *
 * Mirrors the MCP tests (sigma-data-model-mcp src/tableau.window.test.ts) for
 * the WINPROBE-validated mappings (live-proven 930/930):
 *   RUNNING_SUM/AVG/MAX/MIN/COUNT(agg)   → Cumulative*(agg)
 *   WINDOW_AVG/SUM/MAX/MIN(agg, -n, 0)   → Moving*(agg, n);  (-n, m) → (agg, n, m)
 *   WINDOW_STDEV                          → MovingStdDev
 *   SUM(x)/WINDOW_SUM(SUM(x))             → PercentOfTotal(Sum(x), "grand_total")
 *   RUNNING_SUM(agg)/TOTAL(agg)           → CumulativeSum(PercentOfTotal(…))
 *   RANK/RANK_DENSE/RANK_PERCENTILE       → Rank/RankDense/RankPercentile(agg, "desc")
 *   INDEX() → RowNumber();  LOOKUP(agg, ±n) → Lag/Lead(agg, n)
 *
 * HARD CONSTRAINTS under test:
 *   - these Sigma window functions are CHART/grouped-element context only —
 *     the converter must report them in window._tableauWorkbookPatterns and
 *     NEVER emit them into a DM column/metric (they silently error there);
 *   - never emit *Over functions;
 *   - untranslatable (WINDOW_MEDIAN/PERCENTILE/CORR/COVAR, PREVIOUS_VALUE,
 *     SIZE) → loud warning naming the fragment, never silent.
 *
 * Run: node test/tableau-window-fns.jsdom.test.mjs
 * (or with SMM_INDEX_PATH=/private/tmp/sigma-data-model-manager/index.html)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = process.env.SMM_INDEX_PATH || join(__dirname, '..', 'index.html');

const html = readFileSync(INDEX_HTML, 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc });
const { window } = dom;
window.sessionStorage.setItem('sigma_standalone_dev_mode', 'true');
if (window.state) window.state.useFriendlyNames = true;

let fail = 0;
const check = (label, ok, extra) => {
  if (ok) console.log(`✓ ${label}`);
  else { fail++; console.log(`✗ ${label}${extra ? ' — ' + extra : ''}`); }
};
const NO_OVER_RE = /\b\w+Over\s*\(/;

// ── 1. validated formula mappings ────────────────────────────────────────────
const CASES = [
  ['RUNNING_SUM(SUM([SALES]))', 'CumulativeSum(Sum([Sales]))'],
  ['RUNNING_AVG(AVG([SALES]))', 'CumulativeAvg(Avg([Sales]))'],
  ['RUNNING_MAX(MAX([PROFIT]))', 'CumulativeMax(Max([Profit]))'],
  ['RUNNING_MIN(MIN([PROFIT]))', 'CumulativeMin(Min([Profit]))'],
  ['RUNNING_COUNT(COUNT([ORDER_ID]))', 'CumulativeCount(Count([Order Id]))'],
  ['RUNNING_SUM(AVG([SALES]))', 'CumulativeSum(Avg([Sales]))'],
  ['RUNNING_SUM([SALES])', 'CumulativeSum(Sum([Sales]))'],
  ['WINDOW_AVG(SUM([SALES]), -2, 0)', 'MovingAvg(Sum([Sales]), 2)'],
  ['WINDOW_SUM(SUM([SALES]), -3, 0)', 'MovingSum(Sum([Sales]), 3)'],
  ['WINDOW_MAX(MAX([SALES]), -6, 0)', 'MovingMax(Max([Sales]), 6)'],
  ['WINDOW_MIN(MIN([SALES]), -6, 0)', 'MovingMin(Min([Sales]), 6)'],
  ['WINDOW_AVG(SUM([SALES]), -2, 2)', 'MovingAvg(Sum([Sales]), 2, 2)'],
  ['WINDOW_STDEV(SUM([SALES]), -5, 0)', 'MovingStdDev(Sum([Sales]), 5)'],
  ['SUM([SALES]) / WINDOW_SUM(SUM([SALES]))', 'PercentOfTotal(Sum([Sales]), "grand_total")'],
  ['RUNNING_SUM(SUM([SALES])) / TOTAL(SUM([SALES]))', 'CumulativeSum(PercentOfTotal(Sum([Sales]), "grand_total"))'],
  ['RUNNING_SUM(SUM([SALES])) / WINDOW_SUM(SUM([SALES]))', 'CumulativeSum(PercentOfTotal(Sum([Sales]), "grand_total"))'],
  ['RANK(SUM([SALES]))', 'Rank(Sum([Sales]), "desc")'],
  ["RANK(SUM([SALES]), 'asc')", 'Rank(Sum([Sales]), "asc")'],
  ['RANK_DENSE(SUM([SALES]))', 'RankDense(Sum([Sales]), "desc")'],
  ['RANK_PERCENTILE(SUM([SALES]))', 'RankPercentile(Sum([Sales]), "desc")'],
  ['INDEX()', 'RowNumber()'],
  ['LOOKUP(SUM([SALES]), -1)', 'Lag(Sum([Sales]), 1)'],
  ['LOOKUP(SUM([SALES]), 2)', 'Lead(Sum([Sales]), 2)'],
  ['LOOKUP(SUM([SALES]), 0)', 'Sum([Sales])'],
];
for (const [src, expected] of CASES) {
  const warnings = [];
  const got = window.tableauFormulaToSigma(src, warnings);
  check(`${src} → ${expected}`, got === expected, `got ${JSON.stringify(got)}`);
  check(`${src}: never *Over`, !NO_OVER_RE.test(String(got)), String(got));
}
// chart-context caveat warning accompanies window-fn output
{
  const warnings = [];
  window.tableauFormulaToSigma('RUNNING_SUM(SUM([SALES]))', warnings);
  check('chart-only context warning emitted', warnings.some(w => /CHART\/grouped-element context ONLY/.test(w)), warnings.join(' | '));
}
// RANK_UNIQUE → Rank + verify note
{
  const m = window.tableauWindowToSigmaChart('RANK_UNIQUE(SUM([SALES]))');
  check('RANK_UNIQUE → Rank desc + verify', m && m.formula === 'Rank(Sum([Sales]), "desc")' && m.verify === true, JSON.stringify(m));
}
// mismatched ratio columns are NOT claimed
check('mismatched ratio not claimed', window.tableauWindowToSigmaChart('SUM([SALES]) / WINDOW_SUM(SUM([PROFIT]))') === null);

// ── 2. untranslatable — loud, never silent ───────────────────────────────────
const UNTRANS = [
  ['WINDOW_MEDIAN(MEDIAN([SALES]))', 'WINDOW_MEDIAN'],
  ['WINDOW_PERCENTILE(SUM([SALES]), 0.75)', 'WINDOW_PERCENTILE'],
  ['WINDOW_CORR(SUM([SALES]), SUM([PROFIT]))', 'WINDOW_CORR'],
  ['WINDOW_COVAR(SUM([SALES]), SUM([PROFIT]))', 'WINDOW_COVAR'],
  ['PREVIOUS_VALUE(0)', 'PREVIOUS_VALUE'],
  ['SIZE()', 'SIZE'],
];
for (const [src, fn] of UNTRANS) {
  check(`untranslatable detect: ${fn}`, window.tableauWindowUntranslatable(src) === fn);
  check(`untranslatable not claimed: ${fn}`, window.tableauWindowToSigmaChart(src) === null);
  const warnings = [];
  const got = window.tableauFormulaToSigma(src, warnings);
  check(`${fn}: degrades to comment`, String(got).startsWith('/*'), String(got));
  const warn = warnings.find(w => w.includes(fn));
  check(`${fn}: loud warning names fragment`, !!warn && /fragment/i.test(warn || ''), warnings.join(' | '));
}
// embedded table-calc token flagged
{
  const warnings = [];
  window.tableauFormulaToSigma('1 + RUNNING_SUM(SUM([SALES]))', warnings);
  check('embedded table-calc token flagged', warnings.some(w => /embedded in a larger expression/.test(w)), warnings.join(' | '));
}

// ── 3. end-to-end: workbookPatterns handoff + DM-column guard ────────────────
const TWB = `<?xml version='1.0' encoding='utf-8' ?>
<workbook source-build='2024.1' version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>
  <datasources>
    <datasource caption='Superstore Window Calcs' inline='true' name='federated.superstore' version='18.1'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='Snowflake' name='snowflake.0' />
        </named-connections>
        <relation connection='snowflake.0' name='SUPERSTORE_ORDERS' table='[TJ].[PUBLIC].[SUPERSTORE_ORDERS]' type='table'>
          <columns>
            <column datatype='string' name='REGION' ordinal='1' />
            <column datatype='date' name='ORDER_DATE' ordinal='2' />
            <column datatype='real' name='SALES' ordinal='3' />
            <column datatype='real' name='PROFIT' ordinal='4' />
          </columns>
        </relation>
      </connection>
      <column caption='Sales 3p Moving Avg' datatype='real' name='[Calc_MovAvg]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='WINDOW_AVG(SUM([SALES]), -2, 0)' />
      </column>
      <column caption='Pct of Total Sales' datatype='real' name='[Calc_PctTotal]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='SUM([SALES]) / WINDOW_SUM(SUM([SALES]))' />
      </column>
      <column caption='Sales Rank Percentile' datatype='real' name='[Calc_RankPctl]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='RANK_PERCENTILE(SUM([SALES]))' />
      </column>
      <column caption='Median Window' datatype='real' name='[Calc_WinMedian]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='WINDOW_MEDIAN(MEDIAN([SALES]))' />
      </column>
      <column caption='Partition Size' datatype='integer' name='[Calc_Size]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='SIZE()' />
      </column>
      <column caption='Prev Accumulator' datatype='real' name='[Calc_PrevVal]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='PREVIOUS_VALUE(SUM([SALES]))' />
      </column>
      <column caption='Profit Ratio' datatype='real' name='[Calc_ProfitRatio]' role='measure' type='quantitative'>
        <calculation class='tableau' formula='[PROFIT] / [SALES]' />
      </column>
    </datasource>
  </datasources>
</workbook>`;

{
  if (typeof window.clearTableauFiles === 'function') window.clearTableauFiles();
  window.ingestTableauXml(TWB, 'input.twb');
  const sel = window.document.getElementById('tableauConnectionId');
  if (sel && ![...sel.options].some(o => o.value === 'test-conn')) {
    const opt = window.document.createElement('option');
    opt.value = 'test-conn'; opt.textContent = 'test-conn';
    sel.appendChild(opt);
    sel.value = 'test-conn';
  }
  window.document.getElementById('tableauDatabase').value = 'TJ';
  window.document.getElementById('tableauSchema').value = 'PUBLIC';
  window.runTableauConversion();

  const out = window.document.getElementById('tableauJsonOutput').value;
  check('e2e: output produced', !!out && !out.startsWith('//'), out.slice(0, 120));
  let model = null;
  try { model = JSON.parse(out); } catch (e) { check('e2e: output parses', false, e.message); }

  if (model) {
    const elements = (model.pages || []).flatMap(p => p.elements || []);
    const allCols = elements.flatMap(e => e.columns || []);
    const allMetrics = elements.flatMap(e => e.metrics || []);
    const CHART_ONLY = /\b(?:Cumulative(?:Sum|Avg|Min|Max|Count)|Moving(?:Sum|Avg|Min|Max|Count|StdDev)|RankDense|RankPercentile|Rank|PercentOfTotal|RowNumber|Lag|Lead)\s*\(/;
    const leaked = [...allCols, ...allMetrics].filter(c =>
      CHART_ONLY.test(c.formula || '') || NO_OVER_RE.test(c.formula || '') ||
      /WINDOW_|RUNNING_|RANK_|PREVIOUS_VALUE|SIZE\s*\(/.test(c.formula || ''));
    check('e2e: no chart-only window fn / raw token leaks into DM columns or metrics',
      leaked.length === 0, leaked.map(c => `${c.name}: ${c.formula}`).join(' | '));
    check('e2e: plain calc (Profit Ratio) still emitted as DM column',
      allCols.some(c => c.name === 'Profit Ratio'));
  }

  const pats = window._tableauWorkbookPatterns || [];
  const byName = Object.fromEntries(pats.map(p => [p.name, p]));
  check('e2e: MovingAvg pattern reported', byName['Sales 3p Moving Avg']?.formula === 'MovingAvg(Sum([Sales]), 2)', JSON.stringify(byName['Sales 3p Moving Avg']));
  check('e2e: MovingAvg kind', byName['Sales 3p Moving Avg']?.kind === 'moving');
  check('e2e: PercentOfTotal pattern reported', byName['Pct of Total Sales']?.formula === 'PercentOfTotal(Sum([Sales]), "grand_total")');
  check('e2e: RankPercentile pattern reported', byName['Sales Rank Percentile']?.formula === 'RankPercentile(Sum([Sales]), "desc")');
  check('e2e: GROUPED-element placement requirement', /GROUPED workbook element/.test(byName['Sales 3p Moving Avg']?.requires || ''));
  for (const [n, fn] of [['Median Window', 'WINDOW_MEDIAN'], ['Partition Size', 'SIZE'], ['Prev Accumulator', 'PREVIOUS_VALUE']]) {
    check(`e2e: ${fn} unsupported pattern (no formula)`, byName[n]?.kind === 'unsupported' && !byName[n]?.formula, JSON.stringify(byName[n]));
  }

  const warnHtml = window.document.getElementById('tableauWarningBox').innerHTML;
  check('e2e: 🧩 pattern lines in warnings', /🧩 Workbook pattern \[moving\] "Sales 3p Moving Avg"/.test(warnHtml), warnHtml.slice(0, 300));
  check('e2e: loud WINDOW_MEDIAN warning', /WINDOW_MEDIAN\(\) has no Sigma equivalent/.test(warnHtml));
  const stats = window.document.getElementById('tableauOutputStats').innerHTML;
  check('e2e: 🧩 workbook-pattern badge in stats', /workbook pattern/.test(stats), stats);
}

console.log(fail ? `\n${fail} FAILED` : '\nall tableau window-fn browser checks passed ✓');
process.exit(fail ? 1 : 0);
