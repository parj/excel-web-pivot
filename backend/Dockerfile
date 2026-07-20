FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

COPY . /app/

WORKDIR /app

RUN uv sync --no-cache

EXPOSE 8000

ENV PATH=/app/.venv/bin:$PATH

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
