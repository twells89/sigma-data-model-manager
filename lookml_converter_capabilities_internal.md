# LookML → Sigma Data Model Converter
## Capabilities & Limitations — SE Reference

*Last updated: March 2026*

---

## ✅ What It Converts

### View Layer
| LookML Construct | Sigma Output |
|---|---|
| `view { sql_table_name: DB.SCHEMA.TABLE }` | Warehouse-table element with 3-part path |
| `view { derived_table { sql: ... ;; } }` | Custom SQL element — SQL extracted verbatim |
| `dimension` | Warehouse-backed column |
| `dimension { type: yesno }` | Warehouse column (e.g. `IS_ACTIVE`) **+** calculated boolean column (`[Is Active] = 1`) — both created so the boolean expression has something to reference |
| `dimension_group { type: time }` | Single datetime column (one column regardless of timeframes list) |
| `measure { type: count }` | `Count()` metric |
| `measure { type: count_distinct }` | `CountDistinct([Col])` metric |
| `measure { type: sum }` | `Sum([Col])` metric |
| `measure { type: average }` | `Avg([Col])` metric |
| `measure { type: max / min }` | `Max([Col])` / `Min([Col])` metric |
| `measure { type: median }` | `Median([Col])` metric |
| `measure { type: list }` | `ListAgg([Col])` metric |
| `measure { type: sum_distinct }` | `Sum(Distinct [Col])` metric |
| `measure { type: average_distinct }` | `Avg(Distinct [Col])` metric |
| `label:` on dimensions/measures | Display name on Sigma column/metric |
| `description:` | Preserved as Sigma column/metric description |

### SQL Expression Conversion (rule-based, no AI key required)
| Pattern | Sigma Formula |
|---|---|
| `COLUMN = 1` (yesno) | `[Display Name] = 1` (calculated column referencing warehouse col) |
| `ROUND(expr, n)` | `Round(converted_expr, n)` |
| `DATEDIFF('unit', a, b)` | `DateDiff("unit", [A], [B])` |
| `CASE WHEN col IN (v1, v2) THEN ... END` | `If(In([Col], v1, v2), ...)` nested If chain |
| Arithmetic with `NULLIF(x, 0)` | `If(x = 0, null, x)` pattern |
| Common SQL functions | Mapped: `MONTH→Month`, `COALESCE→Coalesce`, `FLOOR→Floor`, `CEILING→Ceiling`, `ABS→Abs`, `DATE_TRUNC→DateTrunc`, `DATEADD→DateAdd`, etc. |

An optional AI key (OpenAI, Anthropic, or Gemini) can be configured on the LookML tab for expressions the rule-based converter doesn't recognise. Rules always run first — AI is only invoked as a fallback.

### Explore / Join Layer
| LookML Construct | Sigma Output |
|---|---|
| `explore: name` | Data model named after explore label or name |
| `explore { from: view_name }` | Correct aliased view used as base |
| `join { relationship: many_to_one }` | Sigma **relationship** (lazy — joins only when a related column is used) |
| `join { relationship: one_to_one }` | Sigma **relationship** (lazy) |
| `join { relationship: one_to_many }` | Sigma **physical join element** (eager — always in SQL) |
| `join { relationship: many_to_many }` | Sigma **physical join element** (eager) |
| `join { type: full_outer }` | Sigma **physical join element** |
| `join { type: left_outer / inner }` | Respected in physical joins |
| `sql_on: ${a.key} = ${b.key}` | Parsed into Sigma relationship keys |
| Multiple explores in a model file | Each appears in the explore selector; converted one at a time |

### Join Strategy (user-selectable in the tool)
- **Auto** — many_to_one/one_to_one → relationships; one_to_many/many_to_many/full_outer → physical joins
- **Force Relationships** — all joins become lazy relationships regardless of cardinality
- **Force Physical Joins** — all joins become a pre-joined eager element

