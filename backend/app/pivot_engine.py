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


def _group_query(
    table_name: str, allowed: set[str], group_fields: list[str], agg_exprs: list[str], where_sql: str, params: dict
):
    """One GROUP BY at an arbitrary field prefix — used for each row-hierarchy
    subtotal level (see _row_tree). Field names are re-validated against the
    sheet's column whitelist even though callers only ever pass prefixes of
    already-validated row/column fields."""
    idents = [_ident(f, allowed) for f in group_fields]
    select = ", ".join(idents + agg_exprs) if idents else ", ".join(agg_exprs)
    sql = f"SELECT {select} FROM {DB}.`{table_name}` FINAL WHERE {where_sql}"
    if idents:
        sql += f" GROUP BY {', '.join(idents)} ORDER BY {', '.join(idents)}"
    return ch().query(sql, parameters=params).result_rows


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

    # Every total below — row totals, column grand totals, the overall grand
    # total, and (further down) each row-hierarchy subtotal level — is its
    # own real ClickHouse GROUP BY at a shorter field prefix, not a Python
    # re-sum of the leaf cells. That makes them correct for every
    # aggregation (avg/min/max/distinct_count included), not just sum/count.
    where_sql = " AND ".join(where)

    def _agg_map(group_fields: list[str], n_key: int) -> dict[tuple, list]:
        out = {}
        for r in _group_query(sheet["table_name"], allowed, group_fields, agg_exprs, where_sql, params):
            key = tuple(_key(x) for x in r[:n_key])
            out[key] = [float(x) if isinstance(x, (int, float)) else x for x in r[n_key:]]
        return out

    row_totals = _agg_map(row_fields, n_rf)  # keyed by full row key (or () if n_rf==0)
    col_totals = _agg_map(col_fields, n_cf)  # keyed by full column key (or () if n_cf==0)
    # The ungrouped aggregate over the whole filtered table — same query as
    # row_totals[()]/col_totals[()] already ran when there are no row/column
    # fields, otherwise one more (cheap) aggregate-only query.
    overall_total = row_totals[()] if n_rf == 0 else col_totals[()] if n_cf == 0 else _agg_map([], 0)[()]

    result_rows = []
    for rk in row_order:
        cells = by_row[rk]
        result_rows.append({"keys": list(rk), "cells": cells, "total": row_totals.get(rk)})

    # Hierarchical row subtotals (Excel "tree mode"): when there are 2+ row
    # fields, fetch one extra pair of GROUP BYs per intermediate prefix depth
    # (row_fields[:p]+col_fields for the per-column subtotal, row_fields[:p]
    # alone for that group's own row-total).
    row_tree = None
    if n_rf >= 2:
        level_cells: dict[int, dict[tuple, list]] = {}
        level_totals: dict[int, dict[tuple, list]] = {}
        for p in range(1, n_rf):
            cmap = {}
            for r in _group_query(
                sheet["table_name"], allowed, row_fields[:p] + col_fields, agg_exprs, where_sql, params
            ):
                prefix = tuple(_key(x) for x in r[:p])
                ck = tuple(_key(x) for x in r[p : p + n_cf])
                cmap[(prefix, ck)] = [float(x) if isinstance(x, (int, float)) else x for x in r[p + n_cf :]]
            level_cells[p] = cmap
            level_totals[p] = _agg_map(row_fields[:p], p)

        def _build_node(level: int, prefix: tuple, leaf_keys: list[tuple]) -> dict:
            if level == n_rf:
                return {
                    "keys": list(prefix),
                    "level": level,
                    "isLeaf": True,
                    "cells": by_row[prefix],
                    "total": row_totals.get(prefix),
                }
            groups: dict[str, list[tuple]] = {}
            order: list[str] = []
            for rk in leaf_keys:
                seg = rk[level]
                if seg not in groups:
                    groups[seg] = []
                    order.append(seg)
                groups[seg].append(rk)
            children = [_build_node(level + 1, prefix + (seg,), groups[seg]) for seg in order]
            node: dict = {"level": level, "isLeaf": False, "children": children}
            if level > 0:
                node["keys"] = list(prefix)
                node["cells"] = [level_cells[level].get((prefix, ck)) for ck in col_keys]
                node["total"] = level_totals[level].get(prefix)
            return node

        row_tree = _build_node(0, (), row_order)["children"]

    grand = {"cells": [col_totals.get(ck) for ck in col_keys], "total": overall_total}

    return {
        "rowFields": [{"field": f, "label": labels.get(f, f)} for f in row_fields],
        "colFields": [{"field": f, "label": labels.get(f, f)} for f in col_fields],
        "values": [
            {
                "field": v["field"],
                "agg": v.get("agg", "sum"),
                "label": f"{labels.get(v['field'], v['field'])} ({AGG_LABEL[v.get('agg', 'sum')]})",
            }
            for v in values
        ],
        "columnKeys": [list(ck) for ck in col_keys],
        "rows": result_rows,
        "rowTree": row_tree,
        "grandTotal": grand,
        "truncated": truncated,
    }
