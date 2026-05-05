**MANDATORY: Run this review before EVERY `git commit` in the sigma-data-model-manager / smm-push repo.**
This applies whenever you work on index.html in /tmp/sigma-data-model-manager or /tmp/smm-push — no exceptions.

Run a pre-commit review of the sigma conversion tool before committing.

## Step 0 — Working tree freshness (preflight)

Before reviewing the diff, confirm you're on top of `origin/main`:
```bash
git fetch && git status -sb
```
If the working tree shows `behind N` for any N > 0, STOP and `git pull --rebase` before continuing — a review against a stale base produces false-positives (the agent that triggered this rule worked on a 40-commit-stale clone of the MCP repo and conflicted at push time, 2026-05-05).

If the working tree has uncommitted changes from a prior session that aren't part of this fix, STOP and surface to the user.

Follow these steps in order:

## Step 1 — Show the diff
Run `git diff --staged` (or `git diff HEAD` if nothing staged). Summarize what changed in plain English.

## Step 2 — Syntax check
Run: `node -e "const s=require('fs').readFileSync('index.html','utf8'); const m=s.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/g); if(!m){console.error('No script tags found');process.exit(1);} let combined=m.map(t=>t.replace(/<\/?script[^>]*>/g,'')).join('\n'); new Function(combined); console.log('JS syntax OK');"` from `/tmp/sigma-data-model-manager`.

If this fails, report the error and stop — do not proceed to commit.

## Step 3 — Regression pattern checks
Search the changed code (and surrounding context) for these known failure modes:

**A. IN regex in `lookConvertExpression` step 2**
Grep for the IN replacement regex near "Convert EXPR IN". Verify the LHS group starts with `(\[[^\]]+\]|` — the bracket-form alternative must come first.

**B. `fieldDisplayMap` logic for simple dims**
Find the else branch of the `yesnoExprMap`/`fieldDisplayMap` build loop. Verify that for simple (non-complex) SQL dims it uses `sigmaDisplayName(physCol)` derived from the SQL, NOT `yd.label`. The label path should only run for complex/calculated dims.

**C. Duration group normalisation**
Grep for `normStart` and `normEnd` near `promo_length` or `duration`. Verify `sql_start`/`sql_end` are being pre-extracted and their content is stripped of `${TABLE}.` before the column name is extracted.

**D. Pattern 1b-bracket and 1c-bracket exist**
Confirm both bracket-form patterns are present in `lookSqlToSigmaRules` after the standard Pattern 1b and 1c.

**E. `sql_start` / `sql_end` in SQL_KEYS set**
Grep for `SQL_KEYS` and confirm it includes both `sql_start` and `sql_end`.

## Step 4 — Logic review of changed code
Read every function that was modified. For each one:
- Does it handle both bare `COLUMN_NAME` and `[Display Name]` forms?
- Does it handle single-quoted string literals without corrupting them?
- Does it handle multi-line SQL (newlines collapsed to spaces)?
- Are there any regex groups that could eat too much (greedy vs non-greedy)?

## Step 5 — Mental test: promo_dim dimensions
Trace through these LookML fields mentally and confirm the output formula looks right:

1. `is_high_discount` (yesno, sql: `${discount_pct} >= 25`)
   Expected: something like `[Discount Pct] >= 25`

2. `promo_value_tier` (string, CASE with `${promo_type}` and `${discount_pct}`)
   Expected: `If([Promo Type] = "BOGO" Or [Discount Pct] >= 50, "High Value", If([Discount Pct] >= 25, "Moderate", "Low Value"))`

3. `channel_type` (string, CASE with `${channel} IN (...)`)
   Expected: `If(In([Channel], "Email", "SMS"), "Digital Direct", ...)` — no `[Store In(Type]` mangling

4. `is_premium_customer` (yesno, sql: `${loyalty_tier} IN ('Gold', 'Silver')`)
   Expected: `In([Loyalty Tier], "Gold", "Silver")` as the boolean expression

5. `promo_length` (duration group, intervals: day/week)
   Expected: two columns with `DateDiff("day", [Start Date], [End Date])` etc. — no `[TABLE]` refs

