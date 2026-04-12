import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';

const BASE = '/Users/tjwells/Desktop/Converter Files/Looker';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('file:///private/tmp/sigma-data-model-manager/index.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 600));

// ── Load all 8 LookML files into lookProject ─────────────────────────────────
const files = [
  'retail_analytics.model.lkml',
  'order_fact_view.lkml',
  'customer_dim_view.lkml',
  'date_dim_view.lkml',
  'product_dim_view.lkml',
  'promo_dim_view.lkml',
  'store_dim_view.lkml',
  'monthly_summary_derived_view.lkml',
];

for (const fname of files) {
  const text = readFileSync(`${BASE}/${fname}`, 'utf8');
  const isModel = fname.includes('.model.');
  await page.evaluate(({ text, isModel, fname }) => {
    const parsed = parseLookML(text);
    if (isModel) {
      lookProject.modelName = fname;
      parsed.explores.forEach(ex => { lookProject.explores[ex._name] = ex; });
    }
    parsed.views.forEach(v => { lookProject.views[v._name] = v; });
  }, { text, isModel, fname });
}

await page.evaluate(() => {
  resolveLookExtendsAndRefinements();
  renderLookExplores();
});
await new Promise(r => setTimeout(r, 200));

const explores = await page.evaluate(() => Object.keys(lookProject.explores));
console.log(`Loaded ${explores.length} explores: ${explores.join(', ')}`);
console.log(`Loaded ${Object.keys(await page.evaluate(() => lookProject.views)).length} views`);

const results = {};
let totalPass = 0, totalFail = 0;

// ── Convert each explore ──────────────────────────────────────────────────────
for (const exploreName of explores) {
  await page.evaluate(name => {
    document.getElementById('lookExploreSelect').value = name;
  }, exploreName);
  await new Promise(r => setTimeout(r, 50));

  await page.evaluate(() => runLookConversion());
  await new Promise(r => setTimeout(r, 400));

  const output = await page.evaluate(() => document.getElementById('lookJsonOutput').value);

  let parsed = null;
  try { parsed = JSON.parse(output); } catch(e) {}

  const r = { exploreName, pass: [], fail: [] };

  // 1. Valid JSON
  if (parsed) r.pass.push('valid JSON');
  else r.fail.push(`invalid JSON: ${output.slice(0, 80)}`);

  if (parsed) {
    const jsonStr = JSON.stringify(parsed);

    // 2. No double brackets
    if (!jsonStr.includes('[[')) r.pass.push('no double brackets');
    else {
      const ex = (jsonStr.match(/\[\[[^\]]+\]\]/g) || []).slice(0, 3).join(', ');
      r.fail.push(`double brackets found: ${ex}`);
    }

    // 3. No ::TYPE casts remaining in formulas
    const castMatch = jsonStr.match(/::[a-zA-Z]+/);
    if (!castMatch) r.pass.push('no ::TYPE casts');
    else r.fail.push(`::TYPE cast in output: ${castMatch[0]}`);

    // 4. Has elements with columns
    const elements = parsed.pages?.[0]?.elements || [];
    if (elements.length > 0 && elements.some(e => (e.columns?.length || 0) > 0))
      r.pass.push(`${elements.length} elements with columns`);
    else r.fail.push('no elements or no columns');

    // 5. For order_fact explore: check yesno → boolean formula, ROUND/NULLIF, relationships
    if (exploreName === 'order_fact') {
      const allFormulas = elements.flatMap(e => [
        ...(e.columns || []).map(c => c.formula || ''),
        ...(e.metrics || []).map(m => m.formula || ''),
      ]);

      // yesno should produce boolean-style formulas (not raw "= 1" references)
      const hasYesnoCol = elements.some(el =>
        (el.columns || []).some(c => c.formula && /IS_FIRST_ORDER|Is First Order/i.test(c.formula))
      );
      if (hasYesnoCol) r.pass.push('yesno column present');
      else r.fail.push('yesno column not found for Is First Order');

      // ROUND should be converted (Sigma uses Round() — check ALL-CAPS ROUND() is gone)
      const hasRawRound = allFormulas.some(f => /\bROUND\s*\(/.test(f)); // no 'i' flag — uppercase only
      if (!hasRawRound) r.pass.push('ROUND converted to Round()');
      else r.fail.push('unconverted all-caps ROUND() found in formulas');

      // Relationships should exist
      const hasRels = elements.some(e => (e.relationships?.length || 0) > 0);
      if (hasRels) r.pass.push('relationships generated');
      else r.fail.push('no relationships in output');
    }

    // 6. For monthly_revenue_summary (derived table): check no ::DATE in formulas
    if (exploreName === 'monthly_revenue_summary') {
      const allFormulas = elements.flatMap(e => [
        ...(e.columns || []).map(c => c.formula || ''),
        ...(e.metrics || []).map(m => m.formula || ''),
      ]);
      const hasCast = allFormulas.some(f => /::/i.test(f));
      if (!hasCast) r.pass.push('no ::TYPE casts (derived table explore)');
      else r.fail.push('::TYPE cast survived in derived table explore');
    }
  }

  results[exploreName] = r;
  totalPass += r.pass.length;
  totalFail += r.fail.length;

  const status = r.fail.length === 0 ? 'PASS ✓' : 'FAIL ✗';
  console.log(`\n[${status}] explore: ${exploreName}`);
  r.pass.forEach(p => console.log(`  ✓ ${p}`));
  r.fail.forEach(f => console.log(`  ✗ ${f}`));
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`LOOKML CONVERTER: ${totalFail === 0 ? 'ALL PASS ✓' : 'FAILURES FOUND ✗'}`);
console.log(`  ${totalPass} checks passed, ${totalFail} failed`);

await browser.close();
if (totalFail > 0) process.exit(1);
