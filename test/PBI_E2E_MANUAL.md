# Manual Puppeteer + Sigma E2E — Power BI converter (run before merging fix/pbi-j89-tkd)

The JSDOM harness (`test/pbi-fix.jsdom.test.mjs`) proves the converter *logic* in
`runPbiConversion` (paths auto-derived, base elements named, `schemaVersion: 1`)
without a real browser or a live Sigma org. Before merging, also run the real
e2e the team requires (Puppeteer drives the actual page, posts to Sigma, and
queries via sigma-mcp-v2). Steps:

## 1. Prereqs
- The MCP repo's browser regression runner: `sigma-data-model-mcp/scripts/regression-browser.mjs`
  (Puppeteer-driven, posts the converted JSON to a Sigma test folder, asserts
  shape + zero error columns).
- Env: `SIGMA_BASE_URL`, `SIGMA_CLIENT_ID`, `SIGMA_CLIENT_SECRET`
  (org = `tj-wells-1989`, where the Orders/Superstore + Snowflake fixtures live).
- Point the runner at THIS clone's index.html:
  `export SMM_INDEX_PATH=/tmp/conv-fix/sigma-data-model-manager/index.html`

## 2. Drive the converter UI in a headless browser
1. Open `index.html`, switch to the Power BI converter tab.
2. Upload `/tmp/pbix/model_clean.bim` via the file input (`processPbiFile`).
3. Leave the Database / Schema override fields EMPTY (this is the j89 case).
4. Set a real Connection ID for the Snowflake test connection.
5. Click **Convert to Sigma JSON** (`runPbiConversion`).
6. Read `#pbiJsonOutput` and assert:
   - each base `warehouse-table` element `source.path === ["CSA","TJ","<TABLE>"]`
   - every base element has a non-empty `name` (= last path segment)
   - top-level `schemaVersion === 1`

## 3. Post to Sigma and verify it is directly postable
1. Inject a real `folderId` and `connectionId` (these are caller-supplied; the
   converter intentionally does NOT emit them).
2. POST the output to `/v2/workbooks/spec` (or the data-model create endpoint
   the page uses on **Save to Sigma**).
3. Assert the create call returns 200 and the model has zero error columns.

## 4. Query through sigma-mcp-v2
1. `begin_session`, `list_documents` to find the new model.
2. `describe` the model; confirm 3 base elements named EMPLOYEES /
   ABSENCE_RECORDS / SAFETY_INCIDENTS over `CSA.TJ.*`.
3. `query` one base element (e.g. `SELECT count(*) FROM EMPLOYEES`) and confirm
   rows return — proves the auto-derived path resolves against the warehouse.

## 5. Cleanup
DELETE the workbook/model: `DELETE /v2/files/<id>` (NOT `/v2/workbooks/<id>`).

## Quick local logic check (no Sigma creds)
```
cd /tmp/conv-fix/sigma-data-model-manager
npm install --no-save jsdom@24.1.3
node test/pbi-fix.jsdom.test.mjs
```
Expected: `PASS browser/JSDOM: (a) Snowflake paths auto-derived  (b) base elements named  (c) schemaVersion=1`
