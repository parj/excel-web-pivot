import { Menu, useMantineColorScheme } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type Sheet, type Workbook } from './api';
import { PivotView } from './components/PivotView';
import { TableView } from './components/TableView';
import { UploadStatusCard, useUpload } from './components/UploadZone';

function ThemeToggle() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <Menu position="bottom-end">
      <Menu.Target>
        <button className="pv-iconbtn" title="Color scheme">
          {colorScheme === 'dark' ? '☾' : '☀'}
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => setColorScheme('light')}>☀ Light</Menu.Item>
        <Menu.Item onClick={() => setColorScheme('dark')}>☾ Dark</Menu.Item>
        <Menu.Item onClick={() => setColorScheme('auto')}>🖥 System</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export default function App() {
  const [workbooks, setWorkbooks] = useState<Workbook[]>([]);
  const [sheetsByWb, setSheetsByWb] = useState<Record<string, Sheet[]>>({});
  const [activeWb, setActiveWb] = useState<string | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [view, setView] = useState<'raw' | string>('raw'); // 'raw' or a pivot id
  const [search, setSearch] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const loadWorkbooks = useCallback(async () => {
    setWorkbooks(await api.workbooks());
  }, []);

  const loadSheets = useCallback(async (wbId: string) => {
    const sheets = await api.sheets(wbId);
    setSheetsByWb((prev) => ({ ...prev, [wbId]: sheets }));
    return sheets;
  }, []);

  useEffect(() => {
    loadWorkbooks().catch(() => {});
  }, [loadWorkbooks]);

  const openWorkbook = async (wbId: string) => {
    const sheets = sheetsByWb[wbId] ?? (await loadSheets(wbId).catch(() => []));
    setActiveWb(wbId);
    setActiveSheetId(sheets[0]?.id ?? null);
    setView('raw');
  };

  const upload = useUpload(async (workbookId) => {
    await loadWorkbooks();
    await openWorkbook(workbookId);
  });

  const sheets = activeWb ? (sheetsByWb[activeWb] ?? []) : [];
  const activeSheet = sheets.find((s) => s.id === activeSheetId) ?? null;
  const activeWorkbook = workbooks.find((w) => w.id === activeWb) ?? null;

  const newPivot = async () => {
    if (!activeSheet || !activeWb) return;
    const name = `Pivot ${activeSheet.pivots.length + 1}`;
    const { id } = await api.createPivot(activeSheet.id, {
      name,
      rows: [],
      columns: [],
      values: [],
      filters: [],
    });
    await loadSheets(activeWb);
    setView(id);
  };

  const deletePivot = async (pivotId: string) => {
    await api.deletePivot(pivotId);
    if (view === pivotId) setView('raw');
    if (activeWb) await loadSheets(activeWb);
  };

  const renamePivotInTree = (pivotId: string, name: string) => {
    if (!activeWb) return;
    setSheetsByWb((prev) => ({
      ...prev,
      [activeWb]: (prev[activeWb] ?? []).map((s) =>
        s.id !== activeSheetId ? s : { ...s, pivots: s.pivots.map((p) => (p.id === pivotId ? { ...p, name } : p)) }
      ),
    }));
  };

  const filtered = workbooks.filter((w) => w.filename.toLowerCase().includes(search.toLowerCase()));
  const totalRows = sheets.reduce((n, s) => n + s.row_count, 0);

  return (
    <div
      className="pv-app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) void upload.start(f);
      }}
    >
      {/* top bar */}
      <div className="pv-topbar">
        <div className="pv-logo">
          <span className="pv-logo-badge">P</span>PivotView
        </div>
        <div style={{ flex: 1 }} />
        <div className="pv-search">
          <span style={{ color: 'var(--pv-muted)' }}>⌕</span>
          <input placeholder="Search files…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="pv-btn-primary" onClick={() => fileInput.current?.click()}>
          Upload .xlsx
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload.start(f);
            e.target.value = '';
          }}
        />
        <ThemeToggle />
      </div>

      <div className="pv-body">
        {/* sidebar: files */}
        <div className="pv-sidebar">
          <div className="pv-side-label">Files · {workbooks.length}</div>
          {filtered.length === 0 && (
            <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--pv-muted)' }}>
              {workbooks.length === 0 ? 'Drop an .xlsx anywhere, or use Upload.' : 'No matches.'}
            </div>
          )}
          {filtered.map((wb) => {
            const active = wb.id === activeWb;
            const wbSheets = sheetsByWb[wb.id];
            return (
              <div key={wb.id} className={`pv-file${active ? ' active' : ''}`} onClick={() => void openWorkbook(wb.id)}>
                <span className="pv-file-icon">▦</span>
                <div style={{ minWidth: 0 }}>
                  <div className="pv-file-name">{wb.filename}</div>
                  {active && wbSheets && (
                    <div className="pv-file-sub">
                      {wbSheets.length} sheet{wbSheets.length === 1 ? '' : 's'} ·{' '}
                      {wbSheets.reduce((n, s) => n + s.row_count, 0).toLocaleString()} rows
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div style={{ flex: 1 }} />
          <UploadStatusCard status={upload.status} onDismiss={upload.dismiss} />
        </div>

        {/* main workspace */}
        <div className="pv-main">
          {!activeSheet && <div className="pv-empty">Upload a workbook, or pick a file on the left.</div>}
          {activeSheet && activeWorkbook && (
            <>
              {/* breadcrumb: file › sheet chips */}
              <div className="pv-crumb">
                <span className="pv-crumb-file">{activeWorkbook.filename}</span>
                <span className="pv-crumb-sep">›</span>
                {sheets.map((s) => (
                  <span
                    key={s.id}
                    className={`pv-sheet-chip${s.id === activeSheetId ? ' active' : ''}`}
                    onClick={() => {
                      setActiveSheetId(s.id);
                      setView('raw');
                    }}
                  >
                    {s.sheet_name}
                  </span>
                ))}
              </div>

              {/* view tabs: raw + pivots */}
              <div className="pv-tabs">
                <div className={`pv-tab${view === 'raw' ? ' active' : ''}`} onClick={() => setView('raw')}>
                  Raw Data
                </div>
                {activeSheet.pivots.map((p) => (
                  <div
                    key={p.id}
                    className={`pv-tab${view === p.id ? ' active' : ''}`}
                    onClick={() => setView(p.id)}
                  >
                    {p.name}
                    {view === p.id && (
                      <span
                        className="pv-tab-x"
                        title="Delete pivot"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deletePivot(p.id);
                        }}
                      >
                        ✕
                      </span>
                    )}
                  </div>
                ))}
                <div className="pv-tab" onClick={() => void newPivot()}>
                  + New Pivot
                </div>
              </div>

              {view === 'raw' ? (
                <TableView key={activeSheet.id} sheet={activeSheet} />
              ) : (
                <PivotView
                  key={view}
                  sheet={activeSheet}
                  pivotId={view}
                  onRenamed={(name) => renamePivotInTree(view, name)}
                />
              )}
            </>
          )}

          {/* status bar */}
          <div className="pv-statusbar">
            <span>
              {workbooks.length} file{workbooks.length === 1 ? '' : 's'} loaded
            </span>
            {activeSheet && (
              <>
                <span className="dot">·</span>
                <span>{totalRows.toLocaleString()} rows in workbook</span>
                <span className="dot">·</span>
                <span>
                  {activeSheet.sheet_name}: {activeSheet.row_count.toLocaleString()} rows ·{' '}
                  {activeSheet.columns.length} cols
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