## Step 6 — In-tool documentation check
The tool has a help modal with per-converter tabs in the `HELP_CONTENT` JavaScript object
(around line 16830). Each tab has consistent sections: "What Gets Converted", "Known
Limitations", and sometimes "Expression Conversion". Inline tooltips (`title=` attrs) and
`placeholder=` text also serve as docs.

Determine which converter(s) the diff touches (LookML, dbt, Snowflake, Tableau, Power BI,
Alteryx, Omni, Atlan). Then for each affected converter:

**A. "What Gets Converted" accuracy**
Read the relevant `HELP_CONTENT` tab section. Does it accurately describe what the
converter now handles? If a new pattern was added (e.g. `IN` operator support, duration
groups, yesno expansion), it should be listed here or in "Expression Conversion".

**B. "Known Limitations" honesty**
If a limitation was just fixed (e.g. "IN operator not supported" after Pattern 1c was
added), it must be removed or updated. If a new known limitation was introduced, it must
be added.

**C. Overview tab Key Capabilities**
If a capability was added that is broadly applicable (new converter source, new formula
type, new workflow feature), check that the Overview tab's "Key Capabilities" or
"General Workflow" section reflects it.

**D. Inline tooltip/placeholder coverage**
If new UI controls were added (buttons, inputs, dropdowns), check they have meaningful
`title=` or `placeholder=` text. If an existing button's behavior changed, check its
`title=` still accurately describes what it does.

**E. Verdict on docs**
- **Docs OK** — help content accurately reflects current behavior
- **Docs need update** — list exactly what is stale or missing and where (line numbers
  if possible), then make the updates before committing

## Step 7 — README sync

The `README.md` in the repo root is generated from the in-tool `HELP_CONTENT` object. It must stay in sync with the help modal tabs.

**A. Check if README needs updating**
Look at the diff. If any of these changed, the README section(s) for the affected converter(s) must be updated to match:
- `HELP_CONTENT` tab content (any tab)
- The converter panel UI text (What gets converted / Known limitations blocks in the HTML)
- The Custom SQL panel placeholder text or feature list

**B. Update README sections that are out of date**
For each affected converter tab, update the corresponding section in `README.md`:
- Heading text, What gets converted bullets, Expression conversion table, Known limitations, links
- If a limitation was fixed, remove it from Known Limitations
- If a new capability was added, add it to the What gets converted list
- If a new converter was added (new `HELP_CONTENT` tab + panel), add a full new section to the README

**C. Custom SQL section**
The Custom SQL section in README.md (under `### Custom SQL`) is the canonical doc for the SQL converter panel. If `parseSqlFull`, `runSqlConversion`, or the SQL panel UI changed, update that section.

**D. Stage README**
If any README changes were made, run:
```
git add README.md
```
The README must be committed in the same commit as the HELP_CONTENT / converter changes it documents.

**E. Verdict on README**
- **README OK** — in sync with current HELP_CONTENT and converter behavior
- **README updated** — list which sections were changed and what was updated

## Step 8 — MCP sync check

The sigma-data-model-mcp (github.com/twells89/sigma-data-model-mcp) is an independent implementation of the same converters. It must stay in sync with `index.html`.

**A. New converter added?**
If the diff adds a new converter tab/panel to `index.html` (e.g. ThoughtSpot, Atlan), a matching file must be created in the MCP:
1. `src/<tool>.ts` implementing `convert<Tool>ToSigma()`
2. Imported and registered via `server.tool()` in `tools.ts` `registerTools()`

If this work is not done in the same commit, **file a beads issue before committing**:
```bash
cd ~/.beads-sigma && bd create "Sigma MCP: add <Converter> converter" --label sigma-converter --description "Added to index.html in <commit> but not yet ported to MCP."
```

**B. Existing converter changed?**
If the diff changes converter logic in `index.html` (bug fix, new pattern, formula change), check whether the corresponding `src/*.ts` file in the MCP needs the same fix. MCP converter files: `src/dbt.ts`, `src/snowflake.ts`, `src/lookml.ts`, `src/powerbi.ts`, `src/tableau.ts`, `src/omni.ts`, `src/sql.ts`.

