"""All /api routes."""
import datetime as dt
import json
import time
import uuid

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import jobs, meta, pivot_engine
from .config import settings
from .db import DB, ch
from .ingest import IngestError, check_file, coerce_value

router = APIRouter(prefix="/api")


# ---------- uploads / jobs ----------

@router.post("/uploads", status_code=202, summary="Upload an Excel workbook (async ingestion job)")
async def upload(file: UploadFile):
    data = await file.read()
    try:
        check_file(file.filename or "upload.xlsx", data)
    except IngestError as e:
        raise HTTPException(413 if "limit" in str(e) else 400, str(e))
    job_id = jobs.start_ingest(file.filename or "upload.xlsx", data)
    return {"job_id": job_id}


@router.get("/jobs/{job_id}", summary="Poll ingestion job status")
def job_status(job_id: str):
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.post("/workbooks/{workbook_id}/refresh", status_code=202,
             summary="Re-upload a workbook's source file to refresh its data (async job)")
async def refresh_workbook(workbook_id: str, file: UploadFile):
    meta.get_workbook(workbook_id)
    data = await file.read()
    try:
        check_file(file.filename or "upload.xlsx", data)
    except IngestError as e:
        raise HTTPException(413 if "limit" in str(e) else 400, str(e))
    job_id = jobs.start_refresh(workbook_id, file.filename or "upload.xlsx", data)
    return {"job_id": job_id}


# ---------- workbooks / sheets ----------

@router.get("/workbooks", summary="List uploaded workbooks")
def list_workbooks():
    res = ch().query(f"SELECT id, filename, uploaded_at, refreshed_at FROM {DB}.workbooks ORDER BY uploaded_at DESC")
    return [{"id": r[0], "filename": r[1], "uploaded_at": r[2], "refreshed_at": r[3]} for r in res.result_rows]


@router.get("/workbooks/{workbook_id}/sheets", summary="List sheets (and their saved pivots) for a workbook")
def list_sheets(workbook_id: str):
    res = ch().query(
        f"SELECT id, sheet_name, table_name, columns_json, row_count FROM {DB}.sheets "
        f"WHERE workbook_id = %(id)s ORDER BY created_at",
        parameters={"id": workbook_id},
    )
    sheets = [
        {"id": r[0], "sheet_name": r[1], "table_name": r[2], "columns": json.loads(r[3]), "row_count": r[4], "pivots": []}
        for r in res.result_rows
    ]
    if sheets:
        ids = [s["id"] for s in sheets]
        pres = ch().query(
            f"SELECT id, sheet_id, name FROM {DB}.pivot_configs FINAL "
            f"WHERE sheet_id IN %(ids)s AND is_deleted = 0 ORDER BY created_at",
            parameters={"ids": ids},
        )
        by_sheet = {s["id"]: s for s in sheets}
        for r in pres.result_rows:
            by_sheet[r[1]]["pivots"].append({"id": r[0], "name": r[2]})
    return sheets


# ---------- raw table data & row edits ----------

@router.get("/tables/{table_id}/data", summary="Paginated raw rows (latest versions)")
def table_data(table_id: str, limit: int = 500, offset: int = 0):
    sheet = meta.get_sheet(table_id)
    limit = max(1, min(limit, 5000))
    cols = [c["name"] for c in sheet["columns"]]
    col_sql = ", ".join(f"`{c}`" for c in cols)
    t = f"{DB}.`{sheet['table_name']}`"
    total = ch().query(f"SELECT count() FROM {t} FINAL WHERE _is_deleted = 0").result_rows[0][0]
    res = ch().query(
        f"SELECT _row_id, {col_sql} FROM {t} FINAL WHERE _is_deleted = 0 "
        f"ORDER BY _row_index LIMIT {limit} OFFSET {offset}"
    )
    rows = [dict(zip(["_row_id"] + cols, r)) for r in res.result_rows]
    return {"columns": sheet["columns"], "rows": rows, "total": total, "limit": limit, "offset": offset}


class RowValues(BaseModel):
    values: dict = Field(default_factory=dict, description="column name -> new value")


def _fetch_row(sheet: dict, row_id: str) -> list | None:
    cols = [c["name"] for c in sheet["columns"]]
    col_sql = ", ".join(f"`{c}`" for c in cols)
    res = ch().query(
        f"SELECT _row_index, {col_sql} FROM {DB}.`{sheet['table_name']}` FINAL "
        f"WHERE _row_id = %(id)s AND _is_deleted = 0",
        parameters={"id": row_id},
    )
    return list(res.result_rows[0]) if res.result_rows else None


def _insert_version(sheet: dict, row_id: str, row_index: int, values: list, deleted: int = 0):
    cols = ["_row_id", "_row_index", "_version", "_is_deleted"] + [c["name"] for c in sheet["columns"]]
    ch().insert(
        f"{DB}.`{sheet['table_name']}`",
        [[row_id, row_index, time.time_ns(), deleted] + values],
        column_names=cols,
    )


