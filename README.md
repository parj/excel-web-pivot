# PivotView

An online replacement for Excel tables and pivot tables, backed by ClickHouse.
Upload `.xlsx`/`.xls` workbooks; every sheet becomes a ClickHouse table you can
edit in a grid and pivot with an Excel-style field configurator. All edits and
pivot configurations persist to ClickHouse and survive reloads.

**Stack:** React + TypeScript + Mantine + AG Grid Community · Python + FastAPI ·
ClickHouse via `clickhouse-connect` · pandas + openpyxl for parsing.

**Design:** implements the "PivotView" design direction (option 1a, sidebar
navigator) from the claude.ai/design project *Excel to web viewer* —
DM Sans UI + IBM Plex Mono numerals, red accent (`#DC2626` light /
`#EF4444` dark), compact spreadsheet density, light/dark themes.

## Run it (Windows, cmd)

> **Use Command Prompt (cmd), not PowerShell.** On some machines `docker` and
> `node` are only on the PATH that cmd sees; in PowerShell you'd get
> `docker : The term 'docker' is not recognized...` and nothing would start —
> the app then looks like a blank page because no server is running. Open cmd
> via **Win+R → `cmd` → Enter**.

**1. Start Docker Desktop** (the whale icon must be running — it hosts the
ClickHouse container as well as the backend and frontend).

**2. Build and start everything** (ClickHouse + backend + frontend):

```cmd
cd C:\excel-pivot
docker compose up -d --build
```

The first build takes a few minutes. Check that all three services are up:

```cmd
docker compose ps
```

You should see `excel-pivot-clickhouse-1` as `running (healthy)` plus the
`backend` and `frontend` containers `running`.

**3. Open the app** at **http://localhost:5173** — served by the frontend
container's dev server. Don't open `frontend\index.html` directly from disk;
without the dev server that file renders a blank page.

| Service    | URL                                            |
| ---------- | ---------------------------------------------- |
| Frontend   | http://localhost:5173                          |
| API + docs | http://localhost:8000/docs (OpenAPI/Swagger)   |
| ClickHouse | http://localhost:8123 (user `app` / `app_secret`) |

**Useful commands** (all from the project folder in cmd):

```cmd
docker compose logs -f backend      :: follow backend logs
docker compose logs -f clickhouse   :: follow ClickHouse logs
docker compose restart frontend     :: restart one service
docker compose down                 :: stop everything (uploaded data KEPT)
docker compose down -v              :: stop and DELETE all ClickHouse data
docker compose up -d                :: start again later (no rebuild needed)
```

Query the data directly if you're curious:

```cmd
docker exec -it excel-pivot-clickhouse-1 clickhouse-client -q "SHOW TABLES FROM excel_uploads"
```

## Using the app

### Upload a spreadsheet

1. Click the red **Upload .xlsx** button in the top bar, or drag an
   `.xlsx`/`.xls` file anywhere onto the window. Try the included sample:
   [sample_data/sales_sample.xlsx](sample_data/sales_sample.xlsx).
2. A progress card shows at the bottom of the sidebar while the file uploads
   and ingests (it runs as a background job; big files keep the UI
   responsive). Errors — oversized, corrupt, or password-protected files —
   appear in the same card.
3. When done, the file appears in the **Files** sidebar and opens
   automatically: its sheets show as chips in the breadcrumb, and the view
   tabs (**Raw Data** / your pivots / **+ New Pivot**) switch between the
   editable grid and pivot tables. The search box in the top bar filters the
   file list.

The sample's "Sales" sheet has a merged two-row header (`Revenue` spanning
`Units`/`Amount`) to show header flattening — it ingests as columns
`Revenue - Units` and `Revenue - Amount`.

### Excel pivot tables are recreated, not flattened

If the workbook contains PivotTables, they are detected during ingestion and
**recreated as live pivots** on their source data instead of being imported as
static tables:

- The pivot definition (row/column fields, values with their aggregations,
  page filters) is read from the workbook XML; the source range is resolved
  whether it's a direct sheet reference or a named range.
