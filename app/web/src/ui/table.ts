/** Sorting for DataTable (pure). */
export type SortDir = 'asc' | 'desc';

const compare = (a: string | number, b: string | number): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/** A sorted copy. Rows with equal values keep their original order in both directions; a column with no sortValue keeps the order. */
export function sortRows<T>(rows: T[], column: { sortValue?: (row: T) => string | number }, dir: SortDir): T[] {
  const get = column.sortValue;
  if (!get) return rows.slice();
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((x, y) => sign * compare(x.v, y.v) || x.i - y.i)
    .map((x) => x.row);
}
