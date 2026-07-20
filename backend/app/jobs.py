"""In-memory ingestion job store (MVP — jobs don't survive backend restarts)."""
import threading
import uuid

from . import ingest

_lock = threading.Lock()
_jobs: dict[str, dict] = {}


def get_job(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def start_ingest(filename: str, data: bytes) -> str:
    job_id = uuid.uuid4().hex
    with _lock:
        _jobs[job_id] = {"id": job_id, "status": "running", "filename": filename, "result": None, "error": None}

    def run():
        try:
            result = ingest.ingest_workbook(filename, data)
            with _lock:
                _jobs[job_id].update(status="done", result=result)
        except ingest.IngestError as e:
            with _lock:
                _jobs[job_id].update(status="error", error=str(e))
        except Exception as e:
            with _lock:
                _jobs[job_id].update(status="error", error=f"Unexpected ingestion failure: {e}")

    threading.Thread(target=run, daemon=True).start()
    return job_id


def start_refresh(workbook_id: str, filename: str, data: bytes) -> str:
    job_id = uuid.uuid4().hex
    with _lock:
        _jobs[job_id] = {"id": job_id, "status": "running", "filename": filename, "result": None, "error": None}

    def run():
        try:
            result = ingest.refresh_workbook(workbook_id, filename, data)
            with _lock:
                _jobs[job_id].update(status="done", result=result)
        except ingest.IngestError as e:
            with _lock:
                _jobs[job_id].update(status="error", error=str(e))
        except Exception as e:
            with _lock:
                _jobs[job_id].update(status="error", error=f"Unexpected refresh failure: {e}")

    threading.Thread(target=run, daemon=True).start()
    return job_id
