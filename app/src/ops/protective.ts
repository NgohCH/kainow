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

/** Update maintenance (10b, spec 7.1): the same read-only mode, with its own refusal and banner; only the updater ends it. */
export const UPDATE_CODE = 'update_in_progress';
export const UPDATE_MESSAGE = 'Kainow is being updated. Nothing you have saved is affected; try again in a few minutes.';
export const UPDATE_BANNER = 'Kainow is being updated. You can read; changes are paused until the update finishes.';

/** Methods that never change anything, and so are never refused. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The refusal: 503 with `{ code: 'protective_read_only', message }`, or `update_in_progress` while an update runs. */
export function protectiveRefusal(reason?: string | null): ServiceUnavailableException {
  if (reason === 'update') return new ServiceUnavailableException({ code: UPDATE_CODE, message: UPDATE_MESSAGE });
  return new ServiceUnavailableException({ code: PROTECTIVE_CODE, message: PROTECTIVE_MESSAGE });
}

/** Something that can say whether the mode is on: OperationsState, or a stub in tests. */
export interface ProtectiveCheck {
  isProtective(): Promise<boolean>;
}
