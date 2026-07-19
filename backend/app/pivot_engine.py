"""Execute a pivot config as a single ClickHouse GROUP BY, then shape the
grouped rows into an Excel-style crosstab in Python.

Field names are validated against the sheet's column list (whitelist) before
being interpolated as backtick-quoted identifiers; filter values go through
bound query parameters. Nothing user-controlled is spliced in raw.
"""
import datetime as dt

from fastapi import HTTPException

from .config import settings
from .db import DB, ch

AGG_SQL = {
    "sum": "sum",
    "count": "count",
    "avg": "avg",
    "min": "min",
    "max": "max",
    "distinct_count": "uniqExact",
}
AGG_LABEL = {
    "sum": "Sum",
    "count": "Count",
    "avg": "Average",
    "min": "Min",
    "max": "Max",
    "distinct_count": "Distinct Count",
}


def _ident(field: str, allowed: set[str]) -> str:
    if field not in allowed:
        raise HTTPException(400, f"Unknown field '{field}'")
    return f"`{field}`"


def _key(v):
    if v is None:
        return "(blank)"
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat(sep=" ") if isinstance(v, dt.datetime) else v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def execute_pivot(sheet: dict, config: dict) -> dict:
    allowed = {c["name"] for c in sheet["columns"]}
    labels = {c["name"]: c["source"] for c in sheet["columns"]}
    row_fields = config.get("rows", [])
    col_fields = config.get("columns", [])
    values = config.get("values", [])
    filters = config.get("filters", [])

    if not values:
        values = [{"field": row_fields[0] if row_fields else next(iter(allowed)), "agg": "count"}]

    group_idents = [_ident(f, allowed) for f in row_fields + col_fields]
    agg_exprs = []
    for v in values:
        fn = AGG_SQL.get(v.get("agg", "sum"))
        if not fn:
            raise HTTPException(400, f"Unknown aggregation '{v.get('agg')}'")
        agg_exprs.append(f"{fn}({_ident(v['field'], allowed)})")

    where = ["_is_deleted = 0"]
    params: dict = {}
    for i, f in enumerate(filters):
        vals = [str(x) for x in f.get("values", [])]
        if not vals:
            continue
        # Compare as strings so one code path covers every column type.
        where.append(f"toString({_ident(f['field'], allowed)}) IN %(f{i})s")
        params[f"f{i}"] = vals

    select = ", ".join(group_idents + agg_exprs) if group_idents else ", ".join(agg_exprs)
    sql = f"SELECT {select} FROM {DB}.`{sheet['table_name']}` FINAL WHERE {' AND '.join(where)}"
    if group_idents:
        sql += f" GROUP BY {', '.join(group_idents)} ORDER BY {', '.join(group_idents)}"
    sql += f" LIMIT {settings.pivot_max_groups + 1}"

    rows = ch().query(sql, parameters=params).result_rows
    truncated = len(rows) > settings.pivot_max_groups
    rows = rows[: settings.pivot_max_groups]

    n_rf, n_cf, n_v = len(row_fields), len(col_fields), len(values)

    # Collect distinct column-field combos (crosstab column headers).
    col_keys: list[tuple] = []
    col_key_set = set()
    for r in rows:
        ck = tuple(_key(x) for x in r[n_rf : n_rf + n_cf])
        if ck not in col_key_set:
            col_key_set.add(ck)
            col_keys.append(ck)
    col_keys.sort()

    col_index = {ck: i for i, ck in enumerate(col_keys)}
    by_row: dict[tuple, list] = {}
    row_order: list[tuple] = []
    for r in rows:
        rk = tuple(_key(x) for x in r[:n_rf])
        ck = tuple(_key(x) for x in r[n_rf : n_rf + n_cf])
        if rk not in by_row:
            by_row[rk] = [[None] * n_v for _ in range(len(col_keys))]
            row_order.append(rk)
        by_row[rk][col_index[ck]] = [
            float(x) if isinstance(x, (int, float)) else x for x in r[n_rf + n_cf :]
        ]

    def _totals(cell_groups):
        """Row/grand totals — only meaningful (re-aggregatable) for sum/count."""
        out = []
        for vi, v in enumerate(values):
            if v.get("agg", "sum") in ("sum", "count"):
                nums = [c[vi] for c in cell_groups if c and c[vi] is not None]
                out.append(sum(nums) if nums else None)
            else:
                out.append(None)
        return out

    result_rows = []
    for rk in row_order:
        cells = by_row[rk]
        result_rows.append({"keys": list(rk), "cells": cells, "total": _totals(cells)})

    grand_cells = []
    for ci in range(len(col_keys)):
        col_cells = [by_row[rk][ci] for rk in row_order]
        grand_cells.append(_totals(col_cells))
    grand = {"cells": grand_cells, "total": _totals([r["total"] for r in result_rows])}

    return {
        "rowFields": [{"field": f, "label": labels.get(f, f)} for f in row_fields],
        "colFields": [{"field": f, "label": labels.get(f, f)} for f in col_fields],
        "values": [
            {
                "field": v["field"],
                "agg": v.get("agg", "sum"),
                "label": f"{AGG_LABEL[v.get('agg', 'sum')]} of {labels.get(v['field'], v['field'])}",
            }
            for v in values
        ],
        "columnKeys": [list(ck) for ck in col_keys],
        "rows": result_rows,
        "grandTotal": grand,
        "truncated": truncated,
    }
