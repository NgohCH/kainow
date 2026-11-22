import type { Clock } from './tokens';

/**
 * Counts sign-in activity per network address in fixed windows, in memory (one API process).
 *
 * The per-account limits (one code a minute, a lock after five wrong codes) stop guessing one account. They do not stop
 * one address from guessing a few codes on each of many accounts, or from keeping chosen accounts locked. These limits
 * do: an address that requests too many codes, or enters too many wrong ones, is refused for the rest of the window.
 * Successful sign-ins are not counted as failures, so an office sharing one address is only held back by its requests.
 */
export interface AddressLimits {
  windowMinutes: number;
  /** Codes one address may request in a window. */
  maxCodeRequests: number;
  /** Wrong or expired codes one address may enter in a window. */
  maxFailedCodes: number;
}

type Kind = 'request' | 'failure';

interface Window {
  startedAt: number;
  request: number;
  failure: number;
}

/** Above this many tracked addresses, finished windows are swept, so memory stays bounded under a spread-out attack. */
const SWEEP_AT = 10_000;

export class AddressLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limits: AddressLimits,
    private readonly clock: Clock,
  ) {}

  private current(address: string): Window {
    const now = this.clock().getTime();
    const span = this.limits.windowMinutes * 60_000;
    let w = this.windows.get(address);
    if (!w || now - w.startedAt >= span) {
      if (this.windows.size >= SWEEP_AT) this.sweep(now, span);
      w = { startedAt: now, request: 0, failure: 0 };
      this.windows.set(address, w);
    }
    return w;
  }

  private sweep(now: number, span: number): void {
    for (const [key, w] of this.windows) if (now - w.startedAt >= span) this.windows.delete(key);
    // Still full: every entry is live, so drop the oldest rather than grow without limit.
    if (this.windows.size >= SWEEP_AT) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
  }

  private max(kind: Kind): number {
    return kind === 'request' ? this.limits.maxCodeRequests : this.limits.maxFailedCodes;
  }

  /** True when the address has already used up this kind of attempt in the current window. */
  blocked(address: string, kind: Kind): boolean {
    return this.current(address)[kind] >= this.max(kind);
  }

  /** Counts one attempt; true when this attempt is still within the limit. */
  take(address: string, kind: Kind): boolean {
    const w = this.current(address);
    if (w[kind] >= this.max(kind)) return false;
    w[kind] += 1;
    return true;
  }
}

export const ADDRESS_LIMITER = Symbol('ADDRESS_LIMITER');
