# LookML → Sigma Data Model Converter
## What to Expect

---

This tool converts LookML views and explores into Sigma data model JSON, which can be saved directly to your Sigma organization via the Sigma API. It's designed to give you a solid starting point — not a pixel-perfect one-to-one migration. Plan to review the output and make adjustments in Sigma after import.

---

## What Converts Automatically

### Tables & Columns
- **Warehouse tables** — `sql_table_name` mapped to a Sigma warehouse-table element with the correct database/schema/table path
- **Derived tables** — `derived_table { sql: ... }` becomes a Sigma Custom SQL element with the SQL extracted as-is
- **Dimensions** — each `dimension` becomes a column in the Sigma element
- **Boolean flags** (`type: yesno`) — creates the underlying warehouse column plus a calculated column with the boolean expression (e.g. `[Is Active] = 1`)
- **Time dimensions** (`dimension_group`) — creates a single datetime column; time granularity (day/week/month/year) is handled in Sigma workbooks, not the data model

### SQL Expressions
Common SQL patterns in `sql:` blocks are automatically converted to Sigma formulas without needing an AI key:

| SQL Pattern | Sigma Formula |
|---|---|
| `ROUND(expr, 2)` | `Round(expr, 2)` |
| `DATEDIFF('day', start, end)` | `DateDiff("day", [Start], [End])` |
| `CASE WHEN col IN (1, 2) THEN 'A' ELSE 'B' END` | `If(In([Col], 1, 2), "A", "B")` |
| `expr / NULLIF(divisor, 0)` | `expr / If([Divisor] = 0, null, [Divisor])` |

For expressions the converter doesn't recognise, you can optionally provide an AI API key (OpenAI, Anthropic, or Gemini) to convert them automatically. The converter always tries the rule-based approach first.

### Metrics
| LookML type | Sigma metric |
|---|---|
| `count` | `Count()` |
| `count_distinct` | `CountDistinct([Col])` |
| `sum` | `Sum([Col])` |
| `average` | `Avg([Col])` |
| `max` / `min` | `Max([Col])` / `Min([Col])` |
| `median` | `Median([Col])` |
| `list` | `ListAgg([Col])` |

### Controls (filter: and parameter: Fields)
LookML `filter:` and `parameter:` fields are converted into Sigma **data model controls** — interactive UI elements (date pickers, dropdowns) that are embedded in the model itself. Every workbook that uses the data model automatically inherits these controls, which is more powerful than the LookML equivalent.

| LookML | Sigma Control |
|---|---|
| `filter: { type: date }` | Date range picker — reference in formulas as `[ControlId].start` and `[ControlId].end` |
| `filter: { type: string }` | Dropdown list populated from the matching warehouse column |
| `parameter: { allowed_values: [...] }` | Single-select dropdown with your predefined options |
| `parameter: { type: date }` | Date range picker |
| `parameter: { type: string }` (free-form) | Text input control |

**Important note on free-form parameters:** If your LookML used `{% parameter %}` Liquid tags in `sql:` blocks to dynamically swap SQL based on a parameter value, that dynamic behavior is not converted. The control will be created, but you'll need to manually wire it to the relevant columns or formulas in Sigma after import.

### Joins & Relationships
- **many_to_one / one_to_one** joins → Sigma **relationships** (lazy — the join only executes when a column from the related table is used in a workbook)
- **one_to_many / many_to_many / full_outer** joins → Sigma **physical join element** (always joined in SQL)
- `sql_on: ${a.key} = ${b.key}` is parsed automatically into Sigma relationship keys
- You can choose your join strategy: Auto, Force Relationships, or Force Physical Joins

---

## What Converts With Caveats

**Time dimensions** — LookML's `dimension_group` expands into multiple filter options (date, week, month, year). Sigma generates one datetime column per `dimension_group`. The time granularity filtering happens in the workbook layer, which is how Sigma is designed to work.

**Role-playing joins** — if two joins point to the same physical table (e.g. `order_store` and `ship_store` both using `STORE_DIM`), one Sigma element is created for the physical table. The second join alias is flagged in the warnings panel and needs to be wired manually in Sigma's ERD view after import.

**Tier dimensions** (`type: tier`) — the underlying numeric expression is converted to a calculated column, but the tier bucketing labels are dropped. There's no equivalent tier construct in Sigma data models.

**Filtered measures** — if a measure has a `filters:` block, the metric is created without the filter condition, and a warning explains what was dropped. The recommended approach is to build it post-import as a calculated column using `If()` logic.

**Complex `sql_on:` expressions** — only simple equality joins (`${a.key} = ${b.key}`) are parsed automatically. More complex join conditions are flagged and need to be reviewed manually.

**Free-form parameters** — a text control is generated, but Liquid-driven dynamic SQL in `sql:` blocks is not converted. The control will appear in the model; the downstream formula wiring is manual.

---

## What Doesn't Convert

| Construct | Why |
|---|---|
| `type: running_total` | Requires a window function — Sigma data model metrics don't support window functions. Add as a calculated column in a workbook instead. |
| `type: percent_of_total` | No direct equivalent in Sigma data model metrics. Use a ratio calculated column in a workbook. |
| `extends:` / `refinements:` | Not processed — fields inherited from parent views are not included |
| `access_filter:` / `always_filter:` | Not converted — Sigma handles row-level security via user attributes configured separately |
| `html:` / `link:` / `action:` | Not converted — Sigma handles these at the workbook layer |
| `persist_with:` / `datagroup:` | Materialization is configured separately in Sigma |
| Compound join keys | Only the first key pair per join is extracted |
| Liquid `{% parameter %}` in `sql:` | The control is created but the dynamic SQL substitution is not converted |

---

## After Import — What to Check

1. **Review the warnings panel** — every conversion decision that needs a human eye is listed there with an explanation
2. **Controls** — check that date-range and list controls are wired to the right columns. Free-form parameter controls need their downstream formulas updated manually
3. **Boolean calculated columns** — check that `[Is Active] = 1` style columns reference the correct underlying warehouse column
4. **Role-playing joins** — add any second or third alias joins manually in Sigma's ERD view
5. **Filtered measures** — rebuild as `If()` calculated columns or filtered elements in Sigma
6. **Tier dimensions** — the numeric expression came through; add any label/bucketing logic in a workbook calculated column
7. **running_total / percent_of_total measures** — these were skipped; rebuild in workbooks using window functions or ratio columns
8. **Publish the model** — the API saves to draft; go to the model in Sigma and click Publish to make it available to workbook authors

---

## Tips for Best Results

- **Include FK dimensions in your views** — relationship keys can only be wired if both the FK and PK columns are defined as `dimension:` fields in their respective views. If a relationship isn't wiring up, check that the FK column is explicitly defined (not just inferred from a join)
- **One explore at a time** — select the explore you want to convert from the dropdown before clicking Convert. Each explore becomes one data model
- **Star schema explores work best** — the converter is optimised for many_to_one fact-to-dimension patterns. Highly nested or self-referential LookML may need more post-import cleanup
- **Use the Load into Editor button** to inspect the JSON before saving — you can edit it directly before it hits the Sigma API
- **filter: and parameter: fields** are picked up from all views in the explore — you don't need to do anything special, they'll appear as controls in the output automatically
