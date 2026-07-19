export interface ColumnMeta {
  name: string;
  source: string;
  type: 'string' | 'number' | 'date' | 'bool';
}

export interface Workbook {
  id: string;
  filename: string;
  uploaded_at: string;
}

export interface PivotRef {
  id: string;
  name: string;
}

export interface Sheet {
  id: string;
  sheet_name: string;
  table_name: string;
  columns: ColumnMeta[];
  row_count: number;
  pivots: PivotRef[];
}

export interface ValueField {
  field: string;
  agg: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'distinct_count';
}

export interface FilterField {
  field: string;
  values: string[];
}

export interface PivotConfig {
  name: string;
  rows: string[];
  columns: string[];
  values: ValueField[];
  filters: FilterField[];
}

export interface PivotResult {
  rowFields: { field: string; label: string }[];
  colFields: { field: string; label: string }[];
  values: { field: string; agg: string; label: string }[];
  columnKeys: string[][];
  rows: { keys: string[]; cells: (number | string | null)[][]; total: (number | null)[] }[];
  grandTotal: { cells: (number | null)[][]; total: (number | null)[] };
  truncated: boolean;
}

export interface TableData {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface Job {
  id: string;
  status: 'running' | 'done' | 'error';
  filename: string;
  result: { workbook_id: string; warnings: string[] } | null;
  error: string | null;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return res.json();
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  upload(file: File): Promise<{ job_id: string }> {
    const form = new FormData();
    form.append('file', file);
    return req('/api/uploads', { method: 'POST', body: form });
  },
  job: (id: string) => req<Job>(`/api/jobs/${id}`),
  workbooks: () => req<Workbook[]>('/api/workbooks'),
  sheets: (workbookId: string) => req<Sheet[]>(`/api/workbooks/${workbookId}/sheets`),
  tableData: (tableId: string, limit: number, offset: number) =>
    req<TableData>(`/api/tables/${tableId}/data?limit=${limit}&offset=${offset}`),
  patchRow: (tableId: string, rowId: string, values: Record<string, unknown>) =>
    req(`/api/tables/${tableId}/rows/${rowId}`, json('PATCH', { values })),
  addRow: (tableId: string, values: Record<string, unknown>) =>
    req<Record<string, unknown>>(`/api/tables/${tableId}/rows`, json('POST', { values })),
  deleteRow: (tableId: string, rowId: string) =>
    req(`/api/tables/${tableId}/rows/${rowId}`, { method: 'DELETE' }),
  distinctValues: (tableId: string, column: string) =>
    req<{ values: string[] }>(`/api/tables/${tableId}/columns/${encodeURIComponent(column)}/values`),
  createPivot: (sheetId: string, cfg: PivotConfig) =>
    req<{ id: string }>(`/api/sheets/${sheetId}/pivots`, json('POST', cfg)),
  runPivot: (pivotId: string) =>
    req<{ config: PivotConfig & { id: string; sheet_id: string }; result: PivotResult }>(`/api/pivots/${pivotId}`),
  updatePivot: (pivotId: string, cfg: PivotConfig) => req(`/api/pivots/${pivotId}`, json('PATCH', cfg)),
  deletePivot: (pivotId: string) => req(`/api/pivots/${pivotId}`, { method: 'DELETE' }),
  previewPivot: (sheetId: string, cfg: PivotConfig) =>
    req<{ result: PivotResult }>(`/api/sheets/${sheetId}/pivots/preview`, json('POST', cfg)),
};

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
