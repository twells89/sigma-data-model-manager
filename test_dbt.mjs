import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';

const DBT_FILE = '/Users/tjwells/Desktop/Converter Files/retail_analytics_dbt (1).yml';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('file:///private/tmp/sigma-data-model-manager/index.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 600));

const yaml = readFileSync(DBT_FILE, 'utf8');
console.log(`Loaded dbt YAML: ${yaml.split('\n').length} lines`);

// Load into dbt textarea and convert
await page.evaluate(text => {
  document.getElementById('dbtYamlInput').value = text;
}, yaml);
await new Promise(r => setTimeout(r, 100));

await page.evaluate(() => runDbtConversion());
await new Promise(r => setTimeout(r, 500));

const output = await page.evaluate(() => document.getElementById('dbtJsonOutput').value);

let parsed = null;
try { parsed = JSON.parse(output); } catch(e) {}

const pass = [], fail = [];

// 1. Valid JSON
if (parsed) pass.push('valid JSON');
else { fail.push(`invalid JSON: ${output.slice(0, 100)}`); }

if (parsed) {
  const elements = parsed.pages?.[0]?.elements || [];
  const jsonStr = JSON.stringify(parsed);

  // 2. No double brackets
  if (!jsonStr.includes('[[')) pass.push('no double brackets');
  else {
    const ex = (jsonStr.match(/\[\[[^\]]+\]\]/g) || []).slice(0, 3).join(', ');
    fail.push(`double brackets: ${ex}`);
  }

  // 3. No ::TYPE casts in formulas
  const castMatch = jsonStr.match(/::[a-zA-Z]+/);
  if (!castMatch) pass.push('no ::TYPE casts');
  else fail.push(`::TYPE cast in output: ${castMatch[0]}`);

  // 4. Has elements
  if (elements.length > 0) pass.push(`${elements.length} elements`);
  else fail.push('no elements generated');

  const allFormulas = elements.flatMap(e => [
    ...(e.columns || []).map(c => c.formula || ''),
    ...(e.metrics || []).map(m => m.formula || ''),
  ]);

  // 5. Metrics present (dbt file has 6 metrics including ratio type)
  const metElements = elements.filter(e => (e.metrics?.length || 0) > 0);
  if (metElements.length > 0) {
    const totalMets = metElements.reduce((s, e) => s + e.metrics.length, 0);
    pass.push(`${totalMets} metrics across ${metElements.length} elements`);
  } else fail.push('no metrics found');

  // 6. Columns present
  const colElements = elements.filter(e => (e.columns?.length || 0) > 0);
  if (colElements.length > 0) {
    const totalCols = colElements.reduce((s, e) => s + e.columns.length, 0);
    pass.push(`${totalCols} columns across ${colElements.length} elements`);
  } else fail.push('no columns found');

  // 7. Simple measures → Sum/Count/Avg formulas
  const hasSumFormula = allFormulas.some(f => /^Sum\(/.test(f));
  if (hasSumFormula) pass.push('Sum() formulas generated for sum measures');
  else fail.push('no Sum() formula found');

  // 8. Ratio metric produces a formula (not blank)
  // Ratio type: gross_margin_rate = gross_profit / gross_revenue
  const ratioMetric = elements.flatMap(e => e.metrics || []).find(m =>
    /margin|rate|pct|percent/i.test(m.name || '') && m.formula && m.formula.includes('/')
  );
  if (ratioMetric) pass.push(`ratio metric present: "${ratioMetric.name}" = ${ratioMetric.formula}`);
  else {
    // Check if ratio is there at all by looking for division in any metric
    const divMetric = elements.flatMap(e => e.metrics || []).find(m => m.formula && m.formula.includes('/'));
    if (divMetric) pass.push(`division metric: "${divMetric.name}" = ${divMetric.formula}`);
    else fail.push('no ratio/division metric formula found');
  }

  // 9. No SQL keywords surviving in formulas (no SELECT, FROM, WHERE)
  const hasSqlKeyword = allFormulas.some(f => /\b(SELECT|FROM|WHERE|JOIN)\b/i.test(f));
  if (!hasSqlKeyword) pass.push('no SQL keywords in output formulas');
  else {
    const ex = allFormulas.find(f => /\b(SELECT|FROM|WHERE)\b/i.test(f));
    fail.push(`SQL keyword in formula: ${ex?.slice(0, 60)}`);
  }

  // 10. Relationships present (dbt file has multiple semantic models with joins)
  const hasRels = elements.some(e => (e.relationships?.length || 0) > 0);
  if (hasRels) pass.push('relationships generated');
  else fail.push('no relationships found (check semantic model entity definitions)');
}

console.log('\nDBT CONVERTER TEST');
console.log('─'.repeat(50));
pass.forEach(p => console.log(`  ✓ ${p}`));
fail.forEach(f => console.log(`  ✗ ${f}`));
console.log('─'.repeat(50));
console.log(`RESULT: ${fail.length === 0 ? 'ALL PASS ✓' : 'FAILURES ✗'} (${pass.length} passed, ${fail.length} failed)`);

await browser.close();
if (fail.length > 0) process.exit(1);
