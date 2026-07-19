import { useComputedColorScheme } from '@mantine/core';
import type { CellValueChangedEvent, ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, type SaveState, type Sheet } from '../api';
import { SaveBadge } from './SaveBadge';

const PAGE_SIZE = 500;

export function TableView({ sheet }: { sheet: Sheet }) {
  const scheme = useComputedColorScheme('light');
  const gridRef = useRef<AgGridReact>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [save, setSave] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimer = useRef<number | null>(null);

  const load = useCallback(
    async (off: number) => {
      const data = await api.tableData(sheet.id, PAGE_SIZE, off);
      setRows(data.rows);
      setTotal(data.total);
      setOffset(off);
    },
    [sheet.id]
  );

  useEffect(() => {
    load(0).catch(() => {});
  }, [load]);

  const flashSaved = () => {
    setSave('saved');
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSave('idle'), 2000);
  };

  const withSave = async (fn: () => Promise<unknown>) => {
    setSave('saving');
    setSaveError(null);
    try {
      await fn();
      flashSaved();
    } catch (e) {
      setSave('error');
      setSaveError((e as Error).message);
    }
  };

  const columnDefs = useMemo<ColDef[]>(
    () =>
      sheet.columns.map((c) => ({
        field: c.name,
        headerName: c.source,
        editable: true,
        filter: true,
        sortable: true,
        resizable: true,
        cellDataType: c.type === 'number' ? 'number' : c.type === 'bool' ? 'boolean' : 'text',
        type: c.type === 'number' ? 'rightAligned' : undefined,
        cellClass: c.type === 'number' || c.type === 'date' ? 'pv-num' : undefined,
        valueFormatter:
          c.type === 'date'
            ? (p) => (p.value ? String(p.value).replace('T', ' ').slice(0, 19) : '')
            : c.type === 'number'
              ? (p) =>
                  p.value === null || p.value === undefined
                    ? ''
                    : Number(p.value).toLocaleString(undefined, { maximumFractionDigits: 2 })
              : undefined,
      })),
    [sheet.columns]
  );

  const onCellValueChanged = (e: CellValueChangedEvent) => {
    const rowId = e.data._row_id as string;
    const field = e.colDef.field!;
    void withSave(() => api.patchRow(sheet.id, rowId, { [field]: e.newValue }));
  };

  const addRow = () =>
    withSave(async () => {
      const created = await api.addRow(sheet.id, {});
      setRows((prev) => [...prev, created]);
      setTotal((t) => t + 1);
    });

  const deleteSelected = () => {
    const selected = gridRef.current?.api.getSelectedRows() ?? [];
    if (selected.length === 0) return;
    void withSave(async () => {
      for (const row of selected) {
        await api.deleteRow(sheet.id, row._row_id as string);
      }
      const ids = new Set(selected.map((r) => r._row_id));
      setRows((prev) => prev.filter((r) => !ids.has(r._row_id)));
      setTotal((t) => t - selected.length);
    });
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="pv-toolbar">
        <SaveBadge state={save} error={saveError} />
        <div style={{ flex: 1 }} />
        <button className="pv-btn-ghost" onClick={() => void addRow()}>
          + Add row
        </button>
        <button className="pv-btn-ghost danger" onClick={deleteSelected}>
          Delete selected
        </button>
      </div>

      <div
        className={`pv-grid ${scheme === 'dark' ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}
        style={{ flex: 1, minHeight: 0, margin: '0 16px' }}
      >
        <AgGridReact
          ref={gridRef}
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(p) => p.data._row_id}
          rowSelection="multiple"
          rowHeight={30}
          headerHeight={32}
          onCellValueChanged={onCellValueChanged}
          stopEditingWhenCellsLoseFocus
        />
      </div>

      <div className="pv-pager">
        <button className="pv-btn-ghost" disabled={offset === 0} onClick={() => void load(offset - PAGE_SIZE)}>
          ‹
        </button>
        <span>
          Page {page} / {pages} · {total.toLocaleString()} rows
        </span>
        <button
          className="pv-btn-ghost"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => void load(offset + PAGE_SIZE)}
        >
          ›
        </button>
      </div>
    </>
  );
}
