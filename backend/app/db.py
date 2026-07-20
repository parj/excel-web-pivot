"""ClickHouse client management + idempotent schema migration.

clickhouse-connect clients are not safe for concurrent queries, so we keep
one client per thread (requests run in FastAPI's threadpool, ingestion jobs
run in their own threads).
"""
import threading

import clickhouse_connect

from .config import settings

_local = threading.local()


def ch():
    client = getattr(_local, "client", None)
    if client is None:
        client = clickhouse_connect.get_client(
            host=settings.ch_host,
            port=settings.ch_port,
            username=settings.ch_user,
            password=settings.ch_password,
        )
        _local.client = client
    return client


DB = settings.ch_database

# Mirrors backend/ddl/001_init.sql — kept inline so startup is self-migrating.
DDL_STATEMENTS = [
    f"CREATE DATABASE IF NOT EXISTS {DB}",
    f"""
    CREATE TABLE IF NOT EXISTS {DB}.workbooks (
        id String,
        filename String,
        uploaded_at DateTime DEFAULT now(),
        refreshed_at Nullable(DateTime)
    ) ENGINE = MergeTree ORDER BY id
    """,
    # Added after the initial release — idempotent for already-created tables.
    f"ALTER TABLE {DB}.workbooks ADD COLUMN IF NOT EXISTS refreshed_at Nullable(DateTime)",
    f"""
    CREATE TABLE IF NOT EXISTS {DB}.sheets (
        id String,
        workbook_id String,
        sheet_name String,
        table_name String,
        columns_json String,
        row_count UInt64,
        created_at DateTime DEFAULT now()
    ) ENGINE = MergeTree ORDER BY id
    """,
    f"""
    CREATE TABLE IF NOT EXISTS {DB}.pivot_configs (
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
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id
    """,
]


def init_schema():
    client = ch()
    for stmt in DDL_STATEMENTS:
        client.command(stmt)
