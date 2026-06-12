/**
 * Layered-LookML converter tests (browser surface).
 *
 * Mirrors the MCP src/lookml.ts hardening for layered/derived LookML
 * (sigma-data-model-mcp PR #46 + reconcile commits), ported into index.html:
 *   1. View-only mode — no .model.lkml/explore in the parse set → every view
 *      converts as a standalone element (synthetic "__VIEW_ONLY__" option).
 *   2. ${other_view.SQL_TABLE_NAME} → cycle-guarded CTE inlining; unresolved /
 *      circular refs → LOOKER_SCRATCH placeholder + LOUD warning (never a bare
 *      /* TODO * / comment in FROM position).
 *   3. CTE-continuation fragments (leading ", name AS (") are COMPLETED by the
 *      inlined-CTE prelude (or WITH-promoted when nothing was inlined) — never
 *      double-WITH.
 *   4. Persistence (datagroup_trigger / sql_trigger_value / increment_key /
 *      {% incrementcondition %}) → materialization-handoff warnings, never
 *      silent; incrementcondition becomes a valid 1=1 predicate.
 *   5. TO_CHAR(AGG(col), '<numeric mask>') measures → numeric metric + Sigma
 *      column format; unparseable masks stay on the loud-warning path.
 *   6. dimension_group dedupe (never clobber an existing physical-col id) +
 *      timeframe lists without raw still emit the physical column; measures
 *      referencing ${group_raw} resolve via dimPhysColMap (date_time → metric,
 *      NOT an aggregate calc column).
 *   7. Elements are always named; derived/cross-element refs resolve via the
 *      element NAME (srcEl.name || path tail), never a stale table tail.
 *   8. Custom-SQL bool calc dims use the source-qualified [Custom SQL/COL]
 *      ref + " (T-F)" display suffix (no "/" in display names).
 *
 * All fixtures below are SYNTHESIZED (CSA.TJ retail names) — no customer content.
 *
 * Run: node test/lookml-layered.jsdom.test.mjs
 * (or with SMM_INDEX_PATH=/private/tmp/sigma-data-model-manager/index.html)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, 'x.mjs'));
const { JSDOM, VirtualConsole } = require('jsdom');

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

function resetLook() {
  window.eval('lookProject = { views: {}, explores: {}, modelName: "", includes: [] };');
  window.document.getElementById('lookJsonOutput').value = '';
  window.document.getElementById('lookFileList').innerHTML = '';
  window.document.getElementById('lookWarnDetail').innerHTML = '';
}

async function convert(files, exploreName) {
  resetLook();
  await window.ingestLookFiles(files.map(f => ({ name: f.name, text: async () => f.content })));
  const sel = window.document.getElementById('lookExploreSelect');
  if (exploreName) { sel.value = exploreName; }
  await window.runLookConversion();
  const raw = window.document.getElementById('lookJsonOutput').value;
  const warnings = window.document.getElementById('lookWarnDetail').textContent || '';
  return { model: raw ? JSON.parse(raw) : null, warnings, selectValue: sel.value };
}

const allEls = (model) => (model?.pages || []).flatMap(p => p.elements || []);
const sqlEls = (model) => allEls(model).filter(e => e.source?.kind === 'sql');

// ════════════════════════════════════════════════════════════════════════════
// 1. View-only mode — single derived view, no model file
// ════════════════════════════════════════════════════════════════════════════
{
  const viewOnly = `
view: channel_revenue {
  derived_table: {
    sql:
      SELECT ORDER_CHANNEL, ORDER_STATUS,
             SUM(NET_REVENUE) AS NET_REVENUE,
             COUNT(DISTINCT ORDER_ID) AS NUM_ORDERS
      FROM CSA.TJ.ORDER_FACT
      GROUP BY 1,2 ;;
  }
  dimension: order_channel { type: string sql: \${TABLE}."ORDER_CHANNEL" ;; }
  dimension: net_revenue { type: number sql: \${TABLE}."NET_REVENUE" ;; }
  measure: total_net_revenue { type: sum value_format_name: usd_0 sql: \${net_revenue} ;; }
}`;
  const { model, warnings, selectValue } = await convert([{ name: 'channel_revenue.view.lkml', content: viewOnly }]);
  check('view-only: synthetic __VIEW_ONLY__ option auto-selected', selectValue === '__VIEW_ONLY__', selectValue);
  check('view-only: converts without an explore (1 element)', allEls(model).length === 1, String(allEls(model).length));
  const el = sqlEls(model)[0];
  check('view-only: element is a named Custom SQL element', !!el && el.name === 'Channel Revenue', el && el.name);
  check('view-only: standalone-mode warning emitted', /No explore\/model file provided/.test(warnings));
  const m = (el?.metrics || []).find(x => x.name === 'Total Net Revenue');
  // lookSigmaMetric display-names internally (mirrors MCP src/formulas.ts) —
  // Sigma fuzzy-matches [Net Revenue] → NET_REVENUE on sql elements.
  check('view-only: ${dim} measure resolves to Sum([Net Revenue])', !!m && m.formula === 'Sum([Net Revenue])', m && m.formula);
  check('view-only: usd_0 value_format_name carried', !!m?.format && /\$/.test(m.format.formatString || ''), JSON.stringify(m?.format));
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Layered PDT: fragment completion + CTE inlining + persistence + dim groups
// ════════════════════════════════════════════════════════════════════════════
{
  const layered = `
connection: "snowflake"
explore: trades_enriched {}

view: daily_rates {
  derived_table: {
    sql:
      SELECT TO_DATE(TO_VARCHAR(ORDER_DATE_KEY), 'YYYYMMDD') AS PRICE_DATE,
             ORDER_CHANNEL AS ASSET,
             AVG(UNIT_PRICE) AS USD_RATE
      FROM CSA.TJ.ORDER_FACT
      GROUP BY 1,2 ;;
    datagroup_trigger: nightly_datagroup
  }
  dimension: asset { type: string sql: \${TABLE}."ASSET" ;; }
}

view: trades_enriched {
  derived_table: {
    sql:
      -- CTE-continuation fragment: Looker prepends inlined PDT CTEs before this comma
      , base AS (
          SELECT t.ORDER_ID,
                 TO_DATE(TO_VARCHAR(t.ORDER_DATE_KEY), 'YYYYMMDD') AS ORDER_DATE,
                 t.NET_REVENUE, t.ORDER_CHANNEL
          FROM CSA.TJ.ORDER_FACT t
          WHERE {% incrementcondition %} t.ORDER_DATE_KEY {% endincrementcondition %}
      )
      SELECT b.*, r.USD_RATE
      FROM base b
      LEFT JOIN \${daily_rates.SQL_TABLE_NAME} r
        ON b.ORDER_DATE = r.PRICE_DATE AND b.ORDER_CHANNEL = r.ASSET ;;
    datagroup_trigger: nightly_datagroup
    increment_key: "order_date"
    increment_offset: 2
    cluster_keys: ["ORDER_DATE"]
  }
  dimension: order_id { type: string sql: \${TABLE}."ORDER_ID" ;; }
  dimension: net_revenue { type: number sql: \${TABLE}."NET_REVENUE" ;; }
  dimension: usd_rate { type: number sql: \${TABLE}."USD_RATE" ;; }
  dimension_group: order_date {
    type: time
    timeframes: [date, week, month]
    sql: CAST(\${TABLE}."ORDER_DATE" AS TIMESTAMP_NTZ) ;;
  }
  dimension_group: max_seen_dim {
    hidden: yes
    type: time
    timeframes: [raw]
    sql: \${TABLE}."ORDER_DATE" ;;
  }
  measure: total_net_revenue { type: sum value_format_name: usd_0 sql: \${net_revenue} ;; }
  measure: max_seen { type: date_time sql: MAX(\${max_seen_dim_raw}) ;; }
  measure: revenue_display { type: string sql: TO_CHAR(SUM(\${TABLE}.NET_REVENUE), '$999,999,990.00') ;; }
  measure: revenue_ym { type: string sql: TO_CHAR(SUM(\${TABLE}.NET_REVENUE), 'YYYY-MM') ;; }
  measure: count { type: count }
}`;
  const { model, warnings } = await convert([{ name: 'trades.model.lkml', content: layered }], 'trades_enriched');
  const el = sqlEls(model)[0];
  const sql = el?.source?.statement || '';

  check('layered: CTE prelude completes the leading-comma fragment',
    /WITH\s+daily_rates AS \(/.test(sql) && /\)\s*\n\s*, base AS \(/.test(sql), sql.slice(0, 200));
  check('layered: exactly one WITH (no double-WITH)', (sql.match(/\bWITH\b/gi) || []).length === 1);
  check('layered: ${daily_rates.SQL_TABLE_NAME} ref → bare CTE name', /LEFT JOIN daily_rates r/.test(sql));
  check('layered: incrementcondition → 1=1 predicate (valid WHERE)', /WHERE\s+1=1 \/\* Looker incremental condition on t\.ORDER_DATE_KEY/.test(sql));
  check('layered: no Liquid tags left in SQL', !/\{%/.test(sql));
  check('layered: incrementcondition materialization warning (🔶)', /🔶[^]*incrementcondition[^]*materialization/i.test(warnings));
  check('layered: increment_key materialization warning (🔶)', /🔶[^]*increment_key: "order_date", increment_offset: 2/.test(warnings));
  check('layered: datagroup_trigger → materialization handoff warning', /datagroup_trigger[^]*scheduled materialization/i.test(warnings));
  check('layered: cluster_keys noted as warehouse-specific', /cluster_keys/.test(warnings));

  const cols = el?.columns || [];
  const ids = cols.map(c => c.id);
  check('layered: no duplicate column ids', new Set(ids).size === ids.length);
  check('layered: timeframes without raw still emit the physical column ("Order Date Raw")',
    cols.some(c => c.name === 'Order Date Raw'));
  check('layered: CAST-wrapped dimension_group converts (Order Date Month present)',
    cols.some(c => c.name === 'Order Date Month' && /DateTrunc\("month"/.test(c.formula)));

  const metrics = el?.metrics || [];
  const maxSeen = metrics.find(m => m.name === 'Max Seen');
  check('layered: MAX(${group_raw}) date_time measure → METRIC Max([ORDER_DATE])',
    !!maxSeen && maxSeen.formula === 'Max([ORDER_DATE])', maxSeen && maxSeen.formula);
  check('layered: no aggregate calc COLUMN fabricated for max_seen',
    !cols.some(c => /^Max\s*\(/.test(c.formula || '')));

  const tochar = metrics.find(m => m.name === 'Revenue Display');
  check('layered: TO_CHAR numeric mask → numeric metric Sum([NET_REVENUE])',
    !!tochar && tochar.formula === 'Sum([NET_REVENUE])', tochar && tochar.formula);
  check('layered: TO_CHAR mask → Sigma currency format',
    !!tochar?.format && tochar.format.currencySymbol === '$' && /\$,\.2f/.test(tochar.format.formatString), JSON.stringify(tochar?.format));
  check('layered: unparseable TO_CHAR mask stays LOUD (⚠ + no metric)',
    !metrics.some(m => m.name === 'Revenue Ym') && /untranslatable fragment[^]*TO_CHAR display masks/.test(warnings));
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Circular ${a.SQL_TABLE_NAME} ↔ ${b.SQL_TABLE_NAME} → cycle-guarded scratch
// ════════════════════════════════════════════════════════════════════════════
{
  const cyc = `
view: alpha_pdt {
  derived_table: { sql: SELECT X FROM \${beta_pdt.SQL_TABLE_NAME} ;; }
  dimension: x { type: number sql: \${TABLE}.X ;; }
}
view: beta_pdt {
  derived_table: { sql: SELECT X FROM \${alpha_pdt.SQL_TABLE_NAME} ;; }
  dimension: x { type: number sql: \${TABLE}.X ;; }
}`;
  const { model, warnings } = await convert([{ name: 'cycle.view.lkml', content: cyc }]);
  const els = sqlEls(model);
  check('cycle: conversion terminates with 2 standalone elements', els.length === 2, String(els.length));
  const joined = els.map(e => e.source.statement).join('\n');
  check('cycle: LOOKER_SCRATCH placeholder emitted for the circular ref', /LOOKER_SCRATCH\.(ALPHA_PDT|BETA_PDT) \/\* unresolved Looker view/.test(joined), joined.slice(0, 200));
  check('cycle: loud circular-reference warning', /circular[^]*SQL_TABLE_NAME[^]*reference chain/.test(warnings));
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Unresolved view ref → LOOKER_SCRATCH placeholder + LOUD warning
// ════════════════════════════════════════════════════════════════════════════
{
  const unres = `
view: orphan {
  derived_table: { sql: SELECT M.A FROM \${missing_view.SQL_TABLE_NAME} M ;; }
  dimension: a { type: number sql: \${TABLE}.A ;; }
}`;
  const { model, warnings } = await convert([{ name: 'orphan.view.lkml', content: unres }]);
  const sql = sqlEls(model)[0]?.source?.statement || '';
  check('unresolved: LOOKER_SCRATCH.MISSING_VIEW placeholder in SQL',
    sql.includes('LOOKER_SCRATCH.MISSING_VIEW /* unresolved Looker view: missing_view */'), sql);
  check('unresolved: no bare /* TODO */ comment left in FROM position', !/FROM\s*\/\* TODO/.test(sql));
  check('unresolved: 🔶 UNRESOLVED VIEW warning names the fix', /🔶 UNRESOLVED VIEW "missing_view"[^]*LOOKER_SCRATCH\.MISSING_VIEW/.test(warnings));
}