If a port is needed but out of scope, file a beads issue:
```bash
cd ~/.beads-sigma && bd create "Sigma MCP: sync <Converter> converter" --label sigma-converter --description "Changes in index.html (<what changed>) not yet reflected in MCP src/<file>.ts."
```

**C. Verdict on MCP**
- **MCP OK** — no converter logic changed, or MCP already updated in this session
- **MCP issue filed** — beads issue created for follow-up (include the issue ID)
- **MCP needs update** — port required in this commit; do NOT mark PASS until done

## Step 9 — Data model spec correctness audit

When the diff touches a converter file (`index.html` view-build loops, or any `sigma-data-model-mcp/src/*.ts` mirror), audit the converter output against this checklist of bug classes that have shipped to production and broken Sigma POSTs. Each item below maps to a real bug we've had to retroactively fix — re-introducing any of them silently breaks `/v2/files` POSTs or the in-app element.

**A. `schemaVersion: 1` at the model root**
Required for Sigma to accept POSTs of the data model JSON. Every converter must emit it on the top-level object alongside `name` / `pages`. Recent fix added it to 13 converters — do not regress.
```
grep -nE "schemaVersion" <changed-file>
```
If missing in a new or modified converter, FAIL.

**B. dbt relationship `name` field — uppercase target table name**
The `relationships[].name` for dbt-derived joins must equal the target warehouse-table name UPPERCASE (e.g., `CUSTOMER_DIM`), NOT a sigmaDisplayName phrase like `"Order Fact to Customer Dim"`. Other converters use either the target table name or a flat string; never `"X to Y"` phrasing.
```
grep -nE "relationships?\b|name:\s*['\"].* to " <changed-file>
```
Inspect any `relationships[].name` assignment in the dbt converter (or any converter that builds dbt-style joins).

**C. Custom SQL elements (`source.kind === 'sql'`)**
- Element-level `name` field MUST be omitted entirely (not present, not `null`, not `undefined`). Sigma auto-titles SQL elements; an explicit `name` breaks them.
- Column formulas must use the bare `[Display Name]` form for snake_case SQL identifiers (Sigma fuzzy-matches), NOT the qualified `[Custom SQL/Display Name]` form. The qualified form only works if the SQL emits double-quoted aliases that exactly match the display name — which our converters do not guarantee.
```
grep -nE "kind:\s*['\"]sql['\"]|\[Custom SQL/" <changed-file>
```
If a SQL-element branch sets `name:` on the element, or if column formulas embed `[Custom SQL/...]`, FAIL.

**D. Cross-element column references — relationship-name form**
References from one element to a column on a related element must use `[ELEMENT_NAME/REL_NAME/Field]`. The dash-link form `[ELEMENT_NAME/FK_COL - link/Field]` does NOT work via the API — it parses in the browser but POSTs are silently rejected or render as broken refs.
```
grep -nE " - link/" <changed-file>
```
Any match is a FAIL.

**E. Union elements — `sources` + `matches` shape**
Union elements must emit:
- `sources: [{ kind: 'table', elementId: '<id>' }, ...]`
- `matches: [{ outputColumnName: '...', sourceColumns: ['[Display]', ...] }, ...]`
- Column formulas of the form `[Union of N Sources/ColName]`

The older `inputs: [...]` shape is wrong and will not save.
```
grep -nE "kind:\s*['\"]union['\"]|\binputs:\s*\[|\bsources:\s*\[|\bmatches:\s*\[" <changed-file>
```
If a union element uses `inputs:` instead of `sources:` + `matches:`, FAIL.

**F. Relationship name = uppercased target warehouse path-tail (NOT raw display phrase or model name)**
For converters that emit relationships, every `relationship.name` field must equal the target element's `source.path[last].toUpperCase()` — e.g. `CUSTOMER_DIM`, not `customer_dim`, `Customer Dim`, `orders_to_customer`, or `targetModel`. This name is the middle segment of cross-element formulas `[SRC/REL_NAME/Field]` and the spec rule was retroactively applied to dbt, qlik, oac, atlan, cube, thoughtspot. Pattern to match in the diff:
```
grep -nE "name:\s*(targetModel|join\.name|tgtName|rTable)\b" <changed-file>
```
If you find any of these without `.toUpperCase()` and a `path[last]` lookup, FAIL.