- Excel aggregations map to Sum / Count / Average / Min / Max; anything
  exotic (StdDev, Product, …) falls back to Sum with a warning.
- A sheet that contains only rendered pivot output is skipped as a table —
  its pivots appear as tabs under the *source* sheet, live and editable. If a
  pivot can't be recreated (source data missing from the workbook, external
  data model), the rendered output is imported as a normal table instead, so
  nothing is lost. Either way the upload card tells you what happened.
- `.xls` (legacy BIFF) pivots aren't detected — only `.xlsx`.

### View and edit a table

Pick a sheet chip in the breadcrumb, then the **Raw Data** tab:

- **Edit a cell**: double-click it, type the new value, press **Enter**. The
  "Saving… / Saved" badge next to the title confirms the autosave — there is
  no Save button, and edits survive refresh (each edit is written to
  ClickHouse as a new row version).
- **Add a row**: click **+ Add row** (top right), then fill its cells.
- **Delete rows**: click row(s) to select (Ctrl+click for several), then
  **Delete selected**.
- Large sheets are paginated (500 rows per page, pager under the grid).
  Column headers sort and filter the current page.

### Build a pivot

1. Click the **+ New Pivot** tab. The pivot is created immediately and saved
   under that sheet — reopening the workbook later shows it as a tab again.
2. Use the config strip above the grid — **ROWS / COLUMNS / VALUES / FILTER**
   — mirroring Excel's PivotTable pane. Click a zone's **+** to add a field
   from the menu, drag chips between zones, or remove them with ✕.
3. The result grid recomputes live after every change; every change also
   autosaves (watch the badge). Click a **Values** chip to change its
   aggregation: Sum, Count, Average, Min, Max, Distinct Count.
4. Click a **Filter** chip to tick which values to include (empty = all).
5. Rename the pivot in the name box at the right of the strip; delete it with
   the ✕ on its active tab.
6. When the pivot has row fields and values, a bar chart of the first value
   by row renders under the grid automatically.

Good first pivot on the sample: **Rows:** Region, **Columns:** Product,
**Values:** Revenue - Amount (Sum) — row totals and a Grand Total row/column
appear automatically.

### Running pieces outside Docker (optional)

- Backend: `cd backend`, `pip install -r requirements.txt`,
  `uvicorn app.main:app --reload` (needs a reachable ClickHouse; see env vars
  below).
- Frontend: `cd frontend`, `npm install`, `npm run dev` (proxies `/api` to
  `VITE_API_PROXY`, default `http://localhost:8000`).
- Regenerate the sample workbook: `python backend\scripts\make_sample.py`
  (needs `openpyxl`).

> Dev note: docker-compose mounts `./frontend` into the frontend container,
> so frontend source edits hot-reload without a rebuild. If you change
> `frontend/package.json`, rebuild with `docker compose up -d --build -V frontend`.

### Configuration (environment variables)

| Variable             | Default         | Purpose                                   |
| -------------------- | --------------- | ----------------------------------------- |
| `CLICKHOUSE_HOST`    | `localhost`     | ClickHouse HTTP host                      |
| `CLICKHOUSE_PORT`    | `8123`          | ClickHouse HTTP port                      |
| `CLICKHOUSE_USER`    | `default`       |                                           |
| `CLICKHOUSE_PASSWORD`| *(empty)*       |                                           |
| `CLICKHOUSE_DATABASE`| `excel_uploads` | Dedicated DB for everything this app makes |
| `MAX_UPLOAD_MB`      | `50`            | Upload size cap (413 beyond it)           |
| `MAX_ROWS_PER_SHEET` | `1000000`       | Row-count guardrail per sheet             |
| `PIVOT_MAX_GROUPS`   | `50000`         | Max grouped rows returned by a pivot      |

## How it works

### Isolation from the existing pipeline

Everything this app creates — metadata tables and one `data_<sheet_id>` table
per uploaded sheet — lives in the dedicated `excel_uploads` database, so it
cannot collide with the existing pipeline's tables in the same ClickHouse
instance.

