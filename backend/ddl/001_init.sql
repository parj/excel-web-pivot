-- Metadata schema for the Excel pivot workspace.
-- Everything lives in the dedicated `excel_uploads` database so it never
-- collides with the existing pipeline's tables. The backend also runs these
-- statements idempotently at startup (see app/db.py).

CREATE DATABASE IF NOT EXISTS excel_uploads;

CREATE TABLE IF NOT EXISTS excel_uploads.workbooks (
    id String,
    filename String,
    uploaded_at DateTime DEFAULT now(),
    refreshed_at Nullable(DateTime)
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE IF NOT EXISTS excel_uploads.sheets (
    id String,
    workbook_id String,
    sheet_name String,
    table_name String,
    columns_json String,
    row_count UInt64,
    created_at DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY id;

-- Pivot updates/deletes are versioned inserts, resolved with FINAL.
CREATE TABLE IF NOT EXISTS excel_uploads.pivot_configs (
    id String,
    sheet_id String,
    name String,
    rows_json String,
    columns_json String,
    values_json String,
    filters_json String,
    is_deleted UInt8 DEFAULT 0,
    created_at DateTime,
    updated_at DateTime
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id;

-- Per-sheet data tables are created dynamically at ingest time with this shape:
--
-- CREATE TABLE excel_uploads.`data_<sheet_id>` (
--     _row_id String,           -- stable row identity
--     _row_index UInt64,        -- preserves original spreadsheet order
--     _version UInt64,          -- time.time_ns(); newest version wins
--     _is_deleted UInt8,        -- 1 = tombstone
--     <inferred columns...>     -- all Nullable(...)
-- ) ENGINE = ReplacingMergeTree(_version) ORDER BY _row_id;
--
-- Cell edits, row adds, and row deletes are all INSERTs of a new version;
-- reads use FINAL to resolve the latest version per _row_id.
