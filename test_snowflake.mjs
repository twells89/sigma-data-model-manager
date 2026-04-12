import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';

const SNOW_FILE = '/Users/tjwells/Desktop/Converter Files/retail_analytics_snowflake (1).yaml';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('file:///private/tmp/sigma-data-model-manager/index.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 600));

const yaml = readFileSync(SNOW_FILE, 'utf8');
console.log(`Loaded Snowflake YAML: ${yaml.split('\n').length} lines`);

// Load into Snowflake converter and run
await page.evaluate(text => {
  document.getElementById('snowYamlInput').value = text;
}, yaml);
await new Promise(r => setTimeout(r, 100));

await page.evaluate(() => runSnowConversion());
await new Promise(r => setTimeout(r, 400));

const output = await page.evaluate(() => document.getElementById('snowJsonOutput').value);

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

  // 3. No ::TYPE casts
  const castMatch = jsonStr.match(/::[a-zA-Z]+/);
  if (!castMatch) pass.push('no ::TYPE casts');
  else fail.push(`::TYPE cast in output: ${castMatch[0]}`);

  // 4. Multiple elements (file has 6 tables)
  if (elements.length >= 4) pass.push(`${elements.length} elements (≥4 of 6 tables)`);
  else fail.push(`only ${elements.length} elements — expected ≥4 from 6-table file`);

  // 5. Each element has columns
  const withCols = elements.filter(e => (e.columns?.length || 0) > 0);
  if (withCols.length === elements.length) pass.push(`all ${elements.length} elements have columns`);
  else fail.push(`${elements.length - withCols.length} elements have no columns`);

  // 6. Relationships present (file has relationships between tables)
  const hasRels = elements.some(e => (e.relationships?.length || 0) > 0);
  if (hasRels) pass.push('relationships generated from Cortex Analyst relationships');
  else fail.push('no relationships found');

  // 7. Column names use Title Case (not UPPER_SNAKE_CASE)
  const allColNames = elements.flatMap(e => (e.columns || []).map(c => c.name || ''));
  const hasUpperSnake = allColNames.some(n => /^[A-Z][A-Z_]+$/.test(n));
  if (!hasUpperSnake) pass.push('column names in Title Case');
  else {
    const ex = allColNames.find(n => /^[A-Z][A-Z_]+$/.test(n));
    fail.push(`UPPER_SNAKE_CASE column name: ${ex}`);
  }

  // 8. Source references use display names
  const allFormulas = elements.flatMap(e => (e.columns || []).map(c => c.formula || ''));
  const hasUpperRef = allFormulas.some(f => /\[[A-Z]+\/[A-Z_]{3,}\]/.test(f));
  if (!hasUpperRef) pass.push('formula column refs use Title Case display names');
  else {
    const ex = allFormulas.find(f => /\[[A-Z]+\/[A-Z_]{3,}\]/.test(f));
    fail.push(`UPPERCASE column ref in formula: ${ex}`);
  }

  // 9. Time dimension columns present (Cortex Analyst has time_dimensions)
  const hasDateCol = elements.some(e =>
    (e.columns || []).some(c => /date|time|day|month|year/i.test(c.name || ''))
  );
  if (hasDateCol) pass.push('time/date dimension columns present');
  else fail.push('no date/time columns found');

  // 10. No SQL keywords in formulas
  const hasSqlKeyword = allFormulas.some(f => /\b(SELECT|FROM|WHERE|JOIN)\b/i.test(f));
  if (!hasSqlKeyword) pass.push('no SQL keywords in formulas');
  else {
    const ex = allFormulas.find(f => /\b(SELECT|FROM|WHERE)\b/i.test(f));
    fail.push(`SQL keyword in formula: ${ex?.slice(0, 60)}`);
  }
}

console.log('\nSNOWFLAKE CORTEX ANALYST CONVERTER TEST');
console.log('─'.repeat(50));
pass.forEach(p => console.log(`  ✓ ${p}`));
fail.forEach(f => console.log(`  ✗ ${f}`));
console.log('─'.repeat(50));
console.log(`RESULT: ${fail.length === 0 ? 'ALL PASS ✓' : 'FAILURES ✗'} (${pass.length} passed, ${fail.length} failed)`);

await browser.close();
if (fail.length > 0) process.exit(1);
