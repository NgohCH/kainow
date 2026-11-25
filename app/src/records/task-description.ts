import { BadRequestException } from '@nestjs/common';
import { refuseSecretsIn } from '../common/reason';

export const MAX_TASK_DESCRIPTION = 4_000;
export const DESCRIPTION_TOO_LONG = 'Write a description of up to 4,000 characters.';
export const DESCRIPTION_FOR_ACTIONS = 'Only an action can have a description.';

/**
 * A task's description as a person typed it (D133): trimmed of all white space, null when nothing is left, and refused
 * over the limit or when it looks like it holds a credential.
 */
export function readTaskDescription(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw new BadRequestException(DESCRIPTION_TOO_LONG);
  const text = input.trim();
  if (text === '') return null;
  if (text.length > MAX_TASK_DESCRIPTION) throw new BadRequestException(DESCRIPTION_TOO_LONG);
  refuseSecretsIn(text);
  return text;
}
