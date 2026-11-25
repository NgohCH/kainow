import { useEffect } from 'react';
import { leaveGuard } from './leaveGuard.ts';

export const UNSAVED = 'What you typed on this page has not been saved and will be lost. Leave the page?';

/** Warns before this page is left while it holds unsaved input. */
export function useLeaveGuard(unsaved: boolean, message: string = UNSAVED): void {
  useEffect(() => (unsaved ? leaveGuard.arm(message) : undefined), [unsaved, message]);
}
