import { Checkbox, Loader, Menu, Popover, ScrollArea, TextInput, useComputedColorScheme } from '@mantine/core';
import type { CellClickedEvent, ColDef, ColGroupDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';

import {
  api,
  type ColumnMeta,
  type PivotConfig,
  type PivotResult,
  type PivotTreeNode,
  type SaveState,
  type Sheet,
  type ValueField,
} from '../api';
import { SaveBadge } from './SaveBadge';

const AGG_OPTIONS: { value: ValueField['agg']; label: string; short: string }[] = [
  { value: 'sum', label: 'Sum', short: 'Sum' },
  { value: 'count', label: 'Count', short: 'Count' },
  { value: 'avg', label: 'Average', short: 'Avg' },
  { value: 'min', label: 'Min', short: 'Min' },
  { value: 'max', label: 'Max', short: 'Max' },
  { value: 'distinct_count', label: 'Distinct Count', short: 'Distinct' },
];
const ROW_INDENT = 30;
const TREE_INDENT = 18;

type ZoneId = 'rows' | 'columns' | 'values' | 'filters';
interface DragPayload {
  field: string;
  from: ZoneId | 'list';
}

function setDrag(e: DragEvent, payload: DragPayload) {
  e.dataTransfer.setData('application/json', JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'move';
}

const fmt = (v: number | string | null | undefined) =>
  v === null || v === undefined
    ? ''
    : typeof v === 'number'
      ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : String(v);

function AddFieldMenu({
  columns,
  exclude,
  onPick,
}: {
  columns: ColumnMeta[];
  exclude: string[];
  onPick: (field: string) => void;
}) {
  const available = columns.filter((c) => !exclude.includes(c.name));
  if (available.length === 0) return null;
  return (
    <Menu position="bottom-start" withArrow>
      <Menu.Target>
        <button className="pv-add-square">+</button>
      </Menu.Target>
      <Menu.Dropdown>
        {available.map((c) => (
          <Menu.Item key={c.name} onClick={() => onPick(c.name)}>
            {c.source}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/** A settings-row drop target: ROWS/COLUMNS/VALUES/FILTER accept dragged chips. */
function Zone({
  onDropField,
  children,
}: {
  onDropField: (p: DragPayload) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`pv-settings-fields pv-zone${over ? ' dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        try {
          onDropField(JSON.parse(e.dataTransfer.getData('application/json')));
        } catch {
          /* not our payload */
        }
      }}
    >
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`pv-toggle-row${disabled ? ' disabled' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      title={disabled ? 'Needs 2+ row fields' : undefined}
    >
      <span className="pv-toggle-row-label">{label}</span>
      <span className={`pv-toggle${checked ? ' on' : ''}`}>
        <span className="pv-toggle-knob" />
      </span>
    </div>
  );
}

export function PivotView({
  sheet,
  pivotId,
  onRenamed,
}: {
  sheet: Sheet;
  pivotId: string;
  onRenamed?: (name: string) => void;
}) {
  const scheme = useComputedColorScheme('light');
  const gridRef = useRef<AgGridReact>(null);
  const [cfg, setCfg] = useState<PivotConfig | null>(null);
  const [result, setResult] = useState<PivotResult | null>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const loaded = useRef(false);
  const debounce = useRef<number | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(true);
  const [collapsibleColumns, setCollapsibleColumns] = useState(true);
  const [treeMode, setTreeMode] = useState(true);
  const [frozenFirstColumn, setFrozenFirstColumn] = useState(true);
  const [showTotals, setShowTotals] = useState(true);
  const [autoWidth, setAutoWidth] = useState(false);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());

  const colByName = useMemo(() => {
    const m: Record<string, ColumnMeta> = {};
    sheet.columns.forEach((c) => (m[c.name] = c));
    return m;
  }, [sheet.columns]);
  const label = (f: string) => colByName[f]?.source ?? f;

  useEffect(() => {
    api
      .runPivot(pivotId)
      .then(({ config, result }) => {
        setCfg({
          name: config.name,
          rows: config.rows,
          columns: config.columns,
          values: config.values,
          filters: config.filters,
        });
        setResult(result);
        loaded.current = true;
      })
      .catch((e) => {
        setSave('error');
        setSaveError((e as Error).message);
      });
  }, [pivotId]);

  // Autosave + live re-execute on every config change (debounced).
  useEffect(() => {
    if (!loaded.current || !cfg) return;
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      setSave('saving');
      setSaveError(null);
      try {
        await api.updatePivot(pivotId, cfg);
        const { result } = await api.runPivot(pivotId);
        setResult(result);
        setCollapsedPaths(new Set());
        setSave('saved');
        onRenamed?.(cfg.name);
        window.setTimeout(() => setSave((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } catch (e) {
        setSave('error');
        setSaveError((e as Error).message);
      }
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, pivotId]);

  const update = (patch: Partial<PivotConfig>) => setCfg((c) => (c ? { ...c, ...patch } : c));

  const removeFrom = (c: PivotConfig, zone: ZoneId | 'list', field: string): PivotConfig => {
    if (zone === 'rows') return { ...c, rows: c.rows.filter((f) => f !== field) };
    if (zone === 'columns') return { ...c, columns: c.columns.filter((f) => f !== field) };
    if (zone === 'values') return { ...c, values: c.values.filter((v) => v.field !== field) };
    if (zone === 'filters') return { ...c, filters: c.filters.filter((f) => f.field !== field) };
    return c;
  };

  const dropInto = (zone: ZoneId) => (p: DragPayload) => {
    setCfg((c) => {
      if (!c) return c;
      let next = removeFrom(c, p.from, p.field);
      if (zone === 'rows' && !next.rows.includes(p.field)) next = { ...next, rows: [...next.rows, p.field] };
      if (zone === 'columns' && !next.columns.includes(p.field))
        next = { ...next, columns: [...next.columns, p.field] };
      if (zone === 'values' && !next.values.some((v) => v.field === p.field)) {
        const agg: ValueField['agg'] = colByName[p.field]?.type === 'number' ? 'sum' : 'count';
        next = { ...next, values: [...next.values, { field: p.field, agg }] };
      }
      if (zone === 'filters' && !next.filters.some((f) => f.field === p.field))
        next = { ...next, filters: [...next.filters, { field: p.field, values: [] }] };
      return next;
    });
  };

  const treeEligible = (cfg?.rows.length ?? 0) >= 2 && !!result?.rowTree;
  const treeActive = treeEligible && treeMode;

  // ----- result grid -----
  const { columnDefs, rowData, pinnedBottom } = useMemo(() => {
    if (!result) return { columnDefs: [] as (ColDef | ColGroupDef)[], rowData: [], pinnedBottom: [] };

    const cellsToRow = (cells: (number | string | null)[][], total: (number | null)[]) => {
      const row: Record<string, unknown> = {};
      cells.forEach((cell, ci) => cell?.forEach((val, vi) => (row[`c${ci}_v${vi}`] = val)));
      total.forEach((t, vi) => (row[`t_v${vi}`] = t));
      return row;
    };

    // --- label column(s): tree mode gets one custom column, flat mode gets one per row field ---
    const defs: (ColDef | ColGroupDef)[] = [];
    if (treeActive) {
      defs.push({
        field: '__label',
        headerName: result.rowFields.map((f) => f.label).join(' / '),
        pinned: frozenFirstColumn ? 'left' : undefined,
        minWidth: 200,
        // A plain function passed as cellRenderer is invoked by ag-grid-react
        // as a React function component, so this must return JSX — an HTML
        // string here would be escaped and shown as literal text.
        cellRenderer: (p: { data: Record<string, unknown> }) => {
          const isGroup = p.data.__isGroup as boolean;
          const path = p.data.__path as string;
          const indent = p.data.__indent as number;
          return (
            <span style={{ paddingLeft: indent, fontWeight: isGroup ? 600 : 500 }}>
              {isGroup && <span className="pv-tree-toggle">{collapsedPaths.has(path) ? '▸' : '▼'}</span>}
              {p.data.__label as string}
            </span>
          );
        },
      });
    } else if (result.rowFields.length > 0) {
      result.rowFields.forEach((rf, i) =>
        defs.push({
          field: `__r${i}`,
          headerName: rf.label,
          pinned: frozenFirstColumn ? 'left' : undefined,
          cellStyle: { fontWeight: 500 },
        })
      );
    } else {
      defs.push({ field: '__r0', headerName: '', pinned: frozenFirstColumn ? 'left' : undefined, width: 90 });
    }

    const numCol = (field: string, headerName: string, bold = false): ColDef => ({
      field,
      headerName,
      type: 'rightAligned',
      cellClass: 'pv-num',
      cellStyle: bold ? { fontWeight: 600 } : undefined,
      valueFormatter: (p) => fmt(p.value),
    });

    result.columnKeys.forEach((ck, ci) => {
      const children: ColDef[] = result.values.map((v, vi) => numCol(`c${ci}_v${vi}`, v.label));
      if (ck.length === 0) {
        defs.push(...children);
      } else if (collapsibleColumns) {
        defs.push({ headerName: ck.join(' / '), groupId: `grp${ci}`, children });
      } else {
        // Flattened: one column per (column-key, value) combo, no group header row.
        defs.push(
          ...result.values.map((v, vi) => numCol(`c${ci}_v${vi}`, `${ck.join(' / ')} · ${v.label}`))
        );
      }
    });

    if (result.colFields.length > 0) {
      const totalChildren = result.values.map((v, vi) => numCol(`t_v${vi}`, v.label, true));
      if (collapsibleColumns) {
        defs.push({ headerName: 'Total', groupId: 'grpTotal', children: totalChildren });
      } else {
        defs.push(...result.values.map((v, vi) => numCol(`t_v${vi}`, `Total · ${v.label}`, true)));
      }
    }

    let rowData: Record<string, unknown>[];
    if (treeActive && result.rowTree) {
      rowData = [];
      const walk = (node: PivotTreeNode) => {
        const path = node.keys.join('␟');
        rowData.push({
          __label: node.keys[node.keys.length - 1],
          __indent: (node.level - 1) * TREE_INDENT,
          __isGroup: !node.isLeaf,
          __path: path,
          ...cellsToRow(node.cells, node.total),
        });
        if (!node.isLeaf && !collapsedPaths.has(path)) {
          node.children!.forEach(walk);
        }
      };
      result.rowTree.forEach(walk);
    } else {
      rowData = result.rows.map((r) => {
        const row: Record<string, unknown> = {};
        r.keys.forEach((k, i) => (row[`__r${i}`] = k));
        return { ...row, ...cellsToRow(r.cells, r.total) };
      });
    }

    let pinnedBottom: Record<string, unknown>[] = [];
    if (showTotals && result.rows.length > 0) {
      const grand = cellsToRow(result.grandTotal.cells, result.grandTotal.total);
      if (treeActive) {
        pinnedBottom = [{ __label: 'Grand Total', __indent: 0, __isGroup: false, __path: '', ...grand }];
      } else {
        const keys = result.rowFields.length ? ['Grand Total', ...Array(result.rowFields.length - 1).fill('')] : ['Grand Total'];
        const row: Record<string, unknown> = {};
        keys.forEach((k, i) => (row[`__r${i}`] = k));
        pinnedBottom = [{ ...row, ...grand }];
      }
    }

    return { columnDefs: defs, rowData, pinnedBottom };
  }, [result, treeActive, collapsedPaths, collapsibleColumns, frozenFirstColumn, showTotals]);

  useEffect(() => {
    if (!gridRef.current?.api) return;
    if (autoWidth) gridRef.current.api.autoSizeAllColumns();
    else gridRef.current.api.sizeColumnsToFit();
  }, [autoWidth, columnDefs]);

  const onCellClicked = (e: CellClickedEvent) => {
    if (e.colDef.field !== '__label') return;
    const data = e.data as Record<string, unknown>;
    if (!data.__isGroup) return;
    const path = data.__path as string;
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // ----- inline chart: first value by row keys (design 1a) -----
  const chart = useMemo(() => {
    if (!result || result.rowFields.length === 0 || result.values.length === 0) return null;
    const bars = result.rows
      .map((r) => ({
        label: r.keys.join(' / '),
        value: (r.total[0] ?? r.cells[0]?.[0]) as number | null,
      }))
      .filter((b): b is { label: string; value: number } => typeof b.value === 'number');
    if (bars.length < 2) return null;
    const shown = bars.slice(0, 12);
    const max = Math.max(...shown.map((b) => b.value), 0);
    if (max <= 0) return null;
    return {
      title: `${result.values[0].label} by ${result.rowFields.map((f) => f.label).join(', ')}`,
      bars: shown,
      max,
      truncated: bars.length > shown.length,
    };
  }, [result]);

  if (!cfg) {
    return (
      <div className="pv-empty">
        {save === 'error' ? <span style={{ color: 'var(--pv-accent)' }}>{saveError}</span> : <Loader size="sm" />}
      </div>
    );
  }

  const compoundChip = (
    zone: ZoneId,
    field: string,
    nameText: string,
    onRemove: () => void,
    middle?: ReactNode
  ) => (
    <span
      key={field}
      className="pv-chip-compound"
      draggable
      onDragStart={(e) => setDrag(e, { field, from: zone })}
    >
      <span className="pv-chip-seg">{nameText}</span>
      {middle}
      <span className="pv-chip-seg-x" title="Remove" onClick={onRemove}>
        ✕
      </span>
    </span>
  );

  return (
    <>
      {/* Pivot Settings panel (design turn 2: Enhanced Pivot Builder) */}
      <div className="pv-settings">
        <div className="pv-settings-head">
          <span className="pv-settings-title">Pivot Settings</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {result?.truncated && (
              <span className="pv-chip-empty" style={{ color: 'var(--pv-accent)' }}>
                Result truncated
              </span>
            )}
            <SaveBadge state={save} error={saveError} />
            <TextInput
              size="xs"
              value={cfg.name}
              onChange={(e) => update({ name: e.currentTarget.value })}
              w={140}
              title="Pivot name"
            />
            <button className="pv-settings-toggle" onClick={() => setSettingsOpen((o) => !o)}>
              {settingsOpen ? 'Hide settings' : 'Show settings'}
            </button>
          </div>
        </div>

        {settingsOpen && (
          <div className="pv-settings-body">
            <div className="pv-settings-row">
              <span className="pv-settings-label">Values</span>
              <Zone onDropField={dropInto('values')}>
                <AddFieldMenu
                  columns={sheet.columns}
                  exclude={cfg.values.map((v) => v.field)}
                  onPick={(f) => dropInto('values')({ field: f, from: 'list' })}
                />
                {cfg.values.map((v) =>
                  compoundChip(
                    'values',
                    v.field,
                    label(v.field),
                    () => setCfg((c) => (c ? removeFrom(c, 'values', v.field) : c)),
                    <Menu position="bottom-start" withArrow>
                      <Menu.Target>
                        <button
                          className="pv-chip-seg-btn"
                          style={{ borderLeft: '1px solid rgba(255,255,255,0.2)' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {AGG_OPTIONS.find((a) => a.value === v.agg)?.short} ▾
                        </button>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {AGG_OPTIONS.map((a) => (
                          <Menu.Item
                            key={a.value}
                            fw={a.value === v.agg ? 700 : 400}
                            onClick={() =>
                              update({
                                values: cfg.values.map((x) => (x.field === v.field ? { ...x, agg: a.value } : x)),
                              })
                            }
                          >
                            {a.label}
                          </Menu.Item>
                        ))}
                      </Menu.Dropdown>
                    </Menu>
                  )
                )}
                {cfg.values.length === 0 && <span className="pv-chip-empty">None</span>}
              </Zone>
            </div>

            <div className="pv-settings-row">
              <span className="pv-settings-label">Columns</span>
              <Zone onDropField={dropInto('columns')}>
                <AddFieldMenu
                  columns={sheet.columns}
                  exclude={cfg.columns}
                  onPick={(f) => dropInto('columns')({ field: f, from: 'list' })}
                />
                {cfg.columns.map((f) =>
                  compoundChip('columns', f, label(f), () => update({ columns: cfg.columns.filter((x) => x !== f) }))
                )}
                {cfg.columns.length === 0 && <span className="pv-chip-empty">None</span>}
              </Zone>
            </div>

            <div className="pv-settings-row">
              <span className="pv-settings-label">Rows</span>
              <Zone onDropField={dropInto('rows')}>
                <div className="pv-rows-stack" style={{ width: '100%' }}>
                  {cfg.rows.map((f, i) => (
                    <div className="pv-rows-line" key={f} style={{ paddingLeft: i * ROW_INDENT }}>
                      {i === 0 && (
                        <AddFieldMenu
                          columns={sheet.columns}
                          exclude={cfg.rows}
                          onPick={(field) => dropInto('rows')({ field, from: 'list' })}
                        />
                      )}
                      {compoundChip('rows', f, label(f), () => update({ rows: cfg.rows.filter((x) => x !== f) }))}
                    </div>
                  ))}
                  <div className="pv-rows-line" style={{ paddingLeft: cfg.rows.length * ROW_INDENT }}>
                    {cfg.rows.length === 0 ? (
                      <>
                        <AddFieldMenu
                          columns={sheet.columns}
                          exclude={cfg.rows}
                          onPick={(field) => dropInto('rows')({ field, from: 'list' })}
                        />
                        <span className="pv-chip-empty">None</span>
                      </>
                    ) : (
                      <AddFieldMenu
                        columns={sheet.columns}
                        exclude={cfg.rows}
                        onPick={(field) => dropInto('rows')({ field, from: 'list' })}
                      />
                    )}
                  </div>
                </div>
              </Zone>
            </div>

            <div className="pv-settings-row">
              <span className="pv-settings-label">Filter</span>
              <Zone onDropField={dropInto('filters')}>
                <AddFieldMenu
                  columns={sheet.columns}
                  exclude={cfg.filters.map((f) => f.field)}
                  onPick={(f) => dropInto('filters')({ field: f, from: 'list' })}
                />
                {cfg.filters.map((f) => (
                  <FilterChip
                    key={f.field}
                    sheet={sheet}
                    field={f.field}
                    labelText={label(f.field)}
                    selected={f.values}
                    onChange={(values) =>
                      update({ filters: cfg.filters.map((x) => (x.field === f.field ? { ...x, values } : x)) })
                    }
                    onRemove={() => update({ filters: cfg.filters.filter((x) => x.field !== f.field) })}
                  />
                ))}
                {cfg.filters.length === 0 && <span className="pv-chip-empty">None</span>}
              </Zone>
            </div>
          </div>
        )}
      </div>

      {/* result grid */}
      <div
        className={`pv-grid ${scheme === 'dark' ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}
        style={{ flex: 1, minHeight: 0, margin: '8px 16px' }}
      >
        <AgGridReact
          ref={gridRef}
          columnDefs={columnDefs}
          rowData={rowData}
          pinnedBottomRowData={pinnedBottom}
          rowHeight={30}
          headerHeight={30}
          onCellClicked={onCellClicked}
          defaultColDef={{ resizable: true, minWidth: 90 }}
        />
      </div>

      {/* layout toolbar (design turn 2) */}
      <div className="pv-layout-toolbar">
        <ToggleRow label="Collapsible columns" checked={collapsibleColumns} onChange={setCollapsibleColumns} />
        <ToggleRow
          label="Tree mode"
          checked={treeMode}
          onChange={setTreeMode}
          disabled={!treeEligible}
        />
        <ToggleRow label="Frozen column" checked={frozenFirstColumn} onChange={setFrozenFirstColumn} />
        <ToggleRow label="Totals" checked={showTotals} onChange={setShowTotals} />
        <ToggleRow label="Auto width" checked={autoWidth} onChange={setAutoWidth} />
      </div>

      {/* inline chart (design 1a) */}
      {chart && (
        <div className="pv-chart">
          <div className="pv-chart-title">
            {chart.title}
            {chart.truncated ? ' (first 12)' : ''}
          </div>
          <div className="pv-chart-bars">
            {chart.bars.map((b) => (
              <div key={b.label} className="pv-bar-col" title={`${b.label}: ${fmt(b.value)}`}>
                <div className="pv-bar-val">{fmt(b.value)}</div>
                <div className="pv-bar" style={{ height: Math.max(4, Math.round((b.value / chart.max) * 78)) }} />
                <div className="pv-bar-label">{b.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function FilterChip({
  sheet,
  field,
  labelText,
  selected,
  onChange,
  onRemove,
}: {
  sheet: Sheet;
  field: string;
  labelText: string;
  selected: string[];
  onChange: (values: string[]) => void;
  onRemove: () => void;
}) {
  const [options, setOptions] = useState<string[] | null>(null);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (opened && options === null) {
      api
        .distinctValues(sheet.id, field)
        .then((r) => setOptions(r.values))
        .catch(() => setOptions([]));
    }
  }, [opened, options, sheet.id, field]);

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" withArrow>
      <Popover.Target>
        <span
          className="pv-chip-compound"
          draggable
          onDragStart={(e) => setDrag(e, { field, from: 'filters' })}
          onClick={() => setOpened((o) => !o)}
        >
          <span className="pv-chip-seg">
            {labelText}
            {selected.length > 0 ? ` (${selected.length})` : ''}
          </span>
          <span
            className="pv-chip-seg-x"
            title="Remove"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            ✕
          </span>
        </span>
      </Popover.Target>
      <Popover.Dropdown>
        <ScrollArea.Autosize mah={240}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {options === null && <Loader size="xs" />}
            {options?.length === 0 && <span style={{ fontSize: 11, color: 'var(--pv-muted)' }}>No values</span>}
            {options?.map((v) => (
              <Checkbox
                key={v}
                size="xs"
                label={v === '' ? '(blank)' : v}
                checked={selected.includes(v)}
                onChange={(e) =>
                  onChange(e.currentTarget.checked ? [...selected, v] : selected.filter((x) => x !== v))
                }
              />
            ))}
          </div>
        </ScrollArea.Autosize>
        <div style={{ fontSize: 11, color: 'var(--pv-muted)', marginTop: 6 }}>Empty selection = no filter</div>
      </Popover.Dropdown>
    </Popover>
  );
}
