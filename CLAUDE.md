# Sigma Conversion Tool — Project Rules

## Pre-commit requirement
**ALWAYS run `/review-commit` before any `git commit` in this repo.**
Do not commit until the review passes or the user explicitly overrides it.

## Architecture
Single-file browser app: `index.html` contains all HTML, CSS, and JavaScript.
The JS is organized as a series of converter modules (LookML, dbt, Snowflake,
Tableau, Power BI → Sigma data model JSON).

## Key functions and their invariants

### `lookIsComplexSql(sql)`
Returns true when SQL needs formula conversion. Must detect: function calls,
CASE expressions, IN operator, comparison operators, arithmetic.

### `lookSqlToSigmaRules(sql, tableName)`
Rule-based converter. Patterns must handle BOTH:
- Bare `COLUMN_NAME` identifiers (pre-expandFieldRefs path)
- `[Display Name]` bracket-form identifiers (post-expandFieldRefs path)

Patterns 1b-bracket and 1c-bracket handle the bracket-form cases.

### `lookConvertExpression(expr)`
Step 2's IN regex must match bracket-form LHS: `(\[[^\]]+\]|[\w\]\)]+...)`.

### `expandYesnoRefs(sql)` / `fieldDisplayMap`
- **yesno dims** → expand to `(BOOLEAN_EXPR)` so `And()`/`Or()` receive logicals
- **simple SQL dims** → expand using `sigmaDisplayName(physicalCol)`, NOT the label
- **complex/calculated dims** → expand using `label || sigmaDisplayName(name)`

The physical col name drives `sigmaDisplayName` for simple dims because the
Sigma model spec adds simple dims WITHOUT an explicit `name` field, so Sigma
auto-assigns names via its own friendly naming.

## Spec correctness rules (apply to every converter)
These bug classes have shipped to production and broken Sigma POSTs. `/review-commit` Step 9 audits all five.

1. **`schemaVersion: 1` at the model root** — required for `/v2/dataModels/spec` to accept POSTs.
2. **dbt-style relationship `name`** = uppercase target warehouse-table name (e.g., `CUSTOMER_DIM`), NOT a sigmaDisplayName phrase like `"Order Fact to Customer Dim"`. Relationship name is also the middle segment of cross-element formulas `[SRC/REL/Col]`.
3. **Custom SQL elements** (`source.kind === 'sql'`): most converters omit the element-level `name` field and use bare `[Display Name]` column formulas. **LookML exception (2026-06, mirrors MCP live-E2E):** the LookML converter names every element (label || sigmaDisplayName(viewName)) and uses SOURCE-qualified `[Custom SQL/COL]` refs — the SQL source is always named "Custom SQL" regardless of the element name, and a bare sibling ref to an unnamed passthrough on a NAMED sql element compiles to type "error" (verified: `[IS_RETURNED] = 1` errored, `[Custom SQL/IS_RETURNED] = 1` resolved; full lookml regression corpus green with this shape).
4. **Cross-element refs** use `[ELEMENT_NAME/REL_NAME/Field]`. The dash-link form `[ELEMENT/FK - link/Field]` does NOT work via the API.
5. **Union elements** use `sources: [{ kind:'table', elementId }, ...]` + `matches: [{ outputColumnName, sourceColumns:['[Display]'] }, ...]` + column formulas `[Union of N Sources/Col]`. The older `inputs: [...]` shape silently fails.

## Known regression patterns to check before committing
1. `[Store In(Type]` style mangling — means `lookConvertExpression` step 2 IN regex
   isn't matching bracket-form LHS
2. `[TABLENAME/Table]` in DateDiff — means duration group sql_start/sql_end
   pre-extraction or normalisation is broken
3. "Unknown column 'Discount %'" — means `fieldDisplayMap` is using label instead of
   `sigmaDisplayName(physCol)` for a simple dim
4. "Expected logical, received number" in Sigma — means a yesno ref expanded to a
   raw column instead of a boolean expression; check `yesnoExprMap` coverage
