// Request limits for the public sign-in steps (review G03). Counts live in memory, per API process, in one-minute windows
// measured on the application clock. Deploy a matching limit at the reverse proxy as well: it sees traffic before Kainow does.

/** Most requests in one minute: per client address, and for everyone together. */
export interface WindowLimits {
  perAddress: number;
  overall: number;
}

/** Defaults sized well above a working organisation's sign-ins, and well below what fills a disk. */
export interface SignInLimits {
  requestCodePerAddress: number;
  requestCodeOverall: number;
  verifyPerAddress: number;
  verifyOverall: number;
  /** At most this many `auth.code_request_ignored` rows for unknown or disabled addresses per minute; the rest are counted. */
  ignoredAuditPerMinute: number;
}

export const DEFAULT_SIGN_IN_LIMITS: SignInLimits = {
  requestCodePerAddress: 10,
  requestCodeOverall: 120,
  verifyPerAddress: 30,
  verifyOverall: 300,
  ignoredAuditPerMinute: 20,
};

export const TOO_MANY_REQUESTS = 'Too many sign-in requests. Wait a minute and try again.';

/** Beyond this many tracked addresses in one minute, a new address is refused: the overall limit is then being hit anyway. */
const MAX_TRACKED_ADDRESSES = 10_000;

const minuteOf = (now: Date): number => Math.floor(now.getTime() / 60_000);

export type Refusal = 'address' | 'overall' | null;

export class WindowLimiter {
  private window = -1;
  private overall = 0;
  private readonly perAddress = new Map<string, number>();

  constructor(
    private readonly limits: WindowLimits,
    private readonly clock: () => Date,
  ) {}

  /** Counts one request and says whether it is refused. A refused request is not counted. */
  take(address: string): Refusal {
    const w = minuteOf(this.clock());
    if (w !== this.window) {
      this.window = w;
      this.overall = 0;
      this.perAddress.clear();
    }
    if (this.overall >= this.limits.overall) return 'overall';
    const used = this.perAddress.get(address);
    if (used === undefined && this.perAddress.size >= MAX_TRACKED_ADDRESSES) return 'overall';
    if ((used ?? 0) >= this.limits.perAddress) return 'address';
    this.perAddress.set(address, (used ?? 0) + 1);
    this.overall += 1;
    return null;
  }
}

/** Lets the first `perMinute` events of each minute through and counts the rest, reporting that count on the next one let through. */
export class AuditSampler {
  private window = -1;
  private written = 0;
  private suppressed = 0;

  constructor(
    private readonly perMinute: number,
    private readonly clock: () => Date,
  ) {}

  /** null: skip this one. Otherwise write it, adding `suppressed` when earlier ones were skipped. */
  next(): { suppressed?: number } | null {
    const w = minuteOf(this.clock());
    if (w !== this.window) {
      this.window = w;
      this.written = 0;
    }
    if (this.written >= this.perMinute) {
      this.suppressed += 1;
      return null;
    }
    this.written += 1;
    const extra = this.suppressed > 0 ? { suppressed: this.suppressed } : {};
    this.suppressed = 0;
    return extra;
  }
}

/**
 * The client's address. With `trustedHops` > 0 Kainow sits behind that many reverse proxies, each appending to
 * X-Forwarded-For, so the address is the entry that many places from the right. Otherwise the header is ignored:
 * a client could write anything in it.
 */
export function clientAddress(socketAddress: string | undefined, forwardedFor: string | string[] | undefined, trustedHops: number): string {
  const direct = socketAddress ?? 'unknown';
  if (trustedHops <= 0 || forwardedFor === undefined) return direct;
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length === 0) return direct;
  return chain[Math.max(0, chain.length - trustedHops)];
}
