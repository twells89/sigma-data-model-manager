import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('file:///private/tmp/sigma-data-model-manager/index.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 600));

const pass = [], fail = [];

function check(label, cond, detail = '') {
  if (cond) pass.push(label);
  else fail.push(label + (detail ? ': ' + detail : ''));
}

// ─── Helper: reset SQL state between sub-tests ───────────────────────────────
async function resetSql() {
  await page.evaluate(() => {
    sqlFiles = [];
    document.getElementById('sqlPasteInput').value = '';
    document.getElementById('sqlStatementSection').style.display = 'none';
    document.getElementById('sqlFileList').innerHTML = '';
    document.getElementById('sqlDatabase').value = '';
    document.getElementById('sqlSchema').value = '';
    document.getElementById('sqlJsonOutput').value = '';
    document.getElementById('sqlWarningBox').style.display = 'none';
  });
}

async function convert(sql, db = '', schema = '') {
  await resetSql();
  await page.evaluate((s, d, sc) => {
    document.getElementById('sqlDatabase').value = d;
    document.getElementById('sqlSchema').value = sc;
    ingestSqlText(s, 'test.sql');
  }, sql, db, schema);
  await new Promise(r => setTimeout(r, 100));
  await page.evaluate(() => runSqlConversion());
  await new Promise(r => setTimeout(r, 200));
  const raw = await page.evaluate(() => document.getElementById('sqlJsonOutput').value);
  try { return JSON.parse(raw); } catch(e) { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. STATEMENT PARSING
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. Statement Parsing ──');

{
  const stmts = await page.evaluate(() => {
    return parseSqlStatements(
      'CREATE VIEW orders AS SELECT id, amount FROM sales.orders;\n' +
      'CREATE OR REPLACE VIEW customers AS SELECT cust_id, name FROM crm.customers;',
      'multi.sql'
    );
  });
  check('parses 2 CREATE VIEW statements', stmts.length === 2, `got ${stmts.length}`);
  check('first stmt name = orders',    stmts[0]?.name === 'orders');
  check('second stmt name = customers', stmts[1]?.name === 'customers');
  check('both type = view', stmts.every(s => s.type === 'view'));
}

{
  const stmts = await page.evaluate(() =>
    parseSqlStatements('SELECT id, amount FROM raw.orders WHERE status = \'complete\'', 'bare.sql')
  );
  check('bare SELECT without CREATE detected as query', stmts.length === 1 && stmts[0].type === 'query');
}

{
  const stmts = await page.evaluate(() =>
    parseSqlStatements(
      'CREATE OR REPLACE TABLE my_db.my_schema.fact_sales AS\nSELECT id, amount FROM raw.sales;',
      't.sql'
    )
  );
  check('CREATE OR REPLACE TABLE parsed',        stmts.length === 1);
  check('schema-qualified name extracted (fact_sales)', stmts[0]?.name === 'fact_sales');
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. SIMPLE SINGLE-TABLE → NATIVE WAREHOUSE-TABLE ELEMENT
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Single-table → warehouse-table ──');

{
  const model = await convert(
    'CREATE VIEW orders AS\nSELECT order_id, customer_id, order_date, total_amount\nFROM ANALYTICS.PUBLIC.ORDERS'
  );
  check('valid JSON',                    model !== null);
  const elements = model?.pages?.[0]?.elements || [];
  check('exactly 1 element',            elements.length === 1, `got ${elements.length}`);
  const el = elements[0];
  check('element name = ORDERS',          el?.name === 'ORDERS');
  check('source kind = warehouse-table', el?.source?.kind === 'warehouse-table');
  check('path = [ANALYTICS, PUBLIC, ORDERS]',
    JSON.stringify(el?.source?.path) === JSON.stringify(['ANALYTICS', 'PUBLIC', 'ORDERS']));
  check('has 4 columns',                 (el?.columns?.length || 0) === 4, `got ${el?.columns?.length}`);
  check('column formulas use [PHYSICAL_TABLE/Column] format',
    (el?.columns || []).every(c => /^\[ORDERS\//.test(c.formula || '')));
  check('no relationships on single-table element', !el?.relationships);
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. AUTO-DETECT DATABASE / SCHEMA FROM SQL PATHS
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. Auto-detect db/schema ──');

{
  await resetSql();
  await page.evaluate(() => {
    ingestSqlText(
      'CREATE VIEW a AS SELECT x FROM MYDB.MYSCHEMA.TABLE_A;\n' +
      'CREATE VIEW b AS SELECT y FROM MYDB.MYSCHEMA.TABLE_B;',
      'auto.sql'
    );
  });
  await new Promise(r => setTimeout(r, 100));
  const db  = await page.evaluate(() => document.getElementById('sqlDatabase').value);
  const sch = await page.evaluate(() => document.getElementById('sqlSchema').value);
  check('database auto-detected as MYDB',    db  === 'MYDB',    `got "${db}"`);
  check('schema auto-detected as MYSCHEMA', sch === 'MYSCHEMA', `got "${sch}"`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. JOINS → SEPARATE ELEMENTS + RELATIONSHIPS
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. JOINs → relationships ──');

{
  const model = await convert(`
CREATE VIEW sales_summary AS
SELECT
  o.order_id,
  o.order_date,
  c.customer_name,
  p.product_name,
  SUM(o.amount) AS total_revenue
FROM DB.SCH.ORDERS o
INNER JOIN DB.SCH.CUSTOMERS c ON o.customer_id = c.customer_id
LEFT JOIN DB.SCH.PRODUCTS p ON o.product_id = p.product_id
GROUP BY o.order_id, o.order_date, c.customer_name, p.product_name
`);
  check('valid JSON with JOINs', model !== null);
  const elements = model?.pages?.[0]?.elements || [];
  // Primary + 2 join targets
  check('3 elements (primary + 2 join targets)', elements.length === 3, `got ${elements.length}`);

  // Primary element is named after the physical table (ORDERS), not the SQL view (sales_summary)
  const primary = elements.find(e => e.name === 'ORDERS');
  check('primary element named after physical table (ORDERS)', !!primary);
  check('primary source = warehouse-table',    primary?.source?.kind === 'warehouse-table');
  check('primary path = DB.SCH.ORDERS',
    JSON.stringify(primary?.source?.path) === JSON.stringify(['DB', 'SCH', 'ORDERS']));

  // Relationships
  const rels = primary?.relationships || [];
  check('2 relationships on primary element', rels.length === 2, `got ${rels.length}`);
  check('every relationship has id',              rels.every(r => !!r.id));
  check('every relationship has keys array',       rels.every(r => Array.isArray(r.keys) && r.keys.length > 0));
  check('every relationship has targetElementId',  rels.every(r => !!r.targetElementId));
  check('every relationship has name',             rels.every(r => !!r.name));
  check('every relationship has relationshipType = N:1', rels.every(r => r.relationshipType === 'N:1'));

  // Join types
  const innerRel = rels.find(r => r.name === 'Customers');
  const leftRel  = rels.find(r => r.name === 'Products');
  // joinType not stored in relationship per schema — keys/targetElementId are the join wiring
  check('customers element exists',  elements.some(e => e.name === 'CUSTOMERS'));
  check('products element exists',   elements.some(e => e.name === 'PRODUCTS'));

  // FK key columns wired (sourceColumnId / targetColumnId present in keys)
  const firstKeys = rels[0]?.keys || [];
  check('keys[0] has sourceColumnId', !!firstKeys[0]?.sourceColumnId);
  check('keys[0] has targetColumnId', !!firstKeys[0]?.targetColumnId);
  check('sourceColumnId starts with inode-', firstKeys[0]?.sourceColumnId?.startsWith('inode-'));
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. AGGREGATE FUNCTIONS → METRICS
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 5. Aggregates → metrics ──');

{
  const model = await convert(`
CREATE VIEW revenue_summary AS
SELECT
  store_id,
  product_id,
  SUM(revenue)       AS total_revenue,
  COUNT(order_id)    AS order_count,
  AVG(order_value)   AS avg_order_value,
  MIN(order_date)    AS first_order,
  MAX(order_date)    AS last_order
FROM ANALYTICS.SALES.FACT_ORDERS
GROUP BY store_id, product_id
`);
  check('valid JSON with aggregates', model !== null);
  const elements = model?.pages?.[0]?.elements || [];
  const el = elements[0];
  const metrics = el?.metrics || [];

  check('5 metrics extracted',              metrics.length === 5, `got ${metrics.length}`);
  check('SUM → Sum([...]) formula',         metrics.some(m => /^Sum\(/.test(m.formula || '')));
  check('COUNT → CountIf(IsNotNull([...]))', metrics.some(m => /^CountIf\(IsNotNull/.test(m.formula || '')));
  check('AVG → Avg([...])',                  metrics.some(m => /^Avg\(/.test(m.formula || '')));
  check('MIN → Min([...])',                  metrics.some(m => /^Min\(/.test(m.formula || '')));
  check('MAX → Max([...])',                  metrics.some(m => /^Max\(/.test(m.formula || '')));
  check('every metric has id',              metrics.every(m => m.id?.startsWith('inode-')));
  check('every metric has name',            metrics.every(m => !!m.name));
  // Non-aggregate SELECT columns go to columns, not metrics
  check('store_id, product_id in columns', (el?.columns?.length || 0) >= 2);
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. COMPLEX MULTI-AGGREGATE → TODO PLACEHOLDER (no garbled formulas)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 6. Complex metrics → TODO placeholder ──');

{
  const model = await convert(`
CREATE VIEW kpi_summary AS
SELECT
  store_id,
  SUM(revenue)                                                    AS gross_revenue,
  ROUND(SUM(revenue) / NULLIF(COUNT(DISTINCT order_id), 0), 2)   AS avg_order_value,
  ROUND(SUM(profit) / NULLIF(SUM(revenue), 0) * 100, 2)          AS gross_margin_pct
FROM ANALYTICS.SALES.ORDERS
GROUP BY store_id
`);
  check('valid JSON with complex metrics', model !== null);
  const el = model?.pages?.[0]?.elements?.[0];
  const metrics = el?.metrics || [];
  check('3 metrics extracted',              metrics.length === 3, `got ${metrics.length}`);

  const simpleMetric = metrics.find(m => m.name === 'Gross Revenue');
  check('simple SUM → Sum([Revenue])',       simpleMetric?.formula === 'Sum([Revenue])');

  const complexMetrics = metrics.filter(m => (m.formula || '').includes('/* TODO'));
  check('2 complex ratio metrics get /* TODO */ placeholder', complexMetrics.length === 2,
    `got ${complexMetrics.length}: ${complexMetrics.map(m => m.name).join(', ')}`);

  // Ensure NO garbled formulas like Sum([Col), 0), 2])
  const garbled = metrics.filter(m => /\)\s*,\s*\d+\s*\]/.test(m.formula || ''));
  check('no garbled formulas with unmatched parens', garbled.length === 0,
    garbled.map(m => m.formula).join('; '));
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. MULTIPLE STATEMENTS → SHARED JOIN-TARGET ELEMENTS
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 7. Multi-statement: shared dimension reuse ──');

{
  const model = await convert(`
CREATE VIEW sales_by_store AS
SELECT s.store_id, s.amount, d.store_name
FROM DB.SCH.SALES s
JOIN DB.SCH.STORE_DIM d ON s.store_id = d.store_id;

CREATE VIEW returns_by_store AS
SELECT r.store_id, r.return_amount, d.store_name
FROM DB.SCH.RETURNS r
JOIN DB.SCH.STORE_DIM d ON r.store_id = d.store_id;
`);
  check('valid JSON with 2 statements + shared dim', model !== null);
  const elements = model?.pages?.[0]?.elements || [];
  // 2 primary + 1 shared STORE_DIM (not 4)
  check('3 elements (2 primary + 1 shared STORE_DIM)', elements.length === 3, `got ${elements.length}`);
  check('STORE_DIM appears exactly once',
    elements.filter(e => e.name === 'STORE_DIM').length === 1);
  check('both primaries have a relationship to the same STORE_DIM element', (() => {
    const dim = elements.find(e => e.name === 'STORE_DIM');
    if (!dim) return false;
    const primaries = elements.filter(e => e.name !== 'STORE_DIM');
    return primaries.every(p =>
      (p.relationships || []).some(r => r.targetElementId === dim.id)
    );
  })());
}

// ══════════════════════════════════════════════════════════════════════════════
// 8. SUBQUERY / COMPLEX FROM → SQL FALLBACK ELEMENT
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 8. Complex FROM → SQL fallback ──');

{
  const model = await convert(`
CREATE VIEW complex_view AS
SELECT a.id, a.val
FROM (SELECT id, val FROM raw.table1 WHERE active = 1) a
`);
  check('valid JSON for subquery input', model !== null);
  const el = model?.pages?.[0]?.elements?.[0];
  check('subquery → SQL element fallback', el?.source?.kind === 'sql');
  check('SQL element has statement',       !!el?.source?.statement);
}

// ══════════════════════════════════════════════════════════════════════════════
// 9. RELATIONSHIP SCHEMA INTEGRITY
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 9. Relationship schema integrity ──');

{
  const model = await convert(`
CREATE VIEW orders_enriched AS
SELECT o.order_id, o.amount, c.name
FROM PROD.DW.ORDERS o
JOIN PROD.DW.CUSTOMERS c ON o.cust_id = c.cust_id
`);
  const elements = model?.pages?.[0]?.elements || [];
  const primary  = elements.find(e => e.source?.path?.[2] === 'ORDERS');
  const rel      = (primary?.relationships || [])[0];

  check('relationship id is non-empty string',  typeof rel?.id === 'string' && rel.id.length > 0);
  check('relationship has no joinType field (not part of schema)', !('joinType' in (rel || {})));
  check('relationship has no columnPairs field (renamed to keys)', !('columnPairs' in (rel || {})));
  check('relationshipType is N:1',               rel?.relationshipType === 'N:1');
  check('keys is array with 1 entry',            Array.isArray(rel?.keys) && rel?.keys?.length === 1);
  check('sourceColumnId is inode format',        /^inode-/.test(rel?.keys?.[0]?.sourceColumnId || ''));
  check('targetColumnId is inode format',        /^inode-/.test(rel?.keys?.[0]?.targetColumnId || ''));
}

// ══════════════════════════════════════════════════════════════════════════════
// 10. DB/SCHEMA OVERRIDES APPLIED TO BARE TABLE NAMES
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 10. DB/schema overrides ──');

{
  const model = await convert(
    'CREATE VIEW v AS SELECT id, name FROM CUSTOMERS',
    'MYDB', 'PUBLIC'
  );
  const el = model?.pages?.[0]?.elements?.[0];
  check('bare table gets db+schema prefix',
    JSON.stringify(el?.source?.path) === JSON.stringify(['MYDB', 'PUBLIC', 'CUSTOMERS']));
}

{
  const model = await convert(
    'CREATE VIEW v AS SELECT id FROM MYSCHEMA.USERS',
    'MYDB', ''
  );
  const el = model?.pages?.[0]?.elements?.[0];
  check('schema.table gets db prepended when db override set',
    JSON.stringify(el?.source?.path) === JSON.stringify(['MYDB', 'MYSCHEMA', 'USERS']));
}

// ══════════════════════════════════════════════════════════════════════════════
// 11. COLUMN FORMULA FORMAT: [ElementName/Column] self-reference
// ══════════════════════════════════════════════════════════════════════════════
// Sigma warehouse-table columns use [ElementName/ColumnDisplay] — a self-reference.
// Bare [Column] can't resolve against the physical warehouse schema.
// The prefix must match the element's OWN name (not the physical table display name).
console.log('\n── 11. Column formula format: [ElementName/Column] ──');

{
  // Physical table is FACT_ORDERS → element named "FACT_ORDERS" regardless of view name
  const model = await convert(
    'CREATE VIEW any_view_name AS SELECT order_id, total_amount FROM ANALYTICS.PUBLIC.FACT_ORDERS'
  );
  const el = model?.pages?.[0]?.elements?.[0];
  const cols = el?.columns || [];
  check('element named after physical table (FACT_ORDERS)', el?.name === 'FACT_ORDERS');
  check('columns present',                         cols.length >= 2, `got ${cols.length}`);
  // Formula prefix = raw physical table name (uppercase, underscores), NOT the display name
  check('order_id col = [FACT_ORDERS/Order Id]',   cols.some(c => c.formula === '[FACT_ORDERS/Order Id]'));
  check('total_amount col = [FACT_ORDERS/Total Amount]',
    cols.some(c => c.formula === '[FACT_ORDERS/Total Amount]'));
  check('all formulas use raw table name as prefix (e.g. FACT_ORDERS)',
    cols.every(c => /^\[FACT_ORDERS\//.test(c.formula || '')),
    cols.map(c => c.formula).join(', '));
}

// FK key columns on dimension elements also use self-referencing [ElementName/Column]
{
  const model = await convert(`
CREATE VIEW orders_enriched AS
SELECT o.order_id, c.name
FROM PROD.DW.ORDERS o
JOIN PROD.DW.CUSTOMERS c ON o.cust_id = c.cust_id
`);
  const elements = model?.pages?.[0]?.elements || [];
  const dimElem = elements.find(e => e.name === 'CUSTOMERS');
  check('dimension element exists',            !!dimElem);
  const dimCols = dimElem?.columns || [];
  check('dim FK col = [CUSTOMERS/Cust Id]',
    dimCols.some(c => c.formula === '[CUSTOMERS/Cust Id]'),
    dimCols.map(c => c.formula).join(', '));
  // Primary table is ORDERS → element named "ORDERS"
  check('primary FK col = [ORDERS/Cust Id]',
    (model?.pages?.[0]?.elements?.find(e => e.name === 'ORDERS')?.columns || [])
      .some(c => c.formula === '[ORDERS/Cust Id]'));
}

// ══════════════════════════════════════════════════════════════════════════════
// 12. METRIC SOURCE COLUMNS ADDED TO ELEMENT
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 12. Metric source columns present in element ──');

{
  const model = await convert(`
CREATE VIEW revenue_by_store AS
SELECT
  store_id,
  SUM(gross_revenue)     AS total_revenue,
  COUNT(order_id)        AS order_count,
  AVG(avg_basket_size)   AS avg_basket
FROM ANALYTICS.SALES.FACT_ORDERS
GROUP BY store_id
`);
  const el = model?.pages?.[0]?.elements?.[0];
  const cols = el?.columns || [];
  const colFormulas = cols.map(c => c.formula);

  // The inner columns referenced by each metric must exist in el.columns
  // with [ElementName/Column] self-reference format
  // Element name = "FACT_ORDERS" (raw physical table name)
  // Formula prefix = raw physical name (self-reference)
  check('gross_revenue column = [FACT_ORDERS/Gross Revenue]',
    colFormulas.some(f => f === '[FACT_ORDERS/Gross Revenue]'),
    'found: ' + colFormulas.join(', '));
  check('order_id column = [FACT_ORDERS/Order Id]',
    colFormulas.some(f => f === '[FACT_ORDERS/Order Id]'),
    'found: ' + colFormulas.join(', '));
  check('avg_basket_size column = [FACT_ORDERS/Avg Basket Size]',
    colFormulas.some(f => f === '[FACT_ORDERS/Avg Basket Size]'),
    'found: ' + colFormulas.join(', '));

  // Metrics themselves should still reference display names without table prefix
  const metrics = el?.metrics || [];
  check('Sum metric formula = Sum([Gross Revenue])',
    metrics.some(m => m.formula === 'Sum([Gross Revenue])'));
  check('CountIf metric formula = CountIf(IsNotNull([Order Id]))',
    metrics.some(m => m.formula === 'CountIf(IsNotNull([Order Id]))'));
  check('Avg metric formula = Avg([Avg Basket Size])',
    metrics.some(m => m.formula === 'Avg([Avg Basket Size])'));
}

// ══════════════════════════════════════════════════════════════════════════════
// 13. JOIN COLUMN ATTRIBUTION: [PRIMARY/DIM/Column] via alias prefix
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 13. Join column attribution ──');

{
  const model = await convert(`
CREATE VIEW sales_detail AS
SELECT
  o.order_id,
  o.amount,
  c.customer_name,
  c.email         AS customer_email,
  d.date_label
FROM DB.SCH.ORDERS o
JOIN DB.SCH.CUSTOMERS c ON o.cust_id = c.cust_id
JOIN DB.SCH.DATE_DIM d  ON o.date_key = d.date_key
`);
  check('valid JSON', model !== null);
  const elems = model?.pages?.[0]?.elements || [];
  const el = elems.find(e => e.name === 'ORDERS');
  const cols = el?.columns || [];
  const formulas = cols.map(c => c.formula);

  // Primary table columns → [ORDERS/Column]
  check('order_id → [ORDERS/Order Id]',
    formulas.some(f => f === '[ORDERS/Order Id]'));
  check('amount → [ORDERS/Amount]',
    formulas.some(f => f === '[ORDERS/Amount]'));

  // Dim-attributed columns do NOT appear on the primary element (Sigma warehouse validator rejects them)
  check('primary has no cross-element Customer Name formula',
    !formulas.some(f => f.includes('Customer Name')));
  check('primary has no cross-element Date Label formula',
    !formulas.some(f => f.includes('Date Label')));

  // Dimension elements have the SELECT columns in their own columns array
  const custElem = elems.find(e => e.name === 'CUSTOMERS');
  const custCols  = (custElem?.columns || []).map(c => c.formula);
  check('CUSTOMERS elem has [CUSTOMERS/Customer Name]',
    custCols.some(f => f === '[CUSTOMERS/Customer Name]'));
  check('CUSTOMERS elem has [CUSTOMERS/Email]',
    custCols.some(f => f === '[CUSTOMERS/Email]'));

  const dateDimElem = elems.find(e => e.name === 'DATE_DIM');
  const dateCols    = (dateDimElem?.columns || []).map(c => c.formula);
  check('DATE_DIM elem has [DATE_DIM/Date Label]',
    dateCols.some(f => f === '[DATE_DIM/Date Label]'));
}

// ══════════════════════════════════════════════════════════════════════════════
// RESULTS
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nSQL CONVERTER TEST');
console.log('─'.repeat(50));
pass.forEach(p => console.log(`  ✓ ${p}`));
fail.forEach(f => console.log(`  ✗ ${f}`));
console.log('─'.repeat(50));
console.log(`RESULT: ${fail.length === 0 ? 'ALL PASS ✓' : 'FAILURES ✗'} (${pass.length} passed, ${fail.length} failed)`);

await browser.close();
if (fail.length > 0) process.exit(1);