5. `is premium customer [IS PREMIUM CUSTOMER]` not found — means Pattern 1c failed
   for a bracket-form IN expression
6. Inconsistent custom-SQL column refs in the LookML view-build loop — means
   `colRef()` helper isn't being used. Since the 2026-06 layered-LookML mirror,
   LookML SQL elements are NAMED and `colRef` emits the SOURCE-qualified
   `[Custom SQL/COL]` form for them (bare `[COL]` sibling refs error on named
   sql elements — see spec rule 3). Check `colRef` is used everywhere in the
   view-build loop for Custom SQL elements.
7. `syntax error … unexpected 'WHERE'` from a derived table SQL element — likely an
   incremental PDT with a leading-comma CTE (`,cte_name AS (`), possibly preceded by `--`
   comment lines. Step 1b of the derived-table pre-processor auto-corrects this by
   prepending `WITH ` (strips leading comment lines before testing for the comma pattern).
9. `syntax error … unexpected '('` from a derived table SQL element — two known causes:
   (a) Trailing comma before `FROM` (e.g. `expr AS col,\nFROM final`) — step 1c strips it.
   (b) Snowflake JSON path + cast shorthand (`f.value:col::DATE`) — step 2 was incorrectly
   rewriting the `col` after the path colon (`:`) to a function call, producing invalid
   `f.value:TRY_TO_DATE(TO_VARCHAR(col))`. Fixed: added `:` to the step 2 negative lookbehind
   so path-accessed identifiers (`(?<!['"\\:])`) are not rewritten.
8. `${view.SQL_TABLE_NAME}` where that view is itself a PDT — the referenced PDT's SQL is
   inlined as a WITH CTE (recursive, depth-first/topological order via the shared `cteMap`;
   `pdtStack` is the cycle guard). Regular-view refs resolve to the literal warehouse path.
   Unresolved/circular refs and fragment deps emit a `LOOKER_SCRATCH.<VIEW>` placeholder
   table + LOUD 🔶 warning — never a bare `/* TODO */` comment in FROM position. CTE-
   continuation fragments (leading ", name AS (") are completed by the CTE prelude or
   WITH-promoted when nothing was inlined; a statement already starting with WITH is merged.
   The SQL_TABLE_NAME resolution uses a two-pass approach (async loop to populate the
   replacement map, then synchronous `.replace()`) because `String.prototype.replace`
   callbacks cannot be async. (The older `sigma_element('Name')` approach is parked until
   the /spec API supports it — see TODO comments in `lookConvertView`.)

## In-tool documentation locations
- **Help modal content**: `HELP_CONTENT` JS object (~line 16830). One key per converter tab:
  `overview`, `tableau`, `pbi`, `lookml`, `dbt`, `snow`, `alteryx`, `contract`, `omni`, `ai`, `api`, `mcp`.
  Each tab has "What Gets Converted", "Known Limitations", and optional "Expression Conversion" sections.
- **Inline tooltips**: `title=` attributes on buttons and controls throughout the HTML.
- **Placeholders**: `placeholder=` on form inputs and textareas.
- **Converter panel instructions**: "How to get files" `<strong>` blocks in each converter's left column.

When converter behavior changes, the corresponding `HELP_CONTENT` tab must be updated in the same commit.
The `/review-commit` command enforces this (Step 6).

## Test files
- `/Users/tjwells/Desktop/Converter Files/Looker/promo_dim_view.lkml`
- `/Users/tjwells/Desktop/Converter Files/Looker/monthly_summary_derived_view.lkml`
- `/Users/tjwells/Downloads/retail_analytics_csa_tj.yxmd` — Alteryx test file using actual CSA.TJ warehouse columns (CUSTOMER_DIM, STORE_DIM, ORDER_FACT). Must use this file, not `retail_analytics_pipeline.yxmd` — the old file used fake column names that don't exist in the warehouse, causing Sigma API schema validation errors.
