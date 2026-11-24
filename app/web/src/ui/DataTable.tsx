import { useMemo, useState, type ReactNode } from 'react';
import { sortRows, type SortDir } from './table.ts';

export interface Column<T> { key: string; header: string; cell: (row: T) => ReactNode; sortValue?: (row: T) => string | number }

/** A semantic table: caption, column headers (a button when sortable, with aria-sort), empty and loading rows. Narrow screens stack each row into labelled pairs (data-label). */
export function DataTable<T>({ caption, columns, rows, rowKey, empty, loading, initialSort }: {
  caption: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty: string; loading?: boolean;
  initialSort?: { key: string; dir: SortDir };
}) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(initialSort ?? null);
  const shown = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    return col ? sortRows(rows, col, sort!.dir) : rows;
  }, [rows, columns, sort]);
  const toggle = (key: string) => setSort((s) => (s && s.key === key && s.dir === 'asc' ? { key, dir: 'desc' } : { key, dir: 'asc' }));
  return (
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
          <tr className="table-note"><td colSpan={columns.length} role="status">Loading…</td></tr>
        ) : shown.length === 0 ? (
          <tr className="table-note"><td colSpan={columns.length}>{empty}</td></tr>
        ) : (
          shown.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c, i) => (
                i === 0
                  ? <th key={c.key} scope="row" data-label={c.header}>{c.cell(row)}</th>
                  : <td key={c.key} data-label={c.header}>{c.cell(row)}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
