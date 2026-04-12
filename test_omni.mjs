import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';

const BASE = '/Users/tjwells/Desktop/Converter Files/Omni';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('file:///private/tmp/sigma-data-model-manager/index.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 600));

// ── Load all 8 Omni YAML files ────────────────────────────────────────────────
const viewFiles = [
  'channel_summary.view.yaml',
  'customer_dim.view.yaml',
  'date_dim.view.yaml',
  'order_fact.view.yaml',
  'product_dim.view.yaml',
  'promo_dim.view.yaml',
  'store_dim.view.yaml',
  'retail_analytics.model.yaml',
];

const combinedYaml = viewFiles.map(f => readFileSync(`${BASE}/${f}`, 'utf8')).join('\n---\n');

await page.evaluate(yaml => {
  document.getElementById('omniYamlInput').value = yaml;
}, combinedYaml);
await new Promise(r => setTimeout(r, 100));

// Run conversion
await page.evaluate(() => runOmniConversion());
await new Promise(r => setTimeout(r, 400));

const output = await page.evaluate(() => document.getElementById('omniJsonOutput').value);

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
    fail.push(`double brackets found: ${ex}`);
  }

  // 3. No ::TYPE casts in formulas
  const castMatch = jsonStr.match(/::[a-zA-Z]+/);
  if (!castMatch) pass.push('no ::TYPE casts in formulas');
  else fail.push(`::TYPE cast survived: ${castMatch[0]}`);

  // 4. Has multiple elements (views → elements)
  if (elements.length >= 4) pass.push(`${elements.length} elements generated`);
  else fail.push(`only ${elements.length} elements — expected ≥4`);

  // 5. Custom SQL element uses Title Case column names (NOT UPPERCASE)
  //    channel_summary is a derived_table → Custom SQL element
  const customSqlEl = elements.find(e => e.source?.kind === 'sql' || e.name === 'Channel Summary');
  if (customSqlEl) {
    const allFormulas = (customSqlEl.columns || []).map(c => c.formula || '');
    const hasUpperCase = allFormulas.some(f => /\[Custom SQL\/[A-Z_]{3,}\]/.test(f));
    const hasTitleCase = allFormulas.some(f => /\[Custom SQL\/[A-Z][a-z]/.test(f));

    if (!hasUpperCase && hasTitleCase) pass.push('Custom SQL columns use Title Case (not UPPERCASE)');
    else if (hasUpperCase) {
      const ex = allFormulas.find(f => /\[Custom SQL\/[A-Z_]{3,}\]/.test(f));
      fail.push(`Custom SQL columns still UPPERCASE: e.g. ${ex}`);
    } else if (!hasTitleCase) {
      fail.push(`No Custom SQL title-case refs found. Sample formulas: ${allFormulas.slice(0,3).join(' | ')}`);
    }
  } else {
    fail.push('No Custom SQL element found (expected channel_summary derived table)');
  }

  // 6. IN pattern should use In() function, not "Or" chains
  //    date_dim.retail_season has CASE WHEN MONTH(...) IN (11, 12) THEN...
  const allFormulas = elements.flatMap(e => [
    ...(e.columns || []).map(c => c.formula || ''),
    ...(e.metrics || []).map(m => m.formula || ''),
  ]);

  const hasInFunction = allFormulas.some(f => /\bIn\s*\(/.test(f));
  const hasOrChain   = allFormulas.some(f => / Or /.test(f) && /= \d/.test(f));

  if (hasInFunction) pass.push('IN patterns use In() function');
  else fail.push('No In() function found — IN patterns may not be converted');

  if (!hasOrChain) pass.push('no "expr = a Or expr = b" chains (In() used instead)');
  else fail.push('old-style "Or" chain still present from IN pattern');

  // 7. CASE WHEN → If() conversion (date_dim.retail_season)
  const hasCaseRaw = allFormulas.some(f => /\bCASE\b/i.test(f));
  const hasIfFn    = allFormulas.some(f => /\bIf\s*\(/.test(f));
  if (!hasCaseRaw && hasIfFn) pass.push('CASE WHEN converted to If()');
  else if (hasCaseRaw) fail.push('unconverted CASE WHEN found in formulas');
  else fail.push('no If() found — CASE WHEN may not be converted');

  // 8. yesno → boolean formula (order_fact: IS_FIRST_ORDER = 1)
  const hasYesnoFormula = allFormulas.some(f => /IS_FIRST_ORDER|Is First Order/i.test(f));
  if (hasYesnoFormula) pass.push('yesno column present (Is First Order)');
  else fail.push('yesno column for Is First Order not found');

  // 9. Filtered measure (order_fact online_revenue uses filters: block → SumIf)
  const hasSumIf = allFormulas.some(f => /SumIf\s*\(/.test(f));
  const hasMeasureFilters = allFormulas.some(f => /SumIf|CountIf|AvgIf/.test(f));
  if (hasMeasureFilters) pass.push('filtered measures use conditional aggregates (SumIf/CountIf)');
  else fail.push('no SumIf/CountIf found — filtered measures may not be handled');

  // 10. Relationships between elements (from model.yaml explores)
  const hasRels = elements.some(e => (e.relationships?.length || 0) > 0);
  if (hasRels) pass.push('relationships generated from explores');
  else fail.push('no relationships found');

  // 11. Metrics array on fact element
  const hasMet = elements.some(e => (e.metrics?.length || 0) > 0);
  if (hasMet) pass.push('metrics array present');
  else fail.push('no metrics found');
}

console.log('\nOMNI CONVERTER TEST');
console.log('─'.repeat(50));
pass.forEach(p => console.log(`  ✓ ${p}`));
fail.forEach(f => console.log(`  ✗ ${f}`));
console.log('─'.repeat(50));
console.log(`RESULT: ${fail.length === 0 ? 'ALL PASS ✓' : 'FAILURES ✗'} (${pass.length} passed, ${fail.length} failed)`);

await browser.close();
if (fail.length > 0) process.exit(1);
