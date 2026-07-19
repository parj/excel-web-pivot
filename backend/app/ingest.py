"""Excel parsing → schema inference → ClickHouse table creation + insert.

- .xlsx sheets are read via openpyxl so merged cells can be filled with their
  top-left value before header detection; .xls falls back to pandas/xlrd.
- Multi-row headers are detected heuristically (leading rows that contain only
  text) and flattened into single names joined by " - ".
- Each sheet becomes a ReplacingMergeTree(_version) table keyed on _row_id;
  edits/deletes are versioned INSERTs, never mutations.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import re
import time
import uuid
import zipfile

import pandas as pd
from openpyxl import load_workbook

from .config import settings
from .db import DB, ch

TYPE_TO_CH = {
    "number": "Nullable(Float64)",
    "date": "Nullable(DateTime64(3))",
    "bool": "Nullable(UInt8)",
    "string": "Nullable(String)",
}

BOOL_TOKENS = {"true": 1, "false": 0, "yes": 1, "no": 0}


class IngestError(Exception):
    pass


def check_file(filename: str, data: bytes):
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise IngestError(f"File exceeds the {settings.max_upload_mb}MB limit")
    if not re.search(r"\.(xlsx|xls)$", filename, re.I):
        raise IngestError("Only .xlsx and .xls files are supported")
    # Encrypted OOXML files are wrapped in a CFB container (D0 CF 11 E0). A
    # plain .xls is also CFB, so only flag it for .xlsx names.
    if filename.lower().endswith(".xlsx"):
        if data[:4] == b"\xd0\xcf\x11\xe0":
            raise IngestError("This file appears to be password-protected; remove the password and re-upload")
        if not zipfile.is_zipfile(io.BytesIO(data)):
            raise IngestError("File is not a valid .xlsx workbook (corrupt or wrong format)")


def _sheet_grid_xlsx(data: bytes) -> dict[str, list[list]]:
    """Read every sheet as a raw 2D grid with merged cells filled."""
    wb = load_workbook(io.BytesIO(data), data_only=True)
    grids = {}
    for ws in wb.worksheets:
        grid = [list(row) for row in ws.iter_rows(values_only=True)]
        for rng in ws.merged_cells.ranges:
            top_left = grid[rng.min_row - 1][rng.min_col - 1] if rng.min_row - 1 < len(grid) else None
            for r in range(rng.min_row - 1, min(rng.max_row, len(grid))):
                for c in range(rng.min_col - 1, min(rng.max_col, len(grid[r]))):
                    grid[r][c] = top_left
        grids[ws.title] = grid
    return grids


def _sheet_grid_xls(data: bytes) -> dict[str, list[list]]:
    frames = pd.read_excel(io.BytesIO(data), sheet_name=None, header=None, engine="xlrd")
    return {
        name: [[None if pd.isna(v) else v for v in row] for row in df.itertuples(index=False)]
        for name, df in frames.items()
    }


def _is_blank(v) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def _header_depth(grid: list[list]) -> int:
    """Consecutive leading rows containing only text → header rows (cap 3).
    If no typed (non-text) cell shows up in the first 10 rows, assume depth 1."""
    depth = 0
    for i, row in enumerate(grid[:10]):
        cells = [v for v in row if not _is_blank(v)]
        if cells and all(isinstance(v, str) for v in cells):
            depth += 1
            if depth == 3:
                break
        else:
            break
    return max(1, min(depth, 3)) if depth else 1


def _sanitize(name: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z_]+", "_", name.strip()).strip("_")
    if not s:
        s = "col"
    if s[0].isdigit():
        s = "c_" + s
    return s[:80]


def _flatten_headers(grid: list[list], depth: int, width: int) -> list[dict]:
    cols = []
    seen: dict[str, int] = {}
    for c in range(width):
        parts = []
        for r in range(depth):
            v = grid[r][c] if r < len(grid) and c < len(grid[r]) else None
            if not _is_blank(v) and (not parts or str(v).strip() != parts[-1]):
                parts.append(str(v).strip())
        source = " - ".join(parts) if parts else f"Column {c + 1}"
        name = _sanitize(source)
        n = seen.get(name, 0)
        seen[name] = n + 1
        if n:
            name = f"{name}_{n + 1}"
        cols.append({"name": name, "source": source})
    return cols


def _infer_type(values: list) -> str:
    vals = [v for v in values if not _is_blank(v)]
    if not vals:
        return "string"
    if all(isinstance(v, bool) for v in vals):
        return "bool"
    if all(isinstance(v, str) and v.strip().lower() in BOOL_TOKENS for v in vals):
        return "bool"
    if all(isinstance(v, (dt.datetime, dt.date)) and not isinstance(v, bool) for v in vals):
        return "date"

    def numeric(v):
        if isinstance(v, bool):
            return False
        if isinstance(v, (int, float)):
            return True
        if isinstance(v, str):
            try:
                float(v.replace(",", ""))
                return True
            except ValueError:
                return False
        return False

    if sum(1 for v in vals if numeric(v)) >= 0.95 * len(vals):
        return "number"
    return "string"


def _coerce(v, typ: str):
    if _is_blank(v):
        return None
    try:
        if typ == "number":
            if isinstance(v, bool):
                return float(v)
            return float(str(v).replace(",", "")) if isinstance(v, str) else float(v)
        if typ == "bool":
            if isinstance(v, bool):
                return int(v)
            return BOOL_TOKENS.get(str(v).strip().lower())
        if typ == "date":
            if isinstance(v, dt.datetime):
                return v.replace(tzinfo=None)
            if isinstance(v, dt.date):
                return dt.datetime(v.year, v.month, v.day)
            return pd.to_datetime(v).to_pydatetime().replace(tzinfo=None)
    except (ValueError, TypeError):
        return None
    return str(v)


def coerce_value(v, typ: str):
    """Public coercion used by the row-edit endpoints."""
    return _coerce(v, typ)


def data_table_ddl(table_name: str, columns: list[dict]) -> str:
    col_defs = ",\n        ".join(f"`{c['name']}` {TYPE_TO_CH[c['type']]}" for c in columns)
    return f"""
    CREATE TABLE IF NOT EXISTS {DB}.`{table_name}` (
        _row_id String,
        _row_index UInt64,
        _version UInt64,
        _is_deleted UInt8 DEFAULT 0,
        {col_defs}
    ) ENGINE = ReplacingMergeTree(_version) ORDER BY _row_id
    """


def ingest_workbook(filename: str, data: bytes) -> dict:
    check_file(filename, data)
    try:
        if filename.lower().endswith(".xlsx"):
            grids = _sheet_grid_xlsx(data)
        else:
            grids = _sheet_grid_xls(data)
    except IngestError:
        raise
    except Exception as e:  # corrupt / unreadable
        raise IngestError(f"Could not parse workbook: {e}") from e

    client = ch()
    workbook_id = uuid.uuid4().hex
    sheets_meta, warnings = [], []

    for sheet_name, grid in grids.items():
        grid = [row for row in grid]
        # drop fully blank leading rows
        while grid and all(_is_blank(v) for v in grid[0]):
            grid.pop(0)
        if not grid or all(all(_is_blank(v) for v in r) for r in grid):
            warnings.append(f"Sheet '{sheet_name}' is empty — skipped")
            continue

        depth = _header_depth(grid)
        width = max(len(r) for r in grid)
        body = [r + [None] * (width - len(r)) for r in grid[depth:]]
        body = [r for r in body if not all(_is_blank(v) for v in r)]
        if len(body) > settings.max_rows_per_sheet:
            warnings.append(
                f"Sheet '{sheet_name}' has {len(body)} rows (limit {settings.max_rows_per_sheet}) — skipped"
            )
            continue

        columns = _flatten_headers(grid, depth, width)
        for ci, col in enumerate(columns):
            col["type"] = _infer_type([row[ci] for row in body[:2000]])

        sheet_id = uuid.uuid4().hex
        table_name = f"data_{sheet_id}"
        client.command(data_table_ddl(table_name, columns))

        version = time.time_ns()
        rows = [
            [uuid.uuid4().hex, idx, version, 0] + [_coerce(row[ci], columns[ci]["type"]) for ci in range(width)]
            for idx, row in enumerate(body)
        ]
        col_names = ["_row_id", "_row_index", "_version", "_is_deleted"] + [c["name"] for c in columns]
        if rows:
            for start in range(0, len(rows), 50000):
                client.insert(f"{DB}.`{table_name}`", rows[start:start + 50000], column_names=col_names)

        client.insert(
            f"{DB}.sheets",
            [[sheet_id, workbook_id, sheet_name, table_name, json.dumps(columns), len(rows), dt.datetime.utcnow()]],
            column_names=["id", "workbook_id", "sheet_name", "table_name", "columns_json", "row_count", "created_at"],
        )
        sheets_meta.append({"id": sheet_id, "sheet_name": sheet_name, "row_count": len(rows), "columns": columns})

    if not sheets_meta:
        raise IngestError("No usable sheets found in workbook. " + "; ".join(warnings))

    client.insert(
        f"{DB}.workbooks",
        [[workbook_id, filename, dt.datetime.utcnow()]],
        column_names=["id", "filename", "uploaded_at"],
    )
    return {"workbook_id": workbook_id, "filename": filename, "sheets": sheets_meta, "warnings": warnings}
