# Sigma Data Model Manager

A single-file browser tool for managing [Sigma Computing](https://sigmacomputing.com) data models via the Sigma REST API. Create, edit, import, and validate data models without leaving your browser — no installation required.

## What is this?

The Data Model Manager is a self-contained HTML file that runs entirely in your browser. It connects directly to the Sigma API, lets you edit data model JSON, and includes converters for fourteen BI/semantic layer tools so you can migrate existing definitions to Sigma.

**Key capabilities:**

- **JSON Editor** — View and edit data model JSON with syntax highlighting, formatting, undo/redo (50 steps, Ctrl+Z / Ctrl+Y), and Find & Replace (Ctrl+F)
- **Structure Panel** — Collapsible tree view of all elements, columns, metrics, and relationships; click any item to jump to it in the editor
- **Diff Viewer** — Line-by-line unified diff against the original loaded model (Ctrl+D)
- **AI Assistant** — Generate columns, metrics, descriptions, RLS, and more using natural language (Claude, OpenAI, or Gemini)
- **Fix with AI** — When a save fails, the error banner offers one-click AI repair of common structural issues
- **Converters** — Import from dbt, Snowflake Cortex Analyst, LookML, Tableau, Power BI, Alteryx, Atlan Data Contracts, Omni Analytics, ThoughtSpot TML, Qlik, Oracle Analytics Cloud, Cube.dev, Tableau Prep, and raw SQL
- **Bulk Upload** — Create multiple elements from warehouse tables at once
- **MCP Server** — Use these converters inside Claude Code, Claude Desktop, Cursor, and other MCP-compatible AI tools

## Quick Start

1. Open `index.html` in any modern browser (Chrome, Edge, Firefox, Safari)
2. Enter your Sigma Client ID and Client Secret in the credentials panel
3. Click **Connect** — the tool authenticates and loads your data models
4. Select an existing model or click **New** to create one
5. Edit JSON directly, use the Structure Panel for navigation, or run a converter
6. Click **Save** (or Ctrl+S) to write the model back to Sigma

> Your Client Secret is held in JavaScript memory only — never written to disk, localStorage, or any server. See [Security](#security) for details.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl+F` | Find & Replace |
| `Ctrl+Shift+F` | Format JSON |
| `Ctrl+S` | Save to Sigma |
| `Ctrl+D` | Open Diff viewer |
| `Escape` | Close any open panel or modal |

---

## Converters

### Tableau

Converts Tableau workbooks (`.twb`, `.twbx`) and data sources (`.tds`, `.tdsx`) to Sigma data model JSON.

**What gets converted:**
- Data sources → Sigma elements with warehouse table paths (standard joins, virtual connections, custom SQL)
- Virtual connections (type=collection) → Tableau 2020.2+ relationship model with role-playing dimensions
- Joins / Relationships → Sigma relationships on the fact element. Tableau 2020.2+ relationship model ("noodles") maps 1:1 to Sigma relationships — both tools resolve join type and granularity at viz time, so no semantic information is lost. Cardinality hints (1:1, 1:N, N:1, N:N) are preserved when present and default to N:1 (the dominant fact-to-dim pattern) when Tableau leaves them unspecified. Pre-2020.2 physical joins (older Tableau Server on-prem versions back to 2018.x) are handled via the Join Strategy dropdown: Auto routes many-to-one joins to relationships and others to physical joins; Force Relationships keeps everything lazy; Force Physical Joins keeps everything eager.
- Calculated fields → Sigma calculated columns with formula conversion
- Simple aggregates → Sigma metrics (SUM, COUNT, AVG, MIN, MAX, COUNTD)
- Statistical / regex / date-construction functions → `STDEV`→`StdDev`, `VAR`→`Variance`, `VARP`→`VariancePop`, `STDEVP`→`Sqrt(VariancePop(…))`, `PERCENTILE`→`PercentileCont`, `REGEXP_EXTRACT/MATCH/REPLACE`→`Regexp*`, `SPLIT`→`SplitPart`, `MAKEDATE`→`MakeDate`, and `DATEPARSE(fmt, str)`→`DateParse(str, "<strftime>")` (arg order reversed; Java date tokens rewritten to strftime — review the pattern)
- User functions / row-level security → User-context functions are translated (`USERNAME()`→`CurrentUserEmail()`, `ISMEMBEROF('g')`→`CurrentUserInTeam("g")`, `USERATTRIBUTE('a')`→`CurrentUserAttributeText("a")`, `ISUSERNAME('u')`→`CurrentUserEmail() = "u"`). Calcs that test the viewer's identity (the classic Tableau RLS / data-source-filter pattern) are detected and **reported, not injected**: the converter emits a 🔐 conversion note (and an RLS-rules badge) carrying the translated boolean formula plus the user attributes/teams to provision — it does NOT add the calc column to the spec (a converter can't provision Sigma user attributes/teams; an injected filter would fail-closed to 0 rows for everyone). After saving, provision the listed attribute(s)/team(s), then apply the boolean calc column + an element filter keeping only `True` rows.
- Parameters → Sigma controls (list, date-range, text)
- LOD FIXED / INCLUDE / EXCLUDE expressions → A `kind:sql` helper element per unique GROUP BY signature, plus a relationship from the base element. Multiple LODs that share the same effective grouping share one helper element. View context for INCLUDE/EXCLUDE is derived from worksheet rows/cols shelves.
- Sets → Boolean calculated columns in a "Sets" folder; condition sets → formula column, member sets → `In([Field], ...)` column. If a set's formula references a related-element column, the set column is automatically moved to the derived element and scrubbed from the source element's "Sets" folder so the model saves cleanly
- Bins → Bucketed `Floor()` calculated columns
- Window / table calculations (`RUNNING_SUM`, `RUNNING_AVG/MIN/MAX`, `WINDOW_SUM/AVG/MIN/MAX/COUNT`, `LOOKUP`, `PREVIOUS_VALUE`, `RANK`, `RANK_DENSE`, `RANK_UNIQUE`, `INDEX`, `FIRST`, `LAST`) → A `kind:sql` helper element with explicit Snowflake `OVER()` clauses (Sigma's DM formulas have no working partitioned/ordered window equivalents). Partition keys come from worksheet `rows` shelves; order keys from time-truncated `cols` shelves. Multiple window calcs sharing the same partition+order share a single helper.
- Top N / Bottom N sets (global, parameterized, partitioned) → A `kind:sql` RANK helper element + relationship from the base on the dim key (and partition cols, if any). Helper exposes an `IS_TOP_N` boolean. Literal-N sets compute the boolean in SQL; parameter-driven N emits a Sigma calc col `[Rank] <= [Control]` plus a `number` control with the Tableau parameter's default value. Bottom-N swaps `DESC` → `ASC`.

**Known limitations:**
- LOD INCLUDE / EXCLUDE without worksheet context — When a calc field is not placed on any worksheet's rows/cols shelf, the converter cannot derive the view dimensions and the LOD is skipped with a warning. Place the calc on at least one worksheet so the converter can determine the effective grouping.
- Window calc partition/order heuristic — Partition dims come from rows shelves, order dims from time-truncated cols shelves (`mn:`/`yr:`/`qr:`/`dy:` prefixes). Other Tableau "Compute Using" addressing modes (Pane, Cell, Specific Dimensions) are not yet parsed; if the heuristic mis-derives the grouping, edit the helper element's SQL after import.
- Window helper grain — Window-helper SQL uses `DATE_TRUNC('month', ...)` as the default order grain. If your worksheet uses year/quarter/day grain, edit the SQL after import.
- Post-create validation — After saving, call `GET /v2/dataModels/{id}/columns` and inspect for `type.type === "error"` entries; both LOD and window helpers can post as success even if a referenced column is missing.
- Cross-element calculated columns — Automatically moved to the derived child element; metrics with cross-element refs are removed with a warning and must be added manually in Sigma UI
- Role-playing dimensions — Supported; each relationship includes the join key in its name (e.g. "DATE_DIM via Order Date Key")
- Custom SQL data sources — Converted to Sigma custom SQL elements; Tableau-specific SQL syntax may need manual adjustment
- Extracts (`.hyper`) — Extract-only fields and extract filters not converted
- Data blending — Multi-connection sources not supported; each data source converted independently

**Useful resources:** [Tableau LOD Calculations in Sigma](https://help.sigmacomputing.com) · [Period over Period Comparisons](https://help.sigmacomputing.com) · [Rollup Function](https://help.sigmacomputing.com)

---

### Power BI

Converts Power BI models (`.pbit`, `.bim`, or `.json`) to Sigma data model JSON. Parses tables, columns, DAX measures, calculated columns, and relationships.

**What gets converted:**
- Tables → Sigma elements; source paths extracted from M expressions
- Columns → Sigma columns with display names
- Relationships → Sigma relationships (fromTable = many side, toTable = one side)
- Fact tables with outgoing relationships → derived element surfacing own + related columns via cross-element formulas
- DAX measures → Sigma metrics with formula conversion
- Calculated columns → Sigma calculated columns
- Display folders → Sigma folders
- Measures-only tables → Measures moved to the fact element
- `CALCULATE` (simple) → `SumIf` / `CountIf` with correct argument order
- `DIVIDE` → Null-safe division with `If(den = 0, alt, num / den)`
- Math functions → `LN`→`Ln`; `LOG10` and `LOG(x, [base])`→Sigma `Log(value, [base])` (base-10 default matches DAX); `CEILING/FLOOR(n, significance)`→`Ceiling(n / s) * s` / `Floor(n / s) * s` (Sigma's Ceiling/Floor have no significance argument)

**DAX patterns that generate warnings:**
- `CALCULATE` + `ALL` / `ALLEXCEPT` → Use groupings for different aggregation contexts
- Iterators (`SUMX`, `AVERAGEX`) → Use groupings or calculated columns
- Time intelligence (`TOTALYTD`, `SAMEPERIODLASTYEAR`) → Use Period over Period feature
- `VAR` / `RETURN` blocks → Break into multiple calculated columns

**Known limitations:**
- M expression parsing — Works for common data sources (Snowflake, SQL Server, BigQuery, Databricks); complex Power Query with parameters or custom functions may not extract paths correctly
- Complex DAX — `CALCULATE` with `ALL` / `ALLEXCEPT`, iterators, time intelligence, and `VAR` / `RETURN` generate warnings but are not auto-converted
- Composite models — DirectQuery vs Import mode distinction not preserved
- Calculation groups — Not converted
- Row-level security — Simple equality filters (e.g. `[Region] = "East"`) converted to Sigma RLS using `CurrentUserAttributeText()`; complex DAX filter expressions generate a warning

**Useful resources:** [Complex Leveled Aggregations](https://help.sigmacomputing.com) · [Sigma Differences from Other BI Tools](https://help.sigmacomputing.com) · [Period over Period Comparisons](https://help.sigmacomputing.com)

---

### LookML

Converts LookML projects (multiple `.lkml` files) to Sigma data model JSON. Drop multiple files at once — explores and their joined views are resolved across files automatically.

**What gets converted:**
- Views with `sql_table_name` → Sigma elements with warehouse paths
- Derived tables (SQL) → Sigma custom SQL elements; PDT views referenced via `${view.SQL_TABLE_NAME}` are auto-converted into their own Custom SQL element and referenced via `sigma_element('Name')`
- Dimensions → Sigma columns with formula conversion; complex SQL expressions auto-converted
- Tier dimensions → Bucketed `If()` calculated columns (e.g. "0 to 99", "100 to 499")
- Yesno dimensions → Boolean calculated columns with "(T/F)" suffix
- Measures → Sigma metrics (`sum`, `count`, `count_distinct`, `average`, `min`, `max`, `median`, `percentile`); `type:percentile` → `Percentile([Col], p/100)` using the measure's `percentile:` param
- Ratio / computed measures → A `type:number` measure whose `sql:` references other measures (e.g. `1.0 * ${total_revenue} / NULLIF(${order_count}, 0)`) is emitted as a metric: each `${measure}` is substituted with that measure's Sigma aggregate formula and SQL funcs are mapped (`NULLIF→NullIf`, `COALESCE/NVL/IFNULL→Coalesce`, `IFF/IIF→If`) — no longer split into a phantom physical column (which turned `1.0` into `0`)
- Legacy `case: { when … else }` dimensions → Nested `If(cond, "label", If(…))` calculated columns (previously a passthrough to a nonexistent physical column)
- Explore joins → Sigma relationships + a derived explore element surfacing base-view and directly-joined-view fields together (including named/computed joined columns such as dimension_group DateTrunc timeframes and CASE dims, referenced by display name); snowflake joins (FK on another joined view) wire to the correct intermediate element and are reachable via the relationship graph
- All Explores mode → Batch-converts all explores into one combined data model; shared views are deduplicated
- Dimension groups (type:time) → One column per timeframe (DateTrunc / DatePart), grouped into a folder
- Dimension groups (type:duration) → `DateDiff()` columns per interval (day, week, month, etc.), grouped into a folder
- `datatype: epoch` → `DateFromUnix()` wrapper applied automatically
- `percent_of_total` → `Sum([Col]) / GrandTotal(Sum([Col]))`
- `running_total` → `CumulativeSum([Col])`
- Filtered measures → Conditional aggregates: `SumIf([Col], [Filter] = "value")`; a filtered `type:count` → `CountIf(condition)` referencing only the filter columns (no fabricated value column from the measure name)
- `extends` / `refinements` → Merged automatically when both files are uploaded

**Expression conversion:**

| LookML SQL | Sigma formula |
|---|---|
| `CASE WHEN … THEN … END` | `If(…, …, …)` |
| `CONCAT(a, b)` | `a & b` |
| `SPLIT_PART(col, delim, n)` | `splitpart([Col], "delim", n)` |
| `ROUND(x, n)` | `Round(x, n)` |
| `DATEDIFF('day', a, b)` | `DateDiff("day", [A], [B])` |
| `NULLIF(x, 0)` | `If(x = 0, null, x)` |
| `COALESCE(a, b)` | `Coalesce([A], [B])` |
| `${TABLE}.col_name` | `[Col Name]` |

**Known limitations:**
- Liquid templating — `{% %}` and `{{ }}` blocks are stripped with warnings. `html:`, `sql_on:`, `sql_where:`, `sql_table_name:`, and `sql_trigger_value:` blocks are pre-extracted alongside `sql:` before tokenizing, so Liquid `%}` inside an `html:` block no longer desyncs the parser and silently drops subsequent fields
- Cross-element columns — Calculated columns referencing joined view columns are automatically moved to the derived explore element; metrics with cross-element refs must be added manually in Sigma UI
- Fiscal timeframes — Skipped with a warning (require `fiscal_month_offset` from model-level config)
- Access filters — `access_filter` blocks converted to Sigma RLS using `CurrentUserAttributeText()`; `access_grant` blocks not converted
- Trailing comma before SQL keywords, incremental PDT leading-comma CTEs, Snowflake `::TYPE` cast shorthand — All automatically corrected with warnings
- Snowflake (multi-hop) joins — Wired correctly to the intermediate element, but second-hop columns are not surfaced in the single flat derived explore element (reach them via the relationship graph or that element's own derived view)

**Useful resources:** [Groupings & Aggregate Calculations](https://help.sigmacomputing.com) · [Running Total / CumulativeSum](https://help.sigmacomputing.com)

---

### dbt

Converts dbt semantic model YAML files and `semantic_manifest.json` artifacts to Sigma data model JSON. Implements the same conversion logic as the [official Sigma GitHub Action](https://github.com/sigmacomputing/dbt-sigma-action), adapted for standalone use.

**What gets converted:**
- Semantic models → Sigma elements; warehouse path from `node_relation`, `model: ref()`, or `source()`. Both YAML shapes are accepted: the canonical `semantic_models:` list and the newer dbt model-level form (`models[].semantic_model` + `columns[]` with inline `entity:` / `dimension:` / `measure:` blocks + nested `metrics:`)
- Entities (primary / unique) → Join-key columns
- Entities (foreign) → Sigma relationships + a derived element surfacing all own + related dimension columns. If a referenced dim isn't included in the upload, the FK column is still materialized on the source element (with a warning) so it appears in Sigma even without the wired relationship
- Dimensions (categorical) → Sigma columns with formula conversion
- Dimensions (time) → `DateTrunc("granularity", [col])` columns
- Measures → Sigma metrics when not referenced by a `metrics:` entry; `filter:` → conditional aggregates (`SumIf`, `CountIf`, etc.)
- Metrics (simple / ratio / derived) → Named Sigma metrics with metric-level filters; referenced measures are suppressed to avoid duplicates. `description` from the metric block is preserved on the emitted Sigma metric.
- Descriptions → `description` fields on entities, dimensions, measures, and top-level metrics are all copied onto the corresponding Sigma column or metric
- Time spine (via `semantic_manifest.json`) → `ts_<granularity>` elements with `agg_time_dimension` relationships
- Multi-file upload → Drop any number of YAML files; cross-file entity relationships resolve automatically

**Expression conversion:**

| dbt expr | Sigma formula |
|---|---|
| `CASE WHEN … THEN … END` | `If(…, …, …)` |
| `CONCAT(a, b)` | `a & b` |
| `ROUND(x, n)` | `Round(x, n)` |
| `DATEDIFF('day', a, b)` | `DateDiff("day", [A], [B])` |
| `NULLIF(x, 0)` | `If(x = 0, null, x)` |
| `COALESCE(a, b)` | `Coalesce([A], [B])` |
| `IN (v1, v2)` | `arraycontains(array(v1, v2), [col])` |
| `{{ Dimension('model__col') }}` | `[Col Name]` |

**Known limitations:**
- Warehouse paths — For exact paths, use `node_relation` or upload `semantic_manifest.json`; `model: ref('name')` alone uses the model name as the table name
- Jinja & macros — `ref()` and `source()` strings extracted for path resolution; custom macros and `env_var()` not evaluated
- Time spine — Requires `project_configuration.time_spines` from `semantic_manifest.json`; not available from standalone YAML files
- Derived metric chains — One level of metric-to-metric nesting resolved; deeper chains may produce incomplete formulas

**Useful resources:** [dbt Semantic Models](https://docs.getdbt.com/docs/build/semantic-models) · [MetricFlow Time Spine](https://docs.getdbt.com/docs/build/metricflow-time-spine) · [Official Sigma dbt Action](https://github.com/sigmacomputing/dbt-sigma-action)

---

### Snowflake (Cortex Analyst)

Converts Snowflake Cortex Analyst semantic view YAML files to Sigma data model JSON.

**What gets converted:**
- Tables with `base_table` → Sigma elements with database / schema / table paths
- Dimensions → Sigma columns (text, number, date based on `data_type`); complex `expr` values auto-converted
- Time dimensions → Sigma columns (datetime type)
- Facts → Sigma columns + optional `Sum()` metrics when "Auto-generate metrics" is checked
- Relationships → Sigma relationships using target table name; source tables with outgoing relationships get a derived element surfacing all own + related columns
- Descriptions → Preserved on elements and columns; `synonyms:` appended as "Also known as: …" for natural language discoverability

**Expression conversion:**

| Snowflake YAML expr | Sigma formula |
|---|---|
| `CASE WHEN … THEN … END` | `If(…, …, …)` |
| `CONCAT(a, b)` | `a & b` |
| `ROUND(x, n)` | `Round(x, n)` |
| `DATEDIFF('day', a, b)` | `DateDiff("day", [A], [B])` |
| `NULLIF(x, 0)` | `If(x = 0, null, x)` |
| `COALESCE(a, b)` | `Coalesce([A], [B])` |

**Known limitations:**
- No Snowflake SQL execution — parses YAML definition only; does not validate column existence
- Unsupported SQL functions (FLATTEN, LATERAL, QUALIFY, PIVOT, etc.) — automatically skipped with a warning
- Semantic view filters — Not converted; add as RLS in Sigma after import
- Multiple semantic views in one YAML — All tables merged into a single Sigma data model

**Useful resources:** [Cortex Analyst Semantic Model Spec](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst/semantic-model-spec)

---

### Alteryx

Converts Alteryx workflows (`.yxmd`) to Sigma data model JSON. Parses Input Data tools, Join tools, Formula tools, Summarize tools, Select tools, and Filter tools.

**What gets converted:**
- Input Data tools → Sigma elements with warehouse table paths (from ODBC connection strings)
- Join tools → Sigma relationships + a derived element surfacing all own + joined columns
- Formula tools → Calculated columns with formula conversion (IF/ELSEIF, CASE WHEN, CONCAT, SPLIT_PART)
- Summarize tools → Sigma metrics (Sum, Avg, Min, Max, Count, CountDistinct, CountNonNull)
- Filter tools → Informational warnings; consider adding as RLS via the AI Assistant

**Supported formula conversions:**
- **Conditional:** `IF/ELSEIF/ELSE/ENDIF`, `IIF`, `CASE WHEN … END` → nested `If()`
- **String:** `ToString`, `Uppercase`, `Lowercase`, `Trim`, `Left`, `Right`, `Substring`, `Length`, `Contains`, `CONCAT` → `&`, `SPLIT_PART` → `splitpart()`
- **Math:** `Abs`, `Ceil`, `Floor`, `Round`, `Sqrt`, `Pow`, `Log`
- **Date:** `DateTimeYear`, `DateTimeMonth`, `DateTimeDay`, `DateTimeDiff`, `DateTimeAdd`, `DateTimeTrim`
- **Null:** `IsNull`, `IsEmpty`, `NULL()`

**Known limitations:**
- ETL vs semantic model — Intermediate transformations (Union, Append, Transpose, Cross Tab) are simplified or ignored
- Complex formulas — Multi-row formulas, spatial functions, and custom macros generate warnings but are not converted
- Non-ODBC inputs — File inputs (CSV, Excel) and API inputs may produce incorrect source paths
- Analytic tools — Predictive and spatial tools are ignored entirely

---

### Atlan Data Contracts

Converts Data Contract Specification YAML files to Sigma data model JSON. Compatible with contracts from Atlan, Databricks, dbt, and the `datacontract` CLI.

**What gets converted:**
- Models → Sigma elements with warehouse table paths
- Fields → Sigma columns with display names and descriptions
- References → Sigma relationships + a derived element surfacing all own + referenced model columns
- Primary keys → Used as relationship target columns
- Numeric fields → Auto-generated `Sum()` metrics (excluding key columns)
- Field descriptions → Preserved as column descriptions

**Supported input formats:** Data Contract Specification (`.datacontract.yaml`) and JSON format.

**Known limitations:**
- No computed columns — Contracts define schema, not computation logic; add calculated columns in Sigma after import
- Quality rules, SLA / governance blocks — Skipped; no Sigma equivalent
- Complex YAML features (anchors, multi-document, flow sequences, block scalars) — May not parse correctly; convert to JSON first if parsing fails
- Field constraints (enum, min/max, pattern, required, unique) — Informational only; not enforced in the Sigma model

**Useful resources:** [Data Contract Specification](https://github.com/datacontract/datacontract-specification) · [Atlan Data Contracts](https://atlan.com)

---

### Omni Analytics

Converts Omni Analytics model files (`.view.yaml` and `.model.yaml`) to Sigma data model JSON.

**What gets converted:**
- Views with `sql_table_name` → Sigma elements; path parsed from the fully-qualified table name
- Derived tables → Sigma elements with a warning to complete the source path manually
- Dimensions → Sigma columns; `${TABLE}.col` and `${field}` references translated to Sigma syntax
- Dimensions (type:time) → One column per timeframe using `DateTrunc()`
- Dimensions (type:yesno) → Boolean calculated columns
- Measures → Sigma metrics with appropriate aggregation; filtered measures → conditional aggregates
- Explores + joins → Sigma relationships; `sql_on` parsed to extract FK/PK pairs; base view with joins gets a derived element surfacing all own + joined columns
- Multi-file drop → Drop all `.view.yaml` and `.model.yaml` files at once

**Expression conversion:**

| Omni SQL | Sigma formula |
|---|---|
| `${TABLE}.col_name` | `[Source Table/Display Col Name]` |
| `${field_name}` | `[Display Field Name]` |
| `CASE WHEN … END` | `If(…, …, …)` |
| `expr IN (a, b, c)` | `(expr = a Or expr = b Or expr = c)` |
| `'string'` | `"string"` |
| `MONTH(x)`, `CONCAT(…)`, `ROUND(…)`, `DATEDIFF(…)`, `NULLIF(…)` | `Month(x)`, `Concat(…)`, `Round(…)`, `DateDiff(…)`, `Nullif(…)` |

**Known limitations:**
- Role-playing dimensions — If the same view is joined multiple times under different aliases, only one relationship per target view is created; add duplicates manually
- Topics — Omni Topics (curated field subsets) have no direct Sigma equivalent; ignored
- `extends` / refinements — View inheritance not resolved across files; upload all parent and child view files together
- Cross-view `sql` references — `${other_view.field}` table qualifier stripped; resulting formulas may fail Sigma validation if the column is on a different element

**Useful resources:** [Omni Analytics — Views](https://docs.omni.co) · [Omni Analytics — Explores & Joins](https://docs.omni.co)

---

### ThoughtSpot TML

Converts ThoughtSpot Modeling Language (TML) files — worksheets and models exported from ThoughtSpot — to Sigma data model JSON. Parses physical tables, join relationships, calculated formulas, and column types.

**What gets converted:**
- `tables[]` → One Sigma warehouse-table element per table, with database/schema from TML or overrides
- `worksheet_columns` / `columns` → Sigma columns (ATTRIBUTE/DATE types) and metrics (MEASURE type with aggregation)
- `formulas[]` → Sigma calculated columns; `if/then/else`, `sum()`, `count_distinct()`, `unique count()`, `median()`, `safe_divide()`, `isnull()`, `date_diff()`, and `in {}` converted to Sigma syntax (single-quoted TML string literals become double-quoted)
- Window functions (`cumulative_sum`/`running_total`, `moving_average`, `rank`/`rank_desc`, `lag`/`lead`, `first`/`last`, …) → an auto-built grouped child element carrying the Sigma window calc (`CumulativeSum`, `MovingAvg`, `Rank`, `Lag`, …) plus a flagged Null placeholder column on the host element — Sigma window functions silently error in data-model calc columns, so they only ever land in grouped elements; cross-element dims group on the host's derived join view
- Date functions (`start_of_week/month/quarter/year`→`DateTrunc`, `month_number`/`quarter_number`/`day_of_week`→`Month`/`Quarter`/`Weekday`), math/string (`pow/sqrt/round/concat/substr/strlen/upper/lower/…`), and `ifnull`/`coalesce`→`Coalesce`
- Conditional aggregates → `sum_if(cond, measure)`→`SumIf(measure, cond)` (condition moves to the 2nd arg; same for `avg_if`/`max_if`/`min_if`/`unique_count_if`), `count_if(cond)`→`CountIf(cond)`
- `joins[]` → Sigma `N:1` relationships; join key columns matched by physical name
- `table_paths[]` → Resolves `ALIAS::Column` column_ids to actual table names
- Aggregations: SUM → Sum, COUNT → Count, COUNT_DISTINCT / `unique count` → CountDistinct, AVERAGE → Avg, MAX → Max, MIN → Min, MEDIAN → Median, STD_DEVIATION → StdDev, VARIANCE → Variance

**Known limitations:**
- Complex nested join paths resolved to leaf table only — intermediate logic not preserved
- Row-level security rules and access control expressions are not converted
- Window functions embedded in a larger expression (e.g. `cumulative_sum(x, d) / 100`) can't be decomposed into one grouped element — they degrade to a flagged Null column with the original expression in its description for manual re-authoring
- Formula columns with no resolvable `formula_id` or `column_id` are skipped with a warning

**Expression conversion:**

| ThoughtSpot | Sigma |
|---|---|
| `if (cond) then X else Y` | `If(cond, X, Y)` |
| `sum(Revenue)` | `Sum([Revenue])` |
| `count_distinct(CustomerID)` / `unique count (CustomerID)` | `CountDistinct([CustomerID])` |
| `median(Revenue)` | `Median([Revenue])` |
| `'literal'` | `"literal"` |
| `cumulative_sum(m, dim)` | grouped element with `CumulativeSum([m])` + Null placeholder on host |
| `moving_average(m, 2, 1, dim)` | grouped element with `MovingAvg([m], 2, 1)` |
| `rank_desc(sum(m), dim)` | grouped element with `Rank([base], "desc")` |
| `lag(m, dim, 1)` | grouped element with `Lag([m], 1)` |
| `safe_divide(a, b)` | `If(IsNull(b) or b = 0, null, a / b)` |
| `col in {A, B, C}` | `In([col], List(A, B, C))` |
| `isnull(x)` | `IsNull(x)` |
| `date_diff(unit, start, end)` | `DateDiff(unit, start, end)` |
| `today()` | `Today()` |

**How to export TML from ThoughtSpot:**
1. Go to **Data** → **Worksheets** → click ⋯ → **Export TML**
2. Or bulk export via **Develop** → **SpotApps** → **Export TML**

**Useful resources:** [ThoughtSpot TML Reference](https://developers.thoughtspot.com/docs/tml) · [Worksheet TML](https://developers.thoughtspot.com/docs/tml-worksheets) · [TML Import/Export](https://developers.thoughtspot.com/docs/tml-import-export)

---

### IBM Cognos Data Module

Converts an IBM Cognos Analytics (11.x+) **Data Module JSON** — the modern semantic layer retrieved via `GET /api/v1/objects/{moduleId}?fields=specification` or exported from the Cognos data-module editor — to Sigma data model JSON. Parses query subjects (physical tables), query items, calculations, measures, and join relationships.

**What gets converted:**
- `querySubject[]` → One Sigma warehouse-table element per query subject; the physical table is the tail of `ref: ["M1.ORDER_FACT"]` (→ `ORDER_FACT`), with database/schema from the module or the override fields
- `queryItem` (attribute / identifier) → Sigma column (the business label is preserved via the column `name`)
- `queryItem` (fact / measure + `regularAggregate`) → Sigma metric — `total`→`Sum`, `average`→`Avg`, `count`→`Count`, `maximum`→`Max`, `minimum`→`Min`
- `calculation` → calculated column, or a metric when the expression aggregates
- `relationship[]` → Sigma relationship; the source side is the **many** side (from `maxcard`), join columns come from `link[].leftRef/rightRef` (or are parsed from an equi-join `expression`). The relationship name is the UPPERCASE target table key.

**Expression conversion:**

| Cognos | Sigma |
|---|---|
| `total([X])` | `Sum([X])` (and `average/count/maximum/minimum` → `Avg/Count/Max/Min`) |
| `total([X] for [A],[B])` | `SumOver([X], [A], [B])` |
| `if (cond) then (X) else (Y)` | `If(cond, X, Y)` |
| `_add_days/_add_months/_add_years(d, n)` | `DateAdd("day"/…, n, d)` |
| `_days_between(a, b)` | `DateDiff("day", b, a)` |
| `extract(year, d)` | `DatePart("year", d)` |
| `substring/substr` | `Mid`; `upper/lower/trim` → `Upper/Lower/Trim` |
| `substitute(pat, rep, src)` | `RegexpReplace(src, pat, rep)` |
| `cast(x AS varchar)` / `varchar(x)` | `Text(x)`; `decimal/double(x)` → passthrough |
| `abs/round/floor/ceiling/sqrt/ln/mod/power` | `Abs/Round/Floor/Ceiling/Sqrt/Ln/Mod/Power` |
| `\|\|` / single quotes | `&` / double quotes |

**Known limitations (flagged, never faked):**
- Window / running calcs — `running-total`, `moving-average`, `rank`, `percentile`, `quantile`, `tertile` — are passed through with a warning; they need manual authoring
- Any unrecognized `function()` is left as-is and flagged for manual review
- Composite / conditional joins (multiple `AND`/`OR` predicates) are not auto-wired — add the relationship manually in Sigma
- Data-module **security filters** (row-level security) are **detected and reported** in the warnings — never injected into the spec. Re-create them in Sigma after saving (boolean calc column + element filter scoped via user attributes/teams)
- Framework Manager `.cpf`, report-spec XML, dashboards, and sub-queries are out of scope (Data Module JSON only)

**How to get the Data Module JSON:**
1. **REST**: `GET /api/v1/objects/{moduleId}?fields=specification` and save the module specification JSON
2. **Cognos UI**: open the data module → ⋯ menu → Export specification (JSON)

**Useful resources:** [IBM Cognos Analytics Docs](https://www.ibm.com/docs/en/cognos-analytics) · [Cognos Data Modules](https://www.ibm.com/docs/en/cognos-analytics/latest?topic=modeling-data-modules)

---

### Qlik Sense

Converts Qlik Sense data model metadata (from the REST API or Engine API) to Sigma data model JSON. Parses tables, fields, automatically inferred associations, master measures, and master dimensions.

**What gets converted:**
- Tables → Sigma elements (one per Qlik data model table)
- Fields → Sigma columns with display names (`FIELD_NAME` → `Field Name`)
- Associations → Sigma relationships; direction inferred from row counts and field cardinality
- Master Measures → Sigma metrics with formula conversion (bare/unbracketed field refs are bracketed and mapped to display names)
- Master Dimensions (calculated) → Sigma calculated columns
- Range / binning functions → `RangeSum`→`Coalesce(a,0)+…`, `RangeAvg`→fixed-denominator mean, `RangeMin/Max`→`Least/Greatest`, `Class(field, n[, label, start])`→`Floor((field - start) / n) * n + start` (numeric lower bound of each bin)
- System tables and fields ($ prefix, %synthetic keys) → Skipped automatically

**How to get the metadata:**

```bash
# Qlik Cloud REST API
GET https://<tenant>.us.qlikcloud.com/api/v1/apps/<appId>/data/metadata
Authorization: Bearer <API_KEY>

# Qlik CLI
qlik app data metadata get --app-id <appId> > metadata.json
```

**QVD file support:** drop one or more `.qvd` files (QlikView / Qlik Sense data extracts). The converter reads the XML header (table name, fields, types, distinct counts) and skips the binary data — Sigma re-pulls from the warehouse on save. Shared field names across multiple QVDs auto-create relationships. Note: QVDs don't contain the load script, so set the Database/Schema overrides for the warehouse path; master measures/dimensions aren't stored in QVDs (use the REST API path for those).

To include master measures and master dimensions, use the extended format:
```json
{
  "appName": "My App",
  "tables": [ /* from /data/metadata */ ],
  "masterMeasures": [
    { "title": "Total Sales", "expr": "Sum([Sales Amount])" }
  ],
  "masterDimensions": [
    { "title": "High Value", "fieldDef": "=If([Revenue] > 10000, 'Yes', 'No')" }
  ]
}
```

**Expression conversion:** Most Qlik functions share Sigma's syntax directly. Notable mappings: `Only([Field])` → `[Field]`, `Text([Field])` → `ToString([Field])`, `IsNum([Field])` → `IsNumber([Field])`, `Log([x])` → `Ln([x])`, `Fmod(a, b)` → `Mod(a, b)`. Set Analysis expressions generate a warning — use `SumIf` / `CountIf` in Sigma instead.

**Known limitations:**
- Source paths — REST API metadata does not include database or schema; use the Database / Schema override fields
- Synthetic keys — `%SyntheticKey%` bridge tables are filtered out; review relationships manually for complex many-to-many joins
- Master items — Not returned by `/data/metadata`; use the extended JSON format above
- Set Analysis — Skipped with a warning; no direct Sigma equivalent

**Useful resources:** [Qlik Cloud REST API](https://qlik.dev/apis/rest/apps/) · [Qlik Engine API](https://qlik.dev/apis/engine/)

---

### Oracle Analytics Cloud (OAC)

Converts Oracle Analytics Cloud semantic models exported from the Semantic Modeler (SMML format) to Sigma data model JSON.

**How to export from OAC:**
1. In OAC, open the Semantic Modeler
2. Click the ⋯ menu on your semantic model
3. Choose **Export** — OAC downloads a `.zip` in SMML (Semantic Modeler Markup Language) format
4. Drop the `.zip` directly into the converter (or upload individual logical table `.json` files)

**What gets converted:**
- Logical tables → Sigma elements; physical table path resolved from the `physical/` layer in the export ZIP
- Dimension columns → Sigma dimension columns with warehouse column references
- Measure columns (SUM, AVG, COUNT, COUNT_DISTINCT, MIN, MAX, MEDIAN, STD_DEV) → Sigma metrics; underlying physical column preserved in columns for formula references
- Derived / calculated columns → Sigma calculated column formulas with OAC Logical SQL function remapping
- Joins → Sigma relationships; join keys inferred by matching column names between logical tables

**Expression conversion:**

| OAC Logical SQL | Sigma formula |
|---|---|
| `NVL(a, b)` | `Coalesce(a, b)` |
| `SUBSTR` / `SUBSTRING` | `Mid()` |
| `INSTR()` | `Search()` |
| `LENGTH()` | `Len()` |
| `TO_CHAR()` | `Text()` |
| `TO_DATE()` | `Date()` |
| `TO_NUMBER()` | `Number()` |
| `TIMESTAMPADD()` / `TIMESTAMPDIFF()` | `DateAdd()` / `DateDiff()` |
| `SQL_TSI_DAY` / `SQL_TSI_MONTH` etc. | `"day"` / `"month"` etc. |
| `CURRENT_DATE` | `Today()` |
| `CASE WHEN … END` | `If(…, …, …)` |
| `expr IN (a, b, c)` | `In(expr, a, b, c)` |

**Known limitations:**
- OAC time series functions (`AGO()`, `TODATE()`, `PERIODROLLING()`) — No direct Sigma equivalent; converted with a warning for manual review
- `FILTER(measure USING condition)` — Use `SumIf()` / `CountIf()` in Sigma instead
- `EVALUATE()` — Native SQL pass-through; no Sigma equivalent
- Join keys — Inferred by column name matching; may require manual configuration in Sigma if no match found
- Level-based hierarchies — Not converted; configure in the Sigma data model editor after import
- Classic RPD files (`.rpd`) — Not supported; convert to SMML using Oracle's tools first

**Useful resources:** [Oracle — What is SMML?](https://docs.oracle.com/en/cloud/paas/analytics-cloud/acabi/whats-smml.html)

---

### SAP BusinessObjects Universe

Converts a SAP BusinessObjects **universe** (the semantic layer) to Sigma data model JSON. Input is the universe metadata from the BI RESTful Web Service (RWS) — `GET /biprws/sl/v1/universes/{id}` on an on-prem BO 4.x server. The ingest is tolerant of the common RWS shape variants (nested outline/items folders, class/objects, or a flat `objects[]` array).

**How to export from BusinessObjects:**
1. Authenticate: `POST /biprws/logon/long` → logon token
2. List universes: `GET /biprws/sl/v1/universes`
3. Fetch one universe's metadata: `GET /biprws/sl/v1/universes/{id}` (with `Accept: application/json`)
4. Drop the resulting `.json` into the converter (or paste it)

**What gets converted:**
- Physical tables → Sigma elements (one per table); warehouse path from the table name, with optional Database / Schema overrides
- Dimensions / details → Sigma columns; the universe business name is preserved via `name` while the formula references the physical column
- Measures → Sigma metrics (Sum / Count / Count Distinct / Avg / Min / Max / StdDev / Variance) of the underlying column
- Object expressions (functions, CASE, concatenation) → Sigma calculated columns
- Joins → Sigma relationships; FK/PK keys parsed from the join `Table.col = Table.col` SQL; tables with outgoing joins also get a denormalized **View** element exposing own + joined columns

**Expression conversion:**

| BusinessObjects | Sigma formula |
|---|---|
| `Table.Column` / `"Table"."Column"` | `[Column Name]` |
| `SUBSTR` / `SUBSTRING` | `Mid()` |
| `NVL` / `IFNULL` | `Coalesce()` |
| `INSTR` / `LENGTH` | `Search()` / `Len()` |
| `TO_CHAR` / `TO_DATE` / `TO_NUMBER` | `Text()` / `Date()` / `Number()` |
| `CURRENT_DATE` / `SYSDATE` | `Today()` |
| `\|\|` (concat) | `&` |
| `CASE WHEN … END` | `If(…, …, …)` |

**Known limitations:**
- Predefined filters / conditions — emitted as warnings only (report-time WHERE clauses, no data-model equivalent); re-create as Sigma filters/controls
- Universe `@`-functions (`@Prompt`, `@Select`, `@Variable`, `@Aggregate_Aware`, `@Where`) — flagged with a warning; `@Aggregate_Aware` keeps its first branch, the rest need a manual control or inlined SELECT
- Contexts & derived tables — RWS metadata is light here; a full Semantic-Layer-SDK XML export is needed for that fidelity (planned Phase 2, same converter core)
- Multi-table object SELECTs — placed on the first table with a warning; verify cross-table references
- Crystal Reports / Web Intelligence — this converter handles the universe (semantic layer) only, not the report/document layer

**Useful resources:** [SAP — RESTful Web Service SDK](https://help.sap.com/docs/SAP_BUSINESSOBJECTS_BUSINESS_INTELLIGENCE_PLATFORM)

---

### Cube.dev

Converts [Cube.dev](https://cube.dev) schemas to Sigma data model JSON. Accepts both YAML (`.yml` / `.yaml`) and JavaScript (`.js`) schema files in the same drop — drop your `cubes/` and `views/` directories together.

**What gets converted:**
- Cubes with `sql_table` → warehouse-table elements (paths completed via Database / Schema overrides if needed)
- Cubes with raw `sql` → Custom SQL elements (`${CUBE}` and `${OtherCube}` template refs are normalized to plain SQL aliases)
- Dimensions (`type: string | number | time | boolean`) → Sigma columns
- Calculated dimensions (`sql` with expressions / `${CUBE}.col` / `${OtherCube.dim}` refs) → Sigma calculated columns
- Measures (`type: count | sum | avg | min | max | count_distinct | number | percent`) → Sigma metrics with `Sum() / Avg() / CountIf() / etc.` wrappers
- Filtered measures (`filters: [{ sql: ... }]`) → `SumIf` / `CountIf` / `AvgIf` / `CountDistinctIf`
- Calculated measures (`type: number` referencing `${other_measure}`) → metric expressions
- Joins (`relationship: one_to_one | one_to_many | many_to_one`) → Sigma relationships with FK/PK keys parsed from `sql: ${CUBE}.fk = ${OtherCube.pk}`
- Views (`cubes: [{ join_path, includes, prefix }]`) → derived elements with linked-column refs

**JavaScript schema parsing:** the JS parser handles `cube(`name`, { ... })` and `view(`name`, { ... })` calls with template-literal SQL. Backtick template substitutions (`${CUBE}.col`, `${OtherCube.dim}`, `${measure_name}`) are preserved verbatim so the same SQL translator handles both formats.

**Expression conversion:**
- `${CUBE}.col` → `[TABLE/Display]` (or `[Display]` in Custom SQL elements)
- `${OtherCube.dim}` → `[Display Dim]`
- `${measure_name}` → `[Display Measure]`
- `'string'` → `"string"`; `a || b` (concat) → `a & b`
- `x::DATE / x::VARCHAR / x::INTEGER` → `Date(x) / Text(x) / Int(x)`
- `expr IN (a, b, c)` → `In(expr, a, b, c)`
- `CASE WHEN ... END` → nested `If()`
- `NULLIF / COALESCE / DATE_TRUNC / DATEDIFF / DATEADD / TO_CHAR / etc.` → Sigma function names

**Known limitations:**
- Pre-aggregations are skipped with an informational warning — Sigma uses warehouse-side caching
- Segments are skipped — convert reusable segment filters to Sigma parameters or filters manually
- Jinja / Python templating in YAML is not pre-processed; render the schema with Cube before exporting
- Cross-cube refs in calculated dimensions use a relative `[Display Field]` form; if the field doesn't exist on the same element, add a Sigma linked-column ref manually
- View `join_path` chains beyond two hops are best-effort; deep linked-column refs may need manual adjustment

**Useful resources:** [Cube — Data Modeling Overview](https://cube.dev/docs/product/data-modeling/overview) · [Cube — Joins](https://cube.dev/docs/reference/data-model/joins) · [Cube — Views](https://cube.dev/docs/reference/data-model/view)

---

### Tableau Prep

Converts [Tableau Prep](https://www.tableau.com/products/prep) flow files (`.tfl` / `.tflx`) to Sigma data model JSON. JSZip extracts the inner `flow` JSON automatically when you drop the archive into the converter.

**What gets converted:**
- Inputs (`.v1.LoadSql`, `LoadCsv`, `LoadExcel`, `LoadJson`, `LoadHyper`, `LoadGoogle`) → warehouse-table elements; CSV/Excel/JSON/Hyper inputs map to a warehouse table by basename (override via the **Table mapping** field). Orphan inputs (empty `nextNodes`, not referenced by any other node — leftovers from prior flow editing) are pruned before emission when the flow has at least one output, so a published flow only emits elements that contribute to its output
- `LoadSqlProxy` (Tableau Server published datasource) → Custom SQL placeholder, OR auto-resolved when a companion `.tds` / `.tdsx` is dropped alongside the `.tfl` (matched by datasource caption — `type='table'` relations become warehouse-table elements, `type='text'` relations become Custom SQL with the real SELECT body)
- Containers (`.v1.Container`) → recursively flattened into the parent graph
- Linear transform chains on a single element:
    - `.v1.AddColumn` → calculated column (formula via `tableauFormulaToSigma`)
    - `.v1.RemoveColumns` / `KeepOnlyColumns` → drop/keep columns
    - `.v1.RenameColumn` → column display name
    - `.v1.ChangeColumnType` → cast wrapper (`Date`, `Int`, `Number`, etc.)
    - `.v2018_3_3.Remap` → nested `If(In([Col], "old"), "new", ...)` chain
    - `.v1.FilterOperation` → calculated boolean column named `Filter: <name>` — wire as a page filter
- `.v2018_2_3.SuperJoin` (with inner `.v1.SimpleJoin`) → Sigma relationship with FK/PK keys parsed from `conditions[].leftExpression / rightExpression`, plus a derived "join view" element with left-side passthroughs + cross-element refs to the right via the relationship name (`[FACT_TABLE/REL_NAME/Field]`). Relationship name = target warehouse table name (e.g. `CUSTOMER_DIM`); for Custom SQL targets, derived from the input's friendly name
- `.v2018_2_3.SuperUnion` → element with `source.kind: 'union'` and `inputs[]` referencing each upstream element
- `.v2018_2_3.SuperAggregate` (with inner `.v1.Aggregate`) → child element with `groupings: [{ groupBy, calculations }]`; group-by columns are passthroughs, aggregations (SUM/AVG/MIN/MAX/COUNT/COUNTD/MEDIAN/STDEV) become calc columns referenced from `groupings.calculations`
- Output nodes (WriteToHyper, PublishExtract, WriteToCsv, etc.) → ignored
- Inline input `actions[]` (pre-load transforms baked into a Salesforce extract, etc.) → applied before walking `nextNodes`

**Expression conversion** reuses the Tableau formula translator: `IF/ELSEIF/THEN/END` → nested `If()`, `IIF` → `If`, `ZN` → `Coalesce(_, 0)`, `IFNULL`/`IFERROR` → `Coalesce`, `ISNULL` → `IsNull`, `COUNT([x])` → `CountIf(IsNotNull([x]))`, `COUNTD` → `CountDistinct`, `DATEPART('year', [d])` → `Year([d])`, `DATETRUNC` / `DATEADD` / `DATEDIFF` → Sigma equivalents, single-quote strings → double-quote.

**Known limitations:**
- Pivot (`.v1.Pivot`) — skipped with a warning; Sigma `transpose` exists but mapping is non-trivial
- Script / RunScript / RunCommand / Prediction — skipped; no Sigma equivalent
- `DATEPARSE("fmt", str)` — Tableau's format-string date parser has no Sigma equivalent; falls back to a comment placeholder, manual rewrite needed
- Tableau Server datasources (`LoadSqlProxy`) — auto-resolved when a companion `.tds`/`.tdsx` is dropped with the `.tfl`; otherwise emitted as a Custom SQL placeholder for manual replacement
- Multi-output branches — converter handles linear chains best; review and consolidate if a transform feeds multiple downstream nodes
- Multi-hop join paths (A → B → C through chained relationships) — only first-hop relationships render; deeper traversals need manual setup in Sigma UI

**Useful resources:** [Tableau Prep — Get Started](https://help.tableau.com/current/prep/en-us/prep_get_started.htm) · [Sigma — Data Modeling](https://help.sigmacomputing.com/docs/data-modeling-overview)

---

### Custom SQL

Converts raw SQL files or pasted SQL statements to Sigma data model JSON. Drop `.sql` files or paste queries directly — multiple statements are supported and can be selectively included.

**What gets converted:**

| SQL pattern | Sigma output |
|---|---|
| `SELECT col1, col2 FROM db.schema.table` | Native warehouse-table element |
| `SELECT … FROM table JOIN …` | Native element with relationships |
| `SELECT … GROUP BY …` with aggregates | Columns + metrics on the element |
| `CREATE VIEW name AS SELECT …` | Element named after the view |
| CTEs (`WITH … AS`), subqueries | Custom SQL element (SQL fallback) |
| Complex / ambiguous queries | Custom SQL element (SQL fallback) |

**How it works:**
1. The converter parses each SQL statement and attempts to detect a primary warehouse table and any JOINs
2. If the query maps cleanly to warehouse tables, it creates a **native** element (`source.kind: "warehouse-table"`) — this is the preferred output because it supports Sigma relationships, lineage, and column-level filtering
3. If the query uses CTEs, subqueries, window functions, or other patterns that can't be expressed as a warehouse-table element, it falls back to a **Custom SQL** element (`source.kind: "sql"`) that stores the raw query

A badge in the output panel shows **NATIVE** or **SQL** for each converted statement so you know which path was taken.

**Database / Schema path detection:**
- `db.schema.table` notation is parsed automatically
- Use the **Database** and **Schema** override fields when the SQL uses unqualified table names

**Known limitations:**
- Window functions (`ROW_NUMBER`, `RANK`, `LAG`, `LEAD`, `SUM OVER`) — Passed through to Custom SQL fallback; wire as calculated columns manually in the Sigma UI
- Multi-statement files — Each `CREATE VIEW` or top-level `SELECT` is treated as a separate statement; CTEs within a statement are kept together
- DDL statements (`CREATE TABLE`, `ALTER`, `INSERT`) — Detected and skipped with a warning; only `SELECT` and `CREATE VIEW … AS SELECT` are supported
- Dialect-specific syntax — The converter does not validate SQL against a specific warehouse dialect; syntax that Sigma does not support will need to be adjusted after import

---

## AI Assistant

The AI Assistant (Claude, OpenAI, or Gemini) generates data model content from natural language prompts.

**Capabilities:**
- `"Add a Gross Margin % column"` → Calculated column
- `"Create metrics for total revenue, order count, and AOV"` → Metrics
- `"Add descriptions to all columns"` → Column descriptions
- `"Add row-level security filtering by region"` → RLS column
- `"Add a relationship to the customer dim"` → Relationship
- `"Create an ORDER_FACT table with these columns"` → New element

**Fix with AI:** When a save to Sigma fails, a red error banner appears with a **🤖 Fix with AI** button. This sends the failed JSON and the error message to your configured AI provider to attempt automatic repair. The AI can fix structural issues (empty arrays, casing mismatches, circular dependencies) but cannot verify warehouse column names against your actual schema.

**Formula syntax rules for AI-generated formulas:**
- Local columns: `[Column Name]` — no table prefix
- Cross-element columns: Not supported via API — add manually in Sigma UI
- Conditional aggregates: `SumIf(field, condition)` — field first; `CountIf(condition)` — condition only, no field argument
- Booleans: always use `[Col] = True`, never bare `[Col]`

---

## API Notes

### Common Save Errors

**"Cycle in dependency order"** — The most common save error. Usually means:
- A column formula references a display name that doesn't match the warehouse column (check casing)
- Empty `metrics: []` or `relationships: []` arrays on elements that have none
- Deprecated `- link/` cross-element formulas

Use **Fix with AI** in the error banner to attempt automatic repair.

**Column display name casing:** Sigma title-cases every word in display names — including words like "in", "of", "to", "at". `IS_EMAIL_OPT_IN` → `"Is Email Opt In"` (not `"Is Email Opt in"`). Column formulas must use the exact display name Sigma generates.

**Cross-element column references:** Sigma "links" (the `- link/` formula syntax) are being deprecated. The API does not support creating them. Converters automatically detect calculated columns with cross-element refs and move them to the derived child element, where the related columns are already surfaced. Metrics with cross-element refs are removed with a warning.

### Column ID Formats

- Warehouse columns: `inode-HASH/PHYSICAL_NAME` — assigned by Sigma on save
- Calculated columns: Short random IDs — generated by the tool; Sigma keeps them

When saving a new model, Sigma replaces all column IDs with its own inode-based IDs. References in formulas, relationships, and groupings are automatically remapped.

### API Endpoints Used

| Endpoint | Purpose |
|---|---|
| `GET /v2/datamodels` | List data models |
| `GET /v2/datamodels/{id}` | Retrieve model JSON |
| `POST /v2/datamodels` | Create new model |
| `PUT /v2/datamodels/{id}` | Update existing model |
| `GET /v2/connections` | List available connections |
| `GET /v2/connections/{id}/paths` | Browse warehouse schemas / tables |

---

## MCP Server

The same converter logic is available as a hosted [Model Context Protocol](https://modelcontextprotocol.io) server. Connect AI agents (Claude Code, Claude Desktop, Claude.ai, Cursor, and any MCP-compatible client) to convert data models to Sigma using natural language — no installation required.

**Endpoint:** `https://sigma-data-model-mcp.onrender.com/mcp`

**Available tools:**
- `convert_dbt_to_sigma` — dbt semantic model YAML → Sigma JSON
- `convert_snowflake_to_sigma` — Snowflake Cortex Analyst YAML → Sigma JSON
- `convert_lookml_to_sigma` — LookML project files → Sigma JSON
- `convert_powerbi_to_sigma` — Power BI model (`.bim` / TOM JSON) → Sigma JSON
- `convert_tableau_to_sigma` — Tableau workbook / data source (`.twb` / `.tds` XML) → Sigma JSON
- `convert_omni_to_sigma` — Omni Analytics `.view.yaml` + `.model.yaml` → Sigma JSON
- `convert_sql_to_sigma` — SQL SELECT statements → Sigma JSON
- `convert_thoughtspot_to_sigma` — ThoughtSpot TML YAML → Sigma JSON
- `convert_qlik_to_sigma` — Qlik Sense app metadata JSON → Sigma JSON
- `convert_atlan_to_sigma` — Atlan data contract (YAML / JSON) → Sigma JSON
- `convert_alteryx_to_sigma` — Alteryx Designer workflow (`.yxmd` XML) → Sigma JSON
- `convert_oac_to_sigma` — Oracle Analytics Cloud logical tables JSON → Sigma JSON
- `convert_cube_to_sigma` — Cube.dev schemas (YAML or JS) → Sigma JSON
- `convert_tableau_prep_to_sigma` — Tableau Prep flow JSON (.tfl/.tflx) → Sigma JSON
- `convert_sql_to_sigma_formula` — SQL expression → Sigma formula
- `convert_tableau_formula_to_sigma` — Tableau formula → Sigma formula
- `get_sigma_data_model_schema` — Sigma data model JSON schema reference

**Client setup:**

```bash
# Claude Code
claude mcp add sigma-data-model --transport http https://sigma-data-model-mcp.onrender.com/mcp
```

For Claude Desktop, add to `claude_desktop_config.json` using `npx mcp-remote`. For Claude.ai, add as a connector in Settings → Connected MCP Servers.

---

## Security

This tool runs entirely in your browser — no credentials are sent to any server other than the Sigma API and your chosen AI provider directly.

- **Storage** — Your Sigma Client Secret is never written anywhere. It is held in JavaScript memory only for the lifetime of the browser tab. Your Client ID and AI API keys are stored in `sessionStorage`, which is cleared automatically when the tab is closed. Nothing is ever written to `localStorage`, cookies, or any external service.
- **In transit** — Credentials are sent only to `api.sigmacomputing.com` (for Sigma) and to the AI provider's API endpoint (Anthropic, OpenAI, or Google). No intermediary server is involved.
- **Shared machines** — Close the browser tab when finished rather than just navigating away. This clears session storage and removes credentials from memory.
- **Key rotation** — Use a dedicated Sigma service account with minimum required permissions (read + write to data models only). Rotate API keys on a regular schedule and revoke immediately if suspected of exposure.
- **AI keys** — Monitor your AI provider's usage dashboard and set a spending limit as a safety net.
- **Analytics** — The hosted version of this tool (GitHub Pages) loads anonymous usage analytics via PostHog (`us.i.posthog.com`) to help understand how the tool is being used. A consent banner appears on first load; your choice is stored in `localStorage`. No data model contents, credentials, or schema information are ever sent to PostHog. If you self-host or want to disable analytics entirely, remove the `<script>` block marked `PostHog analytics` near the top of `index.html`.
