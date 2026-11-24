import { useId, useMemo, useState, type ReactNode } from 'react';
import { sortRows, type SortDir } from './table.ts';

/** `wide` marks a cell that holds forms or long text: on narrow screens its label sits above it instead of beside it. */
export interface Column<T> { key: string; header: string; cell: (row: T) => ReactNode; sortValue?: (row: T) => string | number; wide?: boolean }

/**
 * A semantic table: caption, column headers (a button when sortable, with aria-sort), empty and loading rows. Narrow
 * screens stack each row into labelled pairs (data-label). `rowId` gives each row an id (and makes it focusable) so a
 * link can open the page at that row.
 */
export function DataTable<T>({ caption, columns, rows, rowKey, rowId, empty, loading, initialSort }: {
  caption: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; rowId?: (row: T) => string; empty: string; loading?: boolean;
  initialSort?: { key: string; dir: SortDir };
}) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(initialSort ?? null);
  const shown = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    return col ? sortRows(rows, col, sort!.dir) : rows;
  }, [rows, columns, sort]);
  const toggle = (key: string) => setSort((s) => (s && s.key === key && s.dir === 'asc' ? { key, dir: 'desc' } : { key, dir: 'asc' }));
  const sortable = columns.filter((c) => c.sortValue);
  const uid = useId();
  return (
    <div className="data-table-wrap">
    {sortable.length > 0 && (
      <div className="table-sort-select">
        <label htmlFor={`${uid}-by`}>Sort by</label>
        <select id={`${uid}-by`} value={sort?.key ?? ''} onChange={(e) => setSort(e.target.value ? { key: e.target.value, dir: sort?.dir ?? 'asc' } : null)}>
          <option value="">Original order</option>
          {sortable.map((c) => <option key={c.key} value={c.key}>{c.header}</option>)}
        </select>
        <label htmlFor={`${uid}-dir`} className="visually-hidden">Sort direction</label>
        <select id={`${uid}-dir`} value={sort?.dir ?? 'asc'} disabled={!sort} onChange={(e) => sort && setSort({ key: sort.key, dir: e.target.value as SortDir })}>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>
    )}
    <table className="data-table" aria-busy={loading || undefined}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => {
            const active = sort?.key === c.key;
            return (
              <th key={c.key} scope="col" aria-sort={c.sortValue ? (active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}>
                {c.sortValue ? (
                  <button type="button" className="sort-button" onClick={() => toggle(c.key)}>
                    {c.header}
                    <span aria-hidden="true" className="sort-mark">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                  </button>
                ) : c.header}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {loading ? (
          <tr className="table-note"><td colSpan={columns.length}><span role="status">Loading…</span></td></tr>
        ) : shown.length === 0 ? (
          <tr className="table-note"><td colSpan={columns.length}>{empty}</td></tr>
        ) : (
          shown.map((row) => (
            <tr key={rowKey(row)} {...(rowId ? { id: rowId(row), tabIndex: -1 } : {})}>
              {columns.map((c, i) => (
                i === 0
                  ? <th key={c.key} scope="row" data-label={c.header} className={c.wide ? 'cell-wide' : undefined}>{c.cell(row)}</th>
                  : <td key={c.key} data-label={c.header} className={c.wide ? 'cell-wide' : undefined}>{c.cell(row)}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
    </div>
  );
}
