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
6. `[Custom SQL/COLUMN_NAME]` in LookML derived-table column formulas — means
   `colRef()` helper isn't being used. Derived table (SQL element) columns must use
   bare `[COL]` refs, not `[Custom SQL/COL]`. Check `colRef` is used everywhere in
   the view-build loop for Custom SQL elements.
7. `syntax error … unexpected 'WHERE'` from a derived table SQL element — likely an
   incremental PDT with a leading-comma CTE (`,cte_name AS (`). The fix at step 1b
   of the derived-table pre-processor auto-corrects this by prepending `WITH `.

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
