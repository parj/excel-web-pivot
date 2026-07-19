import { Checkbox, Loader, Menu, Popover, ScrollArea, TextInput, useComputedColorScheme } from '@mantine/core';
import type { ColDef, ColGroupDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';

import {
  api,
  type ColumnMeta,
  type PivotConfig,
  type PivotResult,
  type SaveState,
  type Sheet,
  type ValueField,
} from '../api';
import { SaveBadge } from './SaveBadge';

const AGG_OPTIONS: { value: ValueField['agg']; label: string; short: string }[] = [
  { value: 'sum', label: 'Sum', short: 'SUM' },
  { value: 'count', label: 'Count', short: 'COUNT' },
  { value: 'avg', label: 'Average', short: 'AVG' },
  { value: 'min', label: 'Min', short: 'MIN' },
  { value: 'max', label: 'Max', short: 'MAX' },
  { value: 'distinct_count', label: 'Distinct Count', short: 'UNIQ' },
];

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

/** One labelled zone in the config strip: ROWS [chip] [chip] [+] */
function Zone({
  label,
  onDropField,
  children,
  addMenu,
}: {
  label: string;
  onDropField: (p: DragPayload) => void;
  children: ReactNode;
  addMenu: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`pv-zone${over ? ' dragover' : ''}`}
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
      <span className="pv-zone-label">{label}</span>
      {children}
      {addMenu}
    </div>
  );
}

function AddFieldMenu({ columns, exclude, onPick }: { columns: ColumnMeta[]; exclude: string[]; onPick: (field: string) => void }) {
  const available = columns.filter((c) => !exclude.includes(c.name));
  if (available.length === 0) return null;
  return (
    <Menu position="bottom-start" withArrow>
      <Menu.Target>
        <button className="pv-add">+</button>
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
  const [cfg, setCfg] = useState<PivotConfig | null>(null);
  const [result, setResult] = useState<PivotResult | null>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const loaded = useRef(false);
  const debounce = useRef<number | null>(null);

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

  // ----- result grid -----
  const { columnDefs, rowData, pinnedBottom } = useMemo(() => {
    if (!result) return { columnDefs: [] as (ColDef | ColGroupDef)[], rowData: [], pinnedBottom: [] };

    const defs: (ColDef | ColGroupDef)[] = result.rowFields.map((rf, i) => ({
      field: `__r${i}`,
      headerName: rf.label,
      pinned: 'left',
      cellStyle: { fontWeight: 500 },
    }));
    if (result.rowFields.length === 0) {
      defs.push({ field: '__r0', headerName: '', pinned: 'left', width: 90 });
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
      if (ck.length > 0) {
        defs.push({ headerName: ck.join(' / '), children });
      } else {
        defs.push(...children);
      }
    });

    if (result.colFields.length > 0 && result.values.some((v) => ['sum', 'count'].includes(v.agg))) {
      defs.push({
        headerName: 'Total',
        children: result.values.map((v, vi) => numCol(`t_v${vi}`, v.label, true)),
      });
    }

    const toRow = (keys: string[], cells: (number | string | null)[][], total: (number | null)[]) => {
      const row: Record<string, unknown> = {};
      keys.forEach((k, i) => (row[`__r${i}`] = k));
      cells.forEach((cell, ci) => cell?.forEach((val, vi) => (row[`c${ci}_v${vi}`] = val)));
      total.forEach((t, vi) => (row[`t_v${vi}`] = t));
      return row;
    };

    const rowData = result.rows.map((r) => toRow(r.keys, r.cells, r.total));
    const grand = toRow(
      result.rowFields.length ? ['Grand Total', ...Array(result.rowFields.length - 1).fill('')] : ['Grand Total'],
      result.grandTotal.cells,
      result.grandTotal.total
    );
    return { columnDefs: defs, rowData, pinnedBottom: result.rows.length > 0 ? [grand] : [] };
  }, [result]);

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

  const chip = (zone: ZoneId, field: string, text: string, extra?: ReactNode) => (
    <span key={field} className="pv-chip-red" draggable onDragStart={(e) => setDrag(e, { field, from: zone })}>
      {text}
      {extra}
      <span
        className="pv-chip-x"
        title="Remove"
        onClick={() => setCfg((c) => (c ? removeFrom(c, zone, field) : c))}
      >
        ✕
      </span>
    </span>
  );

  return (
    <>
      {/* pivot config strip (design 1a) */}
      <div className="pv-strip">
        <Zone
          label="Rows"
          onDropField={dropInto('rows')}
          addMenu={<AddFieldMenu columns={sheet.columns} exclude={cfg.rows} onPick={(f) => dropInto('rows')({ field: f, from: 'list' })} />}
        >
          {cfg.rows.map((f) => chip('rows', f, label(f)))}
          {cfg.rows.length === 0 && <span className="pv-chip-empty">None</span>}
        </Zone>
        <Zone
          label="Columns"
          onDropField={dropInto('columns')}
          addMenu={<AddFieldMenu columns={sheet.columns} exclude={cfg.columns} onPick={(f) => dropInto('columns')({ field: f, from: 'list' })} />}
        >
          {cfg.columns.map((f) => chip('columns', f, label(f)))}
          {cfg.columns.length === 0 && <span className="pv-chip-empty">None</span>}
        </Zone>
        <Zone
          label="Values"
          onDropField={dropInto('values')}
          addMenu={
            <AddFieldMenu
              columns={sheet.columns}
              exclude={cfg.values.map((v) => v.field)}
              onPick={(f) => dropInto('values')({ field: f, from: 'list' })}
            />
          }
        >
          {cfg.values.map((v) => (
            <Menu key={v.field} position="bottom-start" withArrow>
              <Menu.Target>
                <span
                  className="pv-chip-red"
                  style={{ cursor: 'pointer' }}
                  draggable
                  onDragStart={(e) => setDrag(e, { field: v.field, from: 'values' })}
                >
                  {label(v.field)} · {AGG_OPTIONS.find((a) => a.value === v.agg)?.short}
                  <span
                    className="pv-chip-x"
                    title="Remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCfg((c) => (c ? removeFrom(c, 'values', v.field) : c));
                    }}
                  >
                    ✕
                  </span>
                </span>
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
          ))}
          {cfg.values.length === 0 && <span className="pv-chip-empty">None</span>}
        </Zone>
        <Zone
          label="Filter"
          onDropField={dropInto('filters')}
          addMenu={
            <AddFieldMenu
              columns={sheet.columns}
              exclude={cfg.filters.map((f) => f.field)}
              onPick={(f) => dropInto('filters')({ field: f, from: 'list' })}
            />
          }
        >
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

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
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
        </div>
      </div>

      {/* result grid */}
      <div
        className={`pv-grid ${scheme === 'dark' ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}
        style={{ flex: 1, minHeight: 0, margin: '8px 16px' }}
      >
        <AgGridReact
          columnDefs={columnDefs}
          rowData={rowData}
          pinnedBottomRowData={pinnedBottom}
          rowHeight={30}
          headerHeight={30}
          defaultColDef={{ resizable: true, minWidth: 90 }}
        />
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
          className="pv-chip-red"
          style={{ cursor: 'pointer' }}
          draggable
          onDragStart={(e) => setDrag(e, { field, from: 'filters' })}
          onClick={() => setOpened((o) => !o)}
        >
          {labelText}
          {selected.length > 0 ? ` (${selected.length})` : ''}
          <span
            className="pv-chip-x"
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
