/**
 * Protective read-only mode in the API and the worker (spec 7.3, D114).
 *
 * API: AuthGuard refuses every request whose method is not GET, HEAD or OPTIONS while the mode is on, unless the
 * handler (or its class) carries `@AllowedWhenProtective()`. The check comes before the `@Public` early return, so
 * public routes are covered too.
 *
 * Worker: each queue handler and scheduled tick asks `isProtective()` first (see worker/schedules.ts and
 * worker/ai-worker.ts). Paused: AI, analysis, quarantine cleaning, the sweep (except its ops part). Running: email.
 */
import { ServiceUnavailableException } from '@nestjs/common';

export const PROTECTIVE_CODE = 'protective_read_only';
export const PROTECTIVE_MESSAGE = 'Kainow is read-only for now to protect your data. Nothing you have saved is affected.';
/** The banner for everyone while the mode is on (spec 7.3, "Everyone else"); shown by the web (Task 12). */
export const PROTECTIVE_BANNER = 'Kainow is read-only for now to protect your data. You can read everything; changes are paused.';

/** Methods that never change anything, and so are never refused. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The refusal: 503 with `{ code: 'protective_read_only', message }`. */
export function protectiveRefusal(): ServiceUnavailableException {
  return new ServiceUnavailableException({ code: PROTECTIVE_CODE, message: PROTECTIVE_MESSAGE });
}

/** Something that can say whether the mode is on: OperationsState, or a stub in tests. */
export interface ProtectiveCheck {
  isProtective(): Promise<boolean>;
}