### ClickHouse mutation strategy (no UPDATE/DELETE)

ClickHouse mutations are heavy background rewrites, so the app never issues
them:

- Each sheet's data table is `ReplacingMergeTree(_version) ORDER BY _row_id`.
  A cell edit re-inserts the full row with the same `_row_id` and a newer
  `_version` (nanosecond timestamp); a row delete inserts a tombstone with
  `_is_deleted = 1`. Reads use `FINAL` and filter `_is_deleted = 0`.
  `_row_index` preserves the original spreadsheet row order.
- `pivot_configs` is likewise `ReplacingMergeTree(updated_at)` — updates and
  deletes are versioned inserts.
- `workbooks` / `sheets` are plain MergeTree (insert-only metadata).

DDL lives in [backend/ddl/001_init.sql](backend/ddl/001_init.sql); the backend
also applies it idempotently at startup, so no manual migration step is needed.

### Ingestion

Every upload runs as a background job: `POST /api/uploads` returns `202` with
a `job_id`, and the UI polls `GET /api/jobs/{job_id}`. Parsing uses openpyxl
directly for `.xlsx` so merged cells can be filled with their top-left value
before header detection (`.xls` goes through pandas/xlrd). Multi-row headers
are detected as the leading run of text-only rows (capped at 3) and flattened
into single names joined by `" - "`; empty/merged cells become `NULL`. Types
are inferred per column (string / number / date / bool) and mapped to
`Nullable(Float64/DateTime64(3)/UInt8/String)`.

Clear error states are returned for oversized (413), corrupt, wrong-format,
and password-protected files (encrypted `.xlsx` is detected by its CFB
signature).

### Pivots

`GET /api/pivots/{id}` compiles the saved config into one ClickHouse
`GROUP BY` over the sheet table (`FINAL`, filters as bound parameters, field
names whitelisted against the sheet schema) and shapes the grouped rows into
an Excel-style crosstab server-side: column-field combinations become column
groups, with row totals and a grand-total row (totals only for re-aggregatable
Sum/Count). Aggregations: Sum, Count, Average, Min, Max, Distinct Count
(`uniqExact`). The builder autosaves every change (`PATCH`) and re-executes,
so the grid updates live.

## API

Interactive docs at `/docs`. Summary:

| Method & path | Purpose |
| --- | --- |
| `POST /api/uploads` | Upload workbook → `{job_id}` (async ingestion) |
| `GET /api/jobs/{job_id}` | Poll ingestion status |
| `GET /api/workbooks` | List workbooks |
| `GET /api/workbooks/{id}/sheets` | Sheets + their saved pivots |
| `GET /api/tables/{table_id}/data?limit&offset` | Paginated latest-version rows |
| `PATCH /api/tables/{table_id}/rows/{row_id}` | Edit cells (new version insert) |
| `POST /api/tables/{table_id}/rows` | Append a row |
| `DELETE /api/tables/{table_id}/rows/{row_id}` | Tombstone a row |
| `GET /api/tables/{table_id}/columns/{col}/values` | Distinct values for filter pickers |
| `POST /api/sheets/{sheet_id}/pivots` | Create pivot config |
| `GET /api/pivots/{pivot_id}` | Execute pivot → config + crosstab result |
| `PATCH /api/pivots/{pivot_id}` / `DELETE …` | Update / delete pivot |
| `POST /api/sheets/{sheet_id}/pivots/preview` | Execute an unsaved config |

`table_id` equals the sheet id (one table per sheet).

## Scope notes & assumptions

- **No auth / multi-tenancy** — single shared workspace, per the MVP brief.
- Ingestion **job state is in-memory**; a backend restart forgets in-flight
  jobs (completed uploads are unaffected).
- Header-depth detection is heuristic (leading text-only rows). An all-text
  sheet falls back to a single header row.
- Row/grand totals are shown only for Sum and Count, since Average/Min/Max/
  Distinct Count can't be correctly re-aggregated from subtotals.
- Frontend light/dark mode follows the OS by default; the header toggle
  (Light / Dark / System) persists to localStorage and overrides it.
