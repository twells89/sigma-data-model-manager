import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';

const FILES = [
  { path: '/Users/tjwells/Desktop/Converter Files/retail_analytics.twb', name: 'retail_analytics.twb' },
  { path: '/Users/tjwells/Desktop/Converter Files/retail_analytics_sets.tds', name: 'retail_analytics_sets.tds' },
];

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('file:///private/tmp/sigma-data-model-manager/index.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 600));

let totalPass = 0, totalFail = 0;

for (const { path, name } of FILES) {
  const xml = readFileSync(path, 'utf8');
  console.log(`\nTesting: ${name} (${xml.split('\n').length} lines)`);

  // Inject via ingestTableauXml, then run conversion
  await page.evaluate((xmlText, filename) => {
    ingestTableauXml(xmlText, filename);
  }, xml, name);
  await new Promise(r => setTimeout(r, 200));

  // Check how many datasources were found
  const dsCount = await page.evaluate(() =>
    _tableauParsed ? _tableauParsed.datasources.length : 0
  );
  console.log(`  Datasources found: ${dsCount}`);

  if (dsCount === 0) {
    console.log('  ✗ No datasources — skipping conversion');
    totalFail++;
    continue;
  }

  // Convert each datasource
  for (let i = 0; i < dsCount; i++) {
    await page.evaluate(idx => {
      const sel = document.getElementById('tableauDatasourceSelect');
      if (sel) sel.value = idx;
    }, i);

    await page.evaluate(() => runTableauConversion());
    await new Promise(r => setTimeout(r, 300));

    const output = await page.evaluate(() => document.getElementById('tableauJsonOutput').value);
    const dsName = await page.evaluate(i =>
      _tableauParsed.datasources[i]?.name || `datasource_${i}`, i
    );

    let parsed = null;
    try { parsed = JSON.parse(output); } catch(e) {}

    const pass = [], fail = [];

    // 1. Valid JSON
    if (parsed) pass.push('valid JSON');
    else { fail.push(`invalid JSON: ${output.slice(0, 80)}`); }

    if (parsed) {
      const elements = parsed.pages?.[0]?.elements || [];
      const jsonStr = JSON.stringify(parsed);

      // 2. No double brackets
      if (!jsonStr.includes('[[')) pass.push('no double brackets');
      else {
        const ex = (jsonStr.match(/\[\[[^\]]+\]\]/g) || []).slice(0,3).join(', ');
        fail.push(`double brackets: ${ex}`);
      }

      // 3. No ::TYPE casts
      const castMatch = jsonStr.match(/::[a-zA-Z]+/);
      if (!castMatch) pass.push('no ::TYPE casts');
      else fail.push(`::TYPE cast: ${castMatch[0]}`);

      // 4. Has elements with columns
      const withCols = elements.filter(e => (e.columns?.length || 0) > 0);
      if (withCols.length > 0) pass.push(`${elements.length} elements, ${withCols.length} with columns`);
      else fail.push('no elements with columns');

      if (name === 'retail_analytics.twb') {
        const allFormulas = elements.flatMap(e => [
          ...(e.columns || []).map(c => c.formula || ''),
          ...(e.metrics || []).map(m => m.formula || ''),
        ]);

        // 5. ZN() → Coalesce([Col], 0)
        const hasZnConverted = allFormulas.some(f => /Coalesce\s*\(/.test(f));
        const hasRawZn = allFormulas.some(f => /\bZN\s*\(/.test(f));
        if (!hasRawZn && hasZnConverted) pass.push('ZN() converted to Coalesce()');
        else if (hasRawZn) fail.push('unconverted ZN() found');
        else if (!hasZnConverted) fail.push('ZN() not found — check formula translation');

        // 6. CASE WHEN → If()
        const hasCaseRaw = allFormulas.some(f => /\bCASE\b/i.test(f));
        const hasIfFn = allFormulas.some(f => /\bIf\s*\(/.test(f));
        if (!hasCaseRaw && hasIfFn) pass.push('CASE WHEN converted to If()');
        else if (hasCaseRaw) fail.push('unconverted CASE WHEN found');
        else fail.push('no If() found from CASE WHEN conversion');

        // 7. DATETRUNC → DateTrunc()
        const hasDateTrunc = allFormulas.some(f => /\bDateTrunc\s*\(/.test(f));
        const hasRawDateTrunc = allFormulas.some(f => /\bDATETRUNC\s*\(/.test(f)); // no 'i' flag — uppercase only
        if (!hasRawDateTrunc && hasDateTrunc) pass.push('DATETRUNC converted to DateTrunc()');
        else if (hasRawDateTrunc) fail.push('unconverted DATETRUNC found');
        else fail.push('no DateTrunc() found — check formula translation');

        // 8. LOD expression flagged (not converted, produces a warning column)
        const hasLodWarning = elements.some(e =>
          (e.columns || []).some(c => (c.description || '').toLowerCase().includes('lod') ||
            (c.name || '').toLowerCase().includes('lod'))
        );
        const lodInOutput = jsonStr.toLowerCase().includes('lod') || jsonStr.toLowerCase().includes('fixed');
        if (lodInOutput) pass.push('LOD expression present in output (as warning or preserved)');
        else fail.push('LOD expression silently missing from output');

        // 9. SUM() measures converted to Sum()
        const hasSumMeasure = allFormulas.some(f => /^Sum\(/.test(f));
        if (hasSumMeasure) pass.push('SUM measures converted to Sum()');
        else fail.push('no Sum() formula found');
      }

      if (name === 'retail_analytics_sets.tds') {
        // Sets file: check that columns are generated
        const allCols = elements.flatMap(e => e.columns || []);
        if (allCols.length > 0) pass.push(`${allCols.length} columns from sets datasource`);
        else fail.push('no columns from sets datasource');
      }
    }

    const status = fail.length === 0 ? 'PASS ✓' : 'FAIL ✗';
    console.log(`\n  [${status}] datasource: "${dsName}"`);
    pass.forEach(p => console.log(`    ✓ ${p}`));
    fail.forEach(f => console.log(`    ✗ ${f}`));
    totalPass += pass.length;
    totalFail += fail.length;
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`TABLEAU CONVERTER: ${totalFail === 0 ? 'ALL PASS ✓' : 'FAILURES ✗'}`);
console.log(`  ${totalPass} checks passed, ${totalFail} failed`);

await browser.close();
if (totalFail > 0) process.exit(1);