// ════════════════════════════════════════════════════════════════════════════
// 5. View-only cross-view ref to a REGULAR view resolves to the literal path
// ════════════════════════════════════════════════════════════════════════════
{
  const pair = [
    { name: 'orders_agg.view.lkml', content: `
view: orders_agg {
  derived_table: { sql: SELECT ORDER_CHANNEL, SUM(NET_REVENUE) AS REV FROM \${order_fact.SQL_TABLE_NAME} GROUP BY 1 ;; }
  dimension: order_channel { type: string sql: \${TABLE}.ORDER_CHANNEL ;; }
  dimension: rev { type: number sql: \${TABLE}.REV ;; }
}` },
    { name: 'order_fact.view.lkml', content: `
view: order_fact {
  sql_table_name: CSA.TJ.ORDER_FACT ;;
  dimension: order_id { type: string sql: \${TABLE}.ORDER_ID ;; }
}` },
  ];
  const { model, warnings } = await convert(pair);
  const els = allEls(model);
  check('cross-view: both views convert standalone', els.length === 2, String(els.length));
  const agg = sqlEls(model)[0];
  check('cross-view: ${order_fact.SQL_TABLE_NAME} → literal CSA.TJ.ORDER_FACT',
    /FROM CSA\.TJ\.ORDER_FACT GROUP BY 1/.test(agg?.source?.statement || ''), agg?.source?.statement);
  check('cross-view: resolution success noted', /Resolved \$\{order_fact\.SQL_TABLE_NAME\}/.test(warnings));
  const wh = els.find(e => e.source?.kind === 'warehouse-table');
  check('cross-view: warehouse element is named', wh?.name === 'Order Fact', wh && wh.name);
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Explore mode: name-aware derived refs + (T-F) bool calc + qualified refs
// ════════════════════════════════════════════════════════════════════════════
{
  const exploreModel = `
connection: "snowflake"
explore: retail { join: customer_dim {
  relationship: many_to_one
  type: left_outer
  sql_on: \${retail.ORDER_CUSTOMER_KEY} = \${customer_dim.CUSTOMER_KEY} ;;
} }
view: retail {
  label: "Orders Fact"
  sql_table_name: CSA.TJ.ORDER_FACT ;;
  dimension: order_id { type: string sql: \${TABLE}.ORDER_ID ;; }
  dimension: order_customer_key { type: number sql: \${TABLE}.ORDER_CUSTOMER_KEY ;; }
  dimension: is_returned { type: yesno sql: \${TABLE}.IS_RETURNED = 1 ;; }
  measure: total_revenue { type: sum sql: \${TABLE}.NET_REVENUE ;; }
}
view: customer_dim {
  sql_table_name: CSA.TJ.CUSTOMER_DIM ;;
  dimension: customer_key { type: number sql: \${TABLE}.CUSTOMER_KEY ;; }
  dimension: first_name { type: string sql: \${TABLE}.FIRST_NAME ;; }
}`;
  const { model } = await convert([{ name: 'retail.model.lkml', content: exploreModel }], 'retail');
  const els = allEls(model);
  const base = els.find(e => e.name === 'Orders Fact' && e.source?.kind === 'warehouse-table');
  check('explore: base element carries its label as name', !!base);
  check('explore: every element is named', els.every(e => typeof e.name === 'string' && e.name.length > 0),
    JSON.stringify(els.map(e => e.name)));

  // derived "<name> View" + cross-element refs via the element NAME (not table tail)
  const derived = els.find(e => e.name === 'Orders Fact View');
  check('explore: derived element refs use the element NAME (no stale ORDER_FACT tail)',
    !!derived && derived.columns.every(c => c.formula.startsWith('[Orders Fact/')),
    derived && JSON.stringify(derived.columns.slice(0, 3).map(c => c.formula)));
  const flat = els.find(e => e.name === 'Retail');
  check('explore: flat explore element cross-refs use the base element NAME',
    !!flat && flat.columns.some(c => c.formula.startsWith('[Orders Fact/customer_dim/')),
    flat && JSON.stringify(flat.columns.map(c => c.formula).filter(f => f.includes('/customer_dim/'))));

  // bool calc dim — qualified ref + (T-F) suffix
  const boolCol = (base?.columns || []).find(c => (c.name || '').endsWith('(T-F)'));
  check('explore: yesno COLUMN=1 dim → " (T-F)" suffix (no "/" in display name)', !!boolCol, JSON.stringify((base?.columns || []).map(c => c.name)));
  check('explore: bool calc uses the source-qualified ref', !!boolCol && boolCol.formula === '[ORDER_FACT/Is Returned] = 1', boolCol && boolCol.formula);
}

// ════════════════════════════════════════════════════════════════════════════
// 7. dimension_group dedupe — dim + group on the same physical column
// ════════════════════════════════════════════════════════════════════════════
{
  const dd = `
view: events {
  sql_table_name: CSA.TJ.ORDER_FACT ;;
  dimension: created_at { type: date sql: \${TABLE}.CREATED_AT ;; }
  dimension_group: created { type: time timeframes: [raw, month] sql: \${TABLE}.CREATED_AT ;; }
  measure: last_created { type: date_time sql: MAX(\${created_raw}) ;; }
}`;
  const { model } = await convert([{ name: 'events.view.lkml', content: dd }]);
  const el = allEls(model)[0];
  const ids = (el?.columns || []).map(c => c.id);
  check('dedupe: no duplicate column ids when a dim already owns the physical col',
    new Set(ids).size === ids.length, JSON.stringify(ids));
  const lc = (el?.metrics || []).find(m => m.name === 'Last Created');
  // sigmaDisplayName(CREATED_AT) = "Created at" (Sigma-exact friendly naming).
  check('dedupe: MAX(${created_raw}) resolves through dimPhysColMap → Max([Created at])',
    !!lc && lc.formula === 'Max([Created at])', lc && lc.formula);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
