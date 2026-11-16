import { BadRequestException } from '@nestjs/common';
import { refuseSecrets } from '../discussion/messages';

export const MAX_REASON_CHARS = 1_000;

/**
 * A reason, purpose or note typed into a box (deletion, restoring, reporting, grants): trimmed, 1 to 1,000 characters,
 * and refused with the D75 wording when it looks like it holds a credential (only the kind is named).
 */
export function readReason(input: unknown, label = 'a reason'): string {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text === '' || text.length > MAX_REASON_CHARS) throw new BadRequestException(`Give ${label} (up to 1,000 characters).`);
  refuseSecrets(text);
  return text;
}