### Two-step Save
Models with relationships use two API calls (POST then PUT) to work around a Sigma API ordering requirement for relationships. The PUT body is built from the server-assigned spec returned by the GET, so all element and column IDs are guaranteed to match what the API expects.

---

## ⚠️ Partial / With Caveats

| LookML Construct | Behavior |
|---|---|
| `dimension_group { type: time }` | Creates ONE datetime column — LookML expands to multiple time-grain columns (date, week, month, year); Sigma data models don't — that granularity lives in the workbook layer |
| `type: tier` | Creates a calculated column using the same `sql:` expression as the underlying numeric dimension (e.g. `ROUND((UNIT_PRICE - UNIT_COST) / NULLIF(UNIT_PRICE, 0) * 100, 1)`). The tier bucketing/labeling is dropped — LookML tier syntax has no Sigma equivalent. Appears as a duplicate calculated column alongside the numeric one. |
| `sql_on:` with complex expressions | Only a simple `${a.key} = ${b.key}` equality is auto-parsed. Anything more complex generates a warning and the join keys need manual review |
| Role-playing dimensions (two joins to the same physical table) | One Sigma element is created per physical table. E.g. `order_store` and `ship_store` both pointing to `STORE_DIM` — only one element is created, the second alias gets a warning and must be added manually in Sigma's ERD view |
| `derived_table { sql: ... ;; }` | SQL is extracted correctly including commas and subqueries. `${TABLE}.COL` is stripped to `COL`. Complex Liquid tags or `${view.field}` cross-references are simplified |
| `type: number` with complex `sql:` | Routes through the rule-based converter. Simple patterns (ROUND, DATEDIFF, CASE) convert correctly. Unrecognised expressions fall back to AI if a key is configured, otherwise a warning is shown |
| `measure { filters: [...] }` | Metric is created without the filter condition. An explicit warning is shown explaining what was dropped and how to implement it manually in Sigma |

---

## ❌ Not Converted — Skipped With Warning

### Measure Types
| LookML Type | What Happens |
|---|---|
| `type: running_total` | **Skipped entirely** with warning: "requires a window function — cannot be used in Sigma metrics; add as a calculated column manually." Previously this silently created a `Count()` — that was a bug, now fixed. |
| `type: percent_of_total` | **Skipped entirely** with warning: "no direct equivalent in Sigma metrics; use a calculated column with CumulativeSum or a ratio metric." Previously silently created `Count()`. |

### Dimension Types
| LookML Type | What Happens |
|---|---|
| `type: zipcode` | Maps to a text warehouse column — no geo type in data models |
| `type: location` | Maps to text — no geo type in data models |
| `type: distance` / `type: duration` | Maps to number — formula not generated |

### View-Level Constructs
| Construct | Status |
|---|---|
| `extends: [other_view]` | Not processed — extended fields from parent view not included |
| `refinements` (`+view_name`) | Not processed |
| `access_filter:` | Not converted — handled via Sigma user attributes |
| `always_filter:` / `conditionally_filter:` | Not converted |
| `set: name { fields: [...] }` | Parsed but not used |
| `filter:` named filter fields | Not converted to Sigma controls |
| `parameter:` templated filter fields | Not converted to Sigma controls |
| `sql_always_where:` | Not converted |
| `html:` / `link:` / `action:` on dimensions | Not converted |
| `persist_with:` / `datagroup:` | Not converted (materialization is out of scope) |

### Explore-Level Constructs
| Construct | Status |
|---|---|
| `access_filter:` / `always_filter:` | Not converted |
| `aggregate_table:` | Not converted |
| `symmetric_aggregates: no` / `fanout_on:` | Not converted — worth flagging for customers with fan-out risk |
| Multiple join keys (compound FK) | Only the first `${a.x} = ${b.x}` pair per join is extracted |
| `required_joins:` | Not converted |

---

## Key Talking Points for SEs

