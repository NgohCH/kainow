import { BadRequestException } from '@nestjs/common';
import { UUID } from './uuid7';

/** SQL text of a created_at column in full microsecond precision, for building a cursor. */
export const cursorTime = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SHAPE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(.+)$/;

/** Reads `<timestamp>|<id>`; 400 when malformed. Absent means the first page. */
export function parseCursor(before: unknown): { at: string; id: string } | null {
  if (before === undefined) return null;
  const m = typeof before === 'string' ? SHAPE.exec(before) : null;
  if (!m || !UUID.test(m[2]) || Number.isNaN(new Date(m[1].replace(/\.\d{6}Z$/, 'Z')).getTime())) throw new BadRequestException('before is not a valid page cursor.');
  return { at: m[1], id: m[2] };
}