@router.patch("/tables/{table_id}/rows/{row_id}", summary="Edit cells (inserts a new row version)")
def patch_row(table_id: str, row_id: str, body: RowValues):
    sheet = meta.get_sheet(table_id)
    current = _fetch_row(sheet, row_id)
    if current is None:
        raise HTTPException(404, "Row not found")
    row_index, vals = current[0], current[1:]
    types = {c["name"]: c["type"] for c in sheet["columns"]}
    for i, c in enumerate(sheet["columns"]):
        if c["name"] in body.values:
            vals[i] = coerce_value(body.values[c["name"]], types[c["name"]])
    _insert_version(sheet, row_id, row_index, vals)
    return {"_row_id": row_id, **dict(zip([c["name"] for c in sheet["columns"]], vals))}


@router.post("/tables/{table_id}/rows", status_code=201, summary="Append a new row")
def add_row(table_id: str, body: RowValues):
    sheet = meta.get_sheet(table_id)
    next_idx = ch().query(
        f"SELECT coalesce(max(_row_index), 0) + 1 FROM {DB}.`{sheet['table_name']}` FINAL"
    ).result_rows[0][0]
    vals = [coerce_value(body.values.get(c["name"]), c["type"]) for c in sheet["columns"]]
    row_id = uuid.uuid4().hex
    _insert_version(sheet, row_id, int(next_idx), vals)
    return {"_row_id": row_id, **dict(zip([c["name"] for c in sheet["columns"]], vals))}


@router.delete("/tables/{table_id}/rows/{row_id}", summary="Delete a row (inserts a tombstone version)")
def delete_row(table_id: str, row_id: str):
    sheet = meta.get_sheet(table_id)
    current = _fetch_row(sheet, row_id)
    if current is None:
        raise HTTPException(404, "Row not found")
    _insert_version(sheet, row_id, current[0], current[1:], deleted=1)
    return {"deleted": row_id}


@router.get("/tables/{table_id}/columns/{column}/values", summary="Distinct values for filter pickers")
def distinct_values(table_id: str, column: str, limit: int = 200):
    sheet = meta.get_sheet(table_id)
    if column not in {c["name"] for c in sheet["columns"]}:
        raise HTTPException(400, f"Unknown column '{column}'")
    res = ch().query(
        f"SELECT DISTINCT toString(`{column}`) FROM {DB}.`{sheet['table_name']}` FINAL "
        f"WHERE _is_deleted = 0 ORDER BY 1 LIMIT {max(1, min(limit, 1000))}"
    )
    return {"values": [r[0] for r in res.result_rows]}


# ---------- pivots ----------

class PivotConfigIn(BaseModel):
    name: str = "Pivot"
    rows: list[str] = Field(default_factory=list)
    columns: list[str] = Field(default_factory=list)
    values: list[dict] = Field(default_factory=list, description='[{"field": ..., "agg": "sum|count|avg|min|max|distinct_count"}]')
    filters: list[dict] = Field(default_factory=list, description='[{"field": ..., "values": [...]}]')


def _save_pivot(pivot_id: str, sheet_id: str, cfg: PivotConfigIn, created_at, is_deleted: int = 0):
    ch().insert(
        f"{DB}.pivot_configs",
        [[
            pivot_id, sheet_id, cfg.name,
            json.dumps(cfg.rows), json.dumps(cfg.columns), json.dumps(cfg.values), json.dumps(cfg.filters),
            is_deleted, created_at, dt.datetime.utcnow(),
        ]],
        column_names=["id", "sheet_id", "name", "rows_json", "columns_json", "values_json",
                      "filters_json", "is_deleted", "created_at", "updated_at"],
    )


@router.post("/sheets/{sheet_id}/pivots", status_code=201, summary="Create a pivot config")
def create_pivot(sheet_id: str, cfg: PivotConfigIn):
    meta.get_sheet(sheet_id)
    pivot_id = uuid.uuid4().hex
    _save_pivot(pivot_id, sheet_id, cfg, dt.datetime.utcnow())
    return {"id": pivot_id, "sheet_id": sheet_id, **cfg.model_dump()}


@router.get("/pivots/{pivot_id}", summary="Execute pivot and return config + crosstab result")
def run_pivot(pivot_id: str):
    pivot = meta.get_pivot(pivot_id)
    sheet = meta.get_sheet(pivot["sheet_id"])
    result = pivot_engine.execute_pivot(sheet, pivot)
    return {"config": pivot, "result": result}


@router.patch("/pivots/{pivot_id}", summary="Update a pivot config (new ReplacingMergeTree version)")
def update_pivot(pivot_id: str, cfg: PivotConfigIn):
    pivot = meta.get_pivot(pivot_id)
    _save_pivot(pivot_id, pivot["sheet_id"], cfg, pivot["created_at"])
    return {"id": pivot_id, "sheet_id": pivot["sheet_id"], **cfg.model_dump()}


@router.delete("/pivots/{pivot_id}", summary="Delete a pivot (tombstone version)")
def delete_pivot(pivot_id: str):
    pivot = meta.get_pivot(pivot_id)
    cfg = PivotConfigIn(name=pivot["name"], rows=pivot["rows"], columns=pivot["columns"],
                        values=pivot["values"], filters=pivot["filters"])
    _save_pivot(pivot_id, pivot["sheet_id"], cfg, pivot["created_at"], is_deleted=1)
    return {"deleted": pivot_id}


@router.post("/sheets/{sheet_id}/pivots/preview", summary="Execute an unsaved pivot config (live preview)")
def preview_pivot(sheet_id: str, cfg: PivotConfigIn):
    sheet = meta.get_sheet(sheet_id)
    return {"result": pivot_engine.execute_pivot(sheet, cfg.model_dump())}