**G. Cross-element calc-col move coherence**
When a converter moves a calc col from a source element to its derived element (because the formula references columns on a related element via `buildDerivedElementsAndMoveCalcs` or equivalent), TWO things must happen alongside the move:
1. The moved column ID must be REMOVED from any `folder.items[]` array on the source element. Otherwise the saved spec fails with `"Column or folder not found: <id>"` (real bug 2026-05-05, beads-sigma-6o3).
2. The moved formula's bare `[FieldName]` references to columns on RELATED elements must be rewritten to the cross-element triple form `[SourceElement/REL_NAME/FieldName]`. The bare form fails to resolve at query time because the derived element exposes related columns under disambiguated names; the parenthesized form `[FieldName (REL_NAME)]` also does NOT work — parens collide with formula function-call syntax (real bug 2026-05-05, beads-sigma-k2r).
```
grep -nE "buildDerivedElementsAndMoveCalcs|moveCalcs|crossElementCalcs?\b" <changed-file>
```
If found, scan the surrounding code for both the folder-scrub pass and the formula-rewrite pass. If either is missing, FAIL.

**Verdict on spec audit**
- **Spec OK** — all seven items pass for the converter(s) touched
- **Spec FAIL** — list which item(s) regressed and where; fix before committing

## Step 10 — End-to-end UI test (live POST + data verification)

This step has TWO mandates:
1. **Per-converter test** — when the diff touches a converter's view-build loop, run a real-UI test for that converter (existing behavior, detailed below).
2. **Mandatory regression-fixture sweep** — on EVERY commit that touches `index.html`'s converter section, regardless of which converter the diff touches, run the fixed regression-fixture corpus below. This catches bugs in code paths the diff didn't *seem* to touch but does indirectly (e.g. shared helpers like `buildDerivedElementsAndMoveCalcs`). On 2026-05-05 a Tableau converter PR shipped without exercising the move pass; a real customer TDS hit the bug post-merge. The corpus prevents that.

When the diff touches a converter's view-build loop (the part that produces the `sigmaModel` JSON), run a real-UI test that drives the local browser tool, saves through the actual Save flow, and verifies the saved spec resolves data correctly via the Sigma MCP V2 server. JSDOM-based or function-extracting harnesses are NOT a substitute — they bypass DOM-driven setup and have produced false negatives historically. The bar for "PASS" on this step is: a query against the saved data model returns real warehouse data, not error-typed columns or null rows.

**Mandatory regression-fixture corpus (run on EVERY converter-touching commit):**
The following fixtures must run end-to-end (convert → POST → query → check error columns → cleanup) before commit. Failure on any of these is a HARD FAIL:

| Fixture | Path | Purpose |
|---|---|---|
| `lod_test.twb` | `/Users/tjwells/Downloads/sigma-data-model-mcp-update/test-fixtures/lod_test.twb` | LOD INCLUDE/EXCLUDE/FIXED + helper dedup |
| `setsbug_test.twb` | author from `beads-sigma-6o3` repro | Cross-element calc move + folders interaction |
| `retail_analytics_sets_real.tds` | `/tmp/setsbug_test/real_user_tds.tds` (from `/Users/tjwells/Desktop/Converter Files/retail_analytics_sets_tableau.tds`) | Real customer TDS that hit beads-sigma-6o3 + beads-sigma-k2r |
| `window_test.twb` | from prior agent's window-calc work | RUNNING_SUM / WINDOW_SUM / LOOKUP / RANK |

For each, the test must:
1. Load via JSDOM or Puppeteer harness
2. Run the converter
3. POST to Sigma test folder
4. **`GET /v2/dataModels/{id}/columns`** → assert ZERO entries with `type.type === "error"`. **This is a hard gate.** A spec that POSTs 200 but has even one error column is a FAIL — silent runtime breakage hides under successful saves.
5. Cleanup via `DELETE /v2/files/{dataModelId}`

Long-term, this corpus moves to `regression-corpus/` + `npm run regression` per `beads-sigma-ee6`. Until then, run the fixtures inline.

**Bug-driven corpus growth:** every bug ticket fixed must add a fixture that reproduces the original failure. Adding the fixture is part of the fix commit, not a follow-up.

