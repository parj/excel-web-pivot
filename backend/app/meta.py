"""Small metadata lookups shared by routers."""
import json

from fastapi import HTTPException

from .db import DB, ch


def get_workbook(workbook_id: str) -> dict:
    res = ch().query(
        f"SELECT id, filename, uploaded_at, refreshed_at FROM {DB}.workbooks WHERE id = %(id)s",
        parameters={"id": workbook_id},
    )
    if not res.result_rows:
        raise HTTPException(404, "Workbook not found")
    r = res.result_rows[0]
    return {"id": r[0], "filename": r[1], "uploaded_at": r[2], "refreshed_at": r[3]}


def get_sheet(sheet_id: str) -> dict:
    res = ch().query(
        f"SELECT id, workbook_id, sheet_name, table_name, columns_json FROM {DB}.sheets WHERE id = %(id)s",
        parameters={"id": sheet_id},
    )
    if not res.result_rows:
        raise HTTPException(404, "Sheet/table not found")
    r = res.result_rows[0]
    return {
        "id": r[0],
        "workbook_id": r[1],
        "sheet_name": r[2],
        "table_name": r[3],
        "columns": json.loads(r[4]),
    }


def get_pivot(pivot_id: str) -> dict:
    res = ch().query(
        f"""SELECT id, sheet_id, name, rows_json, columns_json, values_json, filters_json,
                   is_deleted, created_at, updated_at
            FROM {DB}.pivot_configs FINAL WHERE id = %(id)s""",
        parameters={"id": pivot_id},
    )
    if not res.result_rows or res.result_rows[0][7] == 1:
        raise HTTPException(404, "Pivot not found")
    r = res.result_rows[0]
    return {
        "id": r[0],
        "sheet_id": r[1],
        "name": r[2],
        "rows": json.loads(r[3]),
        "columns": json.loads(r[4]),
        "values": json.loads(r[5]),
        "filters": json.loads(r[6]),
        "created_at": r[8],
        "updated_at": r[9],
    }
