/**
 * SQL predicates shared by every surface that reports on resource lines (the Resources tab, the project dashboard, the
 * timeline and Needs you), so they cannot disagree.
 */

/** A Needed line whose needed-by date is before `todayParam` (a UTC+8 date parameter, e.g. `$2`). */
export const neededByPassedSql = (alias: string, todayParam: string): string =>
  `(${alias}.status = 'needed' AND ${alias}.needed_by IS NOT NULL AND ${alias}.needed_by < ${todayParam}::date)`;

/**
 * D91: `other` is another project's non-Cancelled line of the same catalogue item whose period overlaps `mine` (the SQL
 * mirrors `spansOverlap`: both starts present, inclusive, a null end runs forever). `mine` must itself be a non-Cancelled
 * line with a start; the caller adds that.
 */
export const overlappingLineSql = (mine: string, other: string): string =>
  `${other}.item_id = ${mine}.item_id AND ${other}.project_id <> ${mine}.project_id AND ${other}.status <> 'cancelled' AND ${other}.starts_on IS NOT NULL
   AND (${mine}.ends_on IS NULL OR ${mine}.ends_on >= ${other}.starts_on)
   AND (${other}.ends_on IS NULL OR ${other}.ends_on >= ${mine}.starts_on)`;