**Setup:**
- Puppeteer is installed at `/Users/tjwells/sigma-data-model-manager/tableau-local/node_modules/puppeteer`. Import via `import puppeteer from '/Users/tjwells/sigma-data-model-manager/tableau-local/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js'`.
- Local file URL: `file:///Users/tjwells/sigma-data-model-manager/index.html`
- Env vars `SIGMA_BASE_URL`, `SIGMA_CLIENT_ID`, `SIGMA_CLIENT_SECRET` are exported. Token script at `~/sigma-skills/tableau-to-sigma/scripts/get-token.sh` (use `bash -c 'eval "$(...)"; node ...'` pattern — NEVER `TOKEN=$(eval "$(...)")`).
- Test connection: `cb2f5180-641f-47bd-8efa-da9d590d855a` (CSA.TJ Snowflake). Test folder: `9ca9bf60-6a33-43dd-967d-1ba6352c54bb` (My Documents/Test).

**UI flow (for each converter touched by the diff):**
1. `headless: 'new'` Puppeteer page loads the local index.html
2. Set `#apiRegion` value to `https://aws-api.sigmacomputing.com`, fill `#clientId` + `#clientSecret`, click `#connectBtn`. Wait for `populateConverterConnections` to settle.
3. Switch tab via `#converterFormat` `<select>` `change` event (fires `switchConverter('<format>')`). Format keys: `dbt`, `snow`, `look`, `tableau`, `pbi`, `alteryx`, `contract` (atlan), `omni`, `thoughtspot`, `qlik`, `oac`, `cube`, `prep` (tableau prep), `sql`.
4. Drop or upload the fixture (look up the per-converter `<input type="file">` id like `#cubeFileInput`, or for paste-based converters set `<textarea>` value via `value=` + dispatch `input` event — text-pastes need `parseSqlPaste()` / equivalent invoked explicitly under headless).
5. Click the converter's run button (`#cubeRunBtn`, etc.) or invoke the run handler directly (`runCubeConversion()`, etc. — these are the same handlers wired to the buttons).
6. Click `#cubeSaveBtn` / `#sqlSaveBtn` / etc. to trigger `<format>LoadAndSave()`. Under headless the Save Location modal can be brittle — acceptable fallback: close the modal, set `folderId` directly on the editor's JSON, and call `saveDataModel()` (same code path `confirmSaveLocation()` uses; same endpoint, same payload).
7. Capture the resulting `dataModelId` from the success toast text or page state.

**Data verification (per saved data model):**
1. `mcp__sigma-mcp-v2__describe(type="datamodel", dataModelId)` — confirm element list returned
2. `mcp__sigma-mcp-v2__describe(type="datamodel-element", dataModelId, elementId)` — pick the largest fact-style element. **Every column must have a concrete type** (`text` / `integer` / `number` / `datetime` / `boolean`). Any column showing as `error` is a FAIL.
3. `mcp__sigma-mcp-v2__query(type="datamodel", dataModelId, sql="SELECT * FROM \"datamodel\".\"<elementId>\" LIMIT 5")` — must return rows with real warehouse values (e.g., `ORD-00009 | James Martinez | Atlanta Flagship`). All-null rows or "Unknown column" errors are a FAIL.

**FIXTURE RULE — strictly verify warehouse columns BEFORE testing.** Synthetic fixtures (and even some "real" exports that point at warehouses other than CSA.TJ) frequently reference column names that don't exist in the test connection's warehouse — leading to spurious "regressions" that look like converter bugs but are actually fixture errors. Before marking a converter as failing:
1. Run `mcp__sigma-mcp-v2__describe(type="table", inodeId)` on each warehouse table the fixture references
2. Confirm every column the fixture pulls (`${TABLE}.X`, dbt `expr: X`, snowflake column `name: X`, etc.) appears in the returned DDL
3. If a column is missing, the fixture is wrong — fix the fixture and re-run before filing a converter bug

The 2026-05-03 E2E sweep produced THREE false-positive "regressions" (lookml, omni, powerbi) because agents synthesized fixtures referencing CUSTOMER_DIM.CUSTOMER_NAME (real cols are FIRST_NAME/LAST_NAME), ORDER_FACT.STORE_KEY (real: ORDER_STORE_KEY/SHIP_STORE_KEY), and similar. Always validate against the warehouse schema first.