**"Why does my relationship not appear?"**
The FK and PK columns must both be defined as `dimension:` fields in their respective views. If either is missing, the converter warns and skips that relationship key. Our ORDER_FACT view explicitly defines all FK dimensions (`customer_key`, `product_key`, `order_store_key`, `ship_store_key`, `promo_key`, `order_date_key`, `ship_date_key`, `return_date_key`) so they're available as relationship targets.

**"Why are my time dimensions not expanding into date/week/month/year columns?"**
LookML generates multiple filter options from one `dimension_group`. Sigma handles time granularity in the workbook, not the data model — so one datetime column per `dimension_group` is correct and maps cleanly.

**"Why did my store join only create one element?"**
The ORDER_FACT explore joins `order_store` and `ship_store`, both pointing to `STORE_DIM`. Sigma's API rejects duplicate `source.path` values, so one element is created and a warning is shown for the second alias. Add that second relationship manually in Sigma's ERD view.

**"The is_active column came through as a calculated column, not just a checkbox."**
`type: yesno` now creates two things: the warehouse column (`IS_ACTIVE`) and a calculated column (`[Is Active] = 1`). This is correct — the boolean expression needs the warehouse column to exist first in order to reference it. The calculated column is what you'd actually use in workbook logic.

**"My filtered measure (online_revenue) lost its filter."**
`filters:` blocks on measures are not converted — the metric is created without the filter condition, and the converter shows an explicit warning. The best approach post-import is a calculated column with `If([Order Channel] = "Online", [Net Revenue], null)` wrapped in a `Sum()`, or a separate Sigma element filtered to that channel.

**"My running_total measure didn't come through at all."**
Correct and intentional. Running totals require a window function which can't be expressed as a Sigma data model metric. The converter skips it with a warning rather than creating a `Count()` that would be silently wrong. Add it as a calculated column in the workbook instead.

**"I have a ROUND() expression in a dimension — will it convert?"**
Yes. The rule-based converter handles `ROUND(expr, n)`, `DATEDIFF('unit', a, b)`, `CASE WHEN col IN (...) THEN ... END`, and arithmetic with `NULLIF`. These produce valid Sigma formulas without needing an AI key. The converter shows an info warning for any calculated column it creates so you can review the output formula.

---

## Warning Types in the Output Panel

| Icon | Meaning |
|---|---|
| ℹ️ | Informational — something was converted but should be reviewed (e.g. calculated column formula, role-playing join) |
| ⚠️ | Partial conversion — something was created but a piece was dropped (e.g. filtered measure, tier bucketing) |
| ⛔ | Skipped — construct cannot be meaningfully converted (e.g. running_total, percent_of_total) |

---

## Test File Summary
Upload `retail_analytics.model.lkml` plus any combination of view files:

| File | Tests |
|---|---|
| `order_fact_view.lkml` | All measure types including unsupported (running_total, percent_of_total — both now skipped with warnings), filtered measure (online_revenue), yesno flags, FK dimensions for relationships |
| `customer_dim_view.lkml` | zipcode type, yesno flags (IS_ACTIVE, IS_EMAIL_OPT_IN), tier type, dimension_group |
| `product_dim_view.lkml` | yesno flags (IS_ACTIVE, IS_PRIVATE_LABEL, IS_SEASONAL), ROUND sql expression, tier type, two dimension_groups |
| `store_dim_view.lkml` | Role-playing join target, yesno flags (IS_ACTIVE, HAS_CAFE, HAS_CURBSIDE), ROUND/NULLIF sql expression, tier type |
| `date_dim_view.lkml` | dimension_group with many timeframes (single-column output), yesno on NUMBER columns, CASE WHEN IN expression |
| `promo_dim_view.lkml` | DATEDIFF sql expression, yesno (IS_STACKABLE), tier type |
| `monthly_summary_derived_view.lkml` | derived_table with multi-table SQL, Custom SQL element output |

**Explore options in the model file:**
- `order_fact` — full star schema with 7 joins (includes role-playing store and date joins)
- `customer_orders` — one_to_many join → tests physical join fallback
- `monthly_revenue_summary` — derived table explore
