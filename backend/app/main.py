import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import init_schema
from .routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ClickHouse may still be starting under docker-compose; retry briefly.
    for attempt in range(30):
        try:
            init_schema()
            break
        except Exception:
            if attempt == 29:
                raise
            time.sleep(2)
    yield


app = FastAPI(
    title="Excel Pivot Workspace API",
    description="Upload Excel workbooks into ClickHouse and build Excel-style pivot tables on them. "
                "Single shared workspace — no auth/multi-tenancy in this MVP.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}