**Sigma MCP V2 query API quirk to know about:** `metric('id', t)` returns the literal string `"Missing Metric"` on EVERY data model (including hand-built ones) — this is a query-API limitation, NOT a converter bug. To verify metrics resolve, use `SELECT *` and look for `--metric-["id"]` columns in the output, OR use `SELECT SUM(physical_col)` directly.

**Multi-element scenarios required:** Step 10 must include at least one fixture per converter that exercises multiple elements + cross-element references via relationships — single-element fixtures don't catch the most common defect class (formulas referencing the wrong element-name prefix or relationship name). A multi-view LookML chain or a 5+ element snowflake semantic view is appropriate.

**Cleanup (mandatory):** after verification, delete each saved test data model via `DELETE ${SIGMA_BASE_URL}/v2/files/{dataModelId}` so the test folder doesn't accumulate clutter. The test folder lists at `${SIGMA_BASE_URL}/v2/files?parentId=9ca9bf60-...&limit=200`.

**Verdict on UI test**
- **UI OK** — every touched converter saves cleanly through the real flow AND the saved spec returns real data via MCP V2 query
- **UI FAIL** — at least one converter saves but the data is broken (error-typed columns, all-null rows, "Unknown column"). Do NOT commit; root-cause and re-run.
- **UI N/A** — diff is documentation-only or doesn't touch any converter view-build loop

## Step 11 — Final verdict
Report one of:
- **PASS** — code, docs, README, MCP sync, spec audit (Step 9 all 7 items including 9.G), and UI test (per-converter + mandatory regression corpus, all error-column scans clean) all green. Safe to commit.
- **FAIL** — list specific issues found; do NOT commit; suggest fixes.
- **WARN** — commit is likely safe BUT each warn item must be explicitly justified. A WARN is only acceptable if EVERY item meets one of:
  1. The deviating behavior was empirically verified to work end-to-end (cite live DM URL + numerics).
  2. The risk is documented in a beads ticket as a known follow-up.
  3. The user explicitly waived the check.

Do NOT accept WARN silently. If you're tempted to ship WARN without naming each justification, FAIL it instead and ask the user.

Only after a PASS verdict should you proceed with `git commit`.

## Step 12 — CSA enablement docs sync
After a passing commit, decide whether the change needs to be reflected in the [`sigmacomputing/csa`](https://github.com/sigmacomputing/csa) enablement docs at `docusaurus/docs/projects/data-model-converter/`.

**Sync triggers** — a CSA docs PR is required when the diff:
- Adds, removes, or renames a converter (touch `converters/<format>.md` plus the format list in `overview.md`)
- Changes a converter's accepted input format, supported features, or known limitations (`converters/<format>.md`)
- Changes the Fix-with-AI tools list, tier breakpoints, or AI provider list (`fix-with-ai.md`)
- Changes the browser tool's auth flow, save flow, or supported regions (`browser-tool.md`)
- Adds or removes a major UX surface (new tab, new help modal, new button visible to CSAs)

**No sync needed** when the diff is purely:
- Internal refactor / dead code removal
- Test fixture updates
- Bug fixes that don't change documented behavior
- README-only changes already mirrored to `overview.md`

**Process:**
1. Clone or `cd` into a checkout of `sigmacomputing/csa` on a fresh branch named `tj/<short-description>`.
2. Update the affected docs under `docusaurus/docs/projects/data-model-converter/`. Match the existing frontmatter shape (`sidebar_position`, `title`, `owner`, `status`, `doc-type`, `last-updated`, `description`, `tags`).
3. `git add` only the changed docs, commit with a message that names the source-repo commit (e.g., "Sync data-model-converter docs after sigma-data-model-manager@abc1234").
4. `gh pr create --base main` against `sigmacomputing/csa`.
5. Drop the PR URL into the source-repo commit message or PR body so the trail is two-way.

**Verdict on sync**
- **SYNC OK** — CSA docs PR opened and linked
- **SYNC SKIPPED** — diff is internal-only; no doc-visible behavior changed
- **SYNC TODO** — sync is needed but deferred; file a beads ticket so it's not forgotten
