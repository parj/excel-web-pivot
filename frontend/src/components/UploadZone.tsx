import { useRef, useState } from 'react';

import { api } from '../api';

const MAX_MB = 50;

export type UploadStatus =
  | { kind: 'idle' }
  | { kind: 'working'; label: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; warnings: string[] };

/** Upload + ingestion-job polling, shared by the top-bar button and drag-drop. */
export function useUpload(onUploaded: (workbookId: string) => void) {
  const [status, setStatus] = useState<UploadStatus>({ kind: 'idle' });
  const pollRef = useRef<number | null>(null);

  const start = async (file: File) => {
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      setStatus({ kind: 'error', message: `"${file.name}" is not an .xlsx / .xls file` });
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setStatus({ kind: 'error', message: `"${file.name}" exceeds the ${MAX_MB}MB limit` });
      return;
    }
    setStatus({ kind: 'working', label: `Uploading ${file.name}…` });
    try {
      const { job_id } = await api.upload(file);
      setStatus({ kind: 'working', label: `Ingesting ${file.name}…` });
      pollRef.current = window.setInterval(async () => {
        try {
          const job = await api.job(job_id);
          if (job.status === 'done') {
            window.clearInterval(pollRef.current!);
            setStatus({ kind: 'done', warnings: job.result?.warnings ?? [] });
            onUploaded(job.result!.workbook_id);
          } else if (job.status === 'error') {
            window.clearInterval(pollRef.current!);
            setStatus({ kind: 'error', message: job.error ?? 'Ingestion failed' });
          }
        } catch (e) {
          window.clearInterval(pollRef.current!);
          setStatus({ kind: 'error', message: (e as Error).message });
        }
      }, 800);
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message });
    }
  };

  return { status, start, dismiss: () => setStatus({ kind: 'idle' }) };
}

/** Slim status card shown at the bottom of the sidebar during/after upload. */
export function UploadStatusCard({ status, onDismiss }: { status: UploadStatus; onDismiss: () => void }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'working') {
    return (
      <div className="pv-upload-card">
        {status.label}
        <div className="pv-progress">
          <div />
        </div>
      </div>
    );
  }
  if (status.kind === 'error') {
    return (
      <div className="pv-upload-card error" onClick={onDismiss} title="Dismiss" style={{ cursor: 'pointer' }}>
        ⚠ {status.message}
      </div>
    );
  }
  if (status.warnings.length > 0) {
    return (
      <div className="pv-upload-card" onClick={onDismiss} title="Dismiss" style={{ cursor: 'pointer' }}>
        {status.warnings.map((w) => (
          <div key={w}>⚠ {w}</div>
        ))}
      </div>
    );
  }
  return null;
}
