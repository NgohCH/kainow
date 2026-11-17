import { BadRequestException } from '@nestjs/common';
import { refuseSecrets } from '../discussion/messages';

export const MAX_REASON_CHARS = 1_000;

/** A box's own rule where it already had one: its longest length and its refusal (kept so its wording does not change). */
export interface ReasonRule {
  max?: number;
  refusal?: string;
}

/**
 * A reason, purpose or note typed into a box (deletion, restoring, reporting, grants, moderation, changes...): trimmed,
 * 1 to 1,000 characters (or the box's own `max`), and refused with the D75 wording when it looks like it holds a
 * credential (only the kind is named, never the match). History spec 7.4: "reason inputs everywhere also run the
 * credential check".
 */
export function readReason(input: unknown, label = 'a reason', rule: ReasonRule = {}): string {
  const max = rule.max ?? MAX_REASON_CHARS;
  const text = typeof input === 'string' ? input.trim() : '';
  if (text === '' || text.length > max) throw new BadRequestException(rule.refusal ?? `Give ${label} (up to ${max.toLocaleString('en-US')} characters).`);
  refuseSecrets(text);
  return text;
}

/** The same for a box that may be left empty: null when nothing (or only spaces) was typed. */
export function readOptionalReason(input: unknown, label = 'a reason', rule: ReasonRule = {}): string | null {
  if (input === undefined || input === null || (typeof input === 'string' && input.trim() === '')) return null;
  return readReason(input, label, rule);
}

/** The credential check over every string in a JSON value a person typed (change terms): refuses with the D75 wording. */
export function refuseSecretsIn(value: unknown): void {
  if (typeof value === 'string') refuseSecrets(value);
  else if (Array.isArray(value)) value.forEach(refuseSecretsIn);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(refuseSecretsIn);
}
