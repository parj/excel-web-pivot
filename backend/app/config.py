import os


class Settings:
    """All connection/limit config comes from environment variables."""

    ch_host: str = os.getenv("CLICKHOUSE_HOST", "localhost")
    ch_port: int = int(os.getenv("CLICKHOUSE_PORT", "8123"))
    ch_user: str = os.getenv("CLICKHOUSE_USER", "default")
    ch_password: str = os.getenv("CLICKHOUSE_PASSWORD", "")
    # Dedicated database so this app never collides with the existing pipeline's tables.
    ch_database: str = os.getenv("CLICKHOUSE_DATABASE", "excel_uploads")

    max_upload_mb: int = int(os.getenv("MAX_UPLOAD_MB", "50"))
    max_rows_per_sheet: int = int(os.getenv("MAX_ROWS_PER_SHEET", "1000000"))
    pivot_max_groups: int = int(os.getenv("PIVOT_MAX_GROUPS", "50000"))


settings = Settings()
