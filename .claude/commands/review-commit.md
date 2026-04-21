**MANDATORY: Run this review before EVERY `git commit` in the sigma-data-model-manager / smm-push repo.**
This applies whenever you work on index.html in /tmp/sigma-data-model-manager or /tmp/smm-push — no exceptions.

Run a pre-commit review of the sigma conversion tool before committing.

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

## Step 8 — Final verdict
Report one of:
- **PASS** — code, docs, and README are all correct; safe to commit
- **FAIL** — list specific issues found (code, docs, or README); do NOT commit; suggest fixes
- **WARN** — commit is likely safe but flag items to monitor

Only after a PASS verdict should you proceed with `git commit`.
