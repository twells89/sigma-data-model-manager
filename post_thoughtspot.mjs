import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';

const FILE    = '/Users/tjwells/Desktop/Converter Files/retail_analytics_thoughtspot.tml';
const BASE    = process.env.SIGMA_BASE_URL   || 'https://aws-api.sigmacomputing.com';
const CID     = process.env.SIGMA_CLIENT_ID;
const CSEC    = process.env.SIGMA_CLIENT_SECRET;
const MODEL_NAME = 'Retail Analytics (TS Import)';

if (!CID || !CSEC) { console.error('Missing SIGMA_CLIENT_ID / SIGMA_CLIENT_SECRET env vars'); process.exit(1); }

// ── 1. Convert via browser ─────────────────────────────────────────────────
console.log('Step 1: Converting TML via browser converter…');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page    = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('file:///private/tmp/sigma-data-model-manager/index.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 600));

const tml = readFileSync(FILE, 'utf8');
await page.evaluate((tmlText) => {
  document.getElementById('tsYamlInput').value = tmlText;
  runThoughtSpotConversion();
}, tml);
await new Promise(r => setTimeout(r, 500));

const rawOutput = await page.evaluate(() => document.getElementById('tsJsonOutput').value);
await browser.close();

let fullSpec;
try   { fullSpec = JSON.parse(rawOutput); }
catch { console.error('Converter did not produce valid JSON:\n', rawOutput.slice(0, 200)); process.exit(1); }

console.log(`  ✓ Converted — ${fullSpec.pages?.[0]?.elements?.length} elements`);

// ── 2. Authenticate ────────────────────────────────────────────────────────
console.log('Step 2: Authenticating with Sigma API…');
const authResp = await fetch(`${BASE}/v2/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CSEC }),
});
if (!authResp.ok) { console.error('Auth failed:', await authResp.text()); process.exit(1); }
const { access_token: token } = await authResp.json();
console.log('  ✓ Authenticated');

const sigmaFetch = (path, opts = {}) => fetch(`${BASE}${path}`, {
  ...opts,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

// ── 3. Find connection ID for CSA ─────────────────────────────────────────
console.log('Step 3: Finding Snowflake/CSA connection…');
const connResp = await sigmaFetch('/v2/connections');
const connData = await connResp.json();
const connections = connData.entries || connData.connections || [];
// Prefer any connection that references CSA or Snowflake
// "ymb68310" is the Snowflake account that hosts CSA.TJ; use the non-OAuth connection
const conn = connections.find(c => c.name === 'ymb68310')
          || connections.find(c => /CSA|snowflake/i.test(c.name))
          || connections[0];
if (!conn) { console.error('No connections found:', JSON.stringify(connData).slice(0, 200)); process.exit(1); }
console.log(`  ✓ Using connection: "${conn.name}" (${conn.connectionId || conn.id})`);
const connectionId = conn.connectionId || conn.id;

// Patch placeholder connection IDs in spec
const specStr = JSON.stringify(fullSpec).replace(/<CONNECTION_ID>/g, connectionId);
fullSpec = JSON.parse(specStr);

// ── 3c. Find a workspace folder ───────────────────────────────────────────
console.log('Step 3c: Finding workspace folder…');
const foldersResp = await sigmaFetch('/v2/files?typeFilters=folder');
const foldersData = await foldersResp.json();
const folders = foldersData.entries || foldersData.files || [];
const folder = folders.find(f => /my doc|personal|home/i.test(f.name)) || folders[0];
if (!folder) { console.error('No folders found:', JSON.stringify(foldersData).slice(0, 200)); process.exit(1); }
console.log(`  ✓ Using folder: "${folder.name}" (${folder.id})`);
const folderId = folder.id;

// ── 4. POST without relationships ─────────────────────────────────────────
console.log('Step 4: POST spec (no relationships)…');
const pagesNoRels = JSON.parse(JSON.stringify(fullSpec.pages)).map(pg => ({
  ...pg,
  elements: (pg.elements || []).map(({ relationships, ...rest }) => rest),
}));

const postResp = await sigmaFetch('/v2/dataModels/spec', {
  method: 'POST',
  body: JSON.stringify({ schemaVersion: 1, name: MODEL_NAME, folderId, pages: pagesNoRels }),
});
if (!postResp.ok) {
  const t = await postResp.text();
  console.error('POST failed:', t);
  process.exit(1);
}
const { dataModelId } = await postResp.json();
console.log(`  ✓ Created data model — id: ${dataModelId}`);

// ── 4. GET saved spec for server-assigned IDs ─────────────────────────────
console.log('Step 4: GET saved spec for server IDs…');
const getResp = await sigmaFetch(`/v2/dataModels/${dataModelId}/spec`);
if (!getResp.ok) { console.error('GET failed:', await getResp.text()); process.exit(1); }
const savedSpec = await getResp.json();

// Build formula → server colId maps
const savedElFormulaMap = {};
(savedSpec.pages || []).forEach((pg, pi) => {
  (pg.elements || []).forEach((el, ei) => {
    (el.columns || []).forEach(col => {
      if (col.formula) savedElFormulaMap[`${pi}|${ei}|${col.formula}`] = col.id;
    });
  });
});

// local colId → { pi, ei, formula }
const localColInfo = {};
(fullSpec.pages || []).forEach((pg, pi) => {
  (pg.elements || []).forEach((el, ei) => {
    (el.columns || []).forEach(col => {
      if (col.id) localColInfo[col.id] = { pi, ei, formula: col.formula };
    });
  });
});

// element ID remap by position
const elemIdRemap = {};
(fullSpec.pages || []).forEach((origPg, pi) => {
  const savedPg = (savedSpec.pages || [])[pi];
  if (!savedPg) return;
  (origPg.elements || []).forEach((origEl, ei) => {
    const savedEl = (savedPg.elements || [])[ei];
    if (savedEl) elemIdRemap[origEl.id] = savedEl.id;
  });
});

const remapColId = (localColId) => {
  const info = localColInfo[localColId];
  if (!info) return localColId;
  const key = `${info.pi}|${info.ei}`;
  if (info.formula) return savedElFormulaMap[`${key}|${info.formula}`] || localColId;
  return localColId;
};

// ── 5. PUT with remapped relationships ────────────────────────────────────
console.log('Step 5: PUT spec with relationships…');
const savedSpecWithRels = JSON.parse(JSON.stringify(savedSpec));
(fullSpec.pages || []).forEach((origPg, pi) => {
  const savedPg = (savedSpecWithRels.pages || [])[pi];
  if (!savedPg) return;
  (origPg.elements || []).forEach((origEl, ei) => {
    if (!origEl.relationships?.length) return;
    const savedEl = (savedPg.elements || [])[ei];
    if (!savedEl) return;
    savedEl.relationships = origEl.relationships.map(rel => ({
      ...rel,
      targetElementId: elemIdRemap[rel.targetElementId] || rel.targetElementId,
      keys: (rel.keys || []).map(k => ({
        ...k,
        sourceColumnId: remapColId(k.sourceColumnId),
        targetColumnId: remapColId(k.targetColumnId),
      })),
    }));
  });
});

const putResp = await sigmaFetch(`/v2/dataModels/${dataModelId}/spec`, {
  method: 'PUT',
  body: JSON.stringify({ schemaVersion: 1, name: MODEL_NAME, pages: savedSpecWithRels.pages }),
});
if (!putResp.ok) {
  const t = await putResp.text();
  console.error('PUT (relationships) failed:', t);
  console.log(`  ⚠ Model created at id=${dataModelId} but relationships not saved`);
  process.exit(1);
}
console.log('  ✓ Relationships saved');

// ── 6. Confirm final state ─────────────────────────────────────────────────
const finalResp = await sigmaFetch(`/v2/dataModels/${dataModelId}/spec`);
const finalSpec = await finalResp.json();
const relCount  = (finalSpec.pages?.[0]?.elements || []).reduce((n, el) => n + (el.relationships?.length || 0), 0);
console.log(`\n✅ Done — data model "${MODEL_NAME}" saved to Sigma`);
console.log(`   dataModelId : ${dataModelId}`);
console.log(`   elements    : ${finalSpec.pages?.[0]?.elements?.length}`);
console.log(`   relationships: ${relCount}`);
