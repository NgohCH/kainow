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

/**
 * Memory bound: beyond this many tracked addresses in one minute, further new addresses share one bucket instead of being
 * refused outright (second review, M1c), so filling the table cannot by itself shut out new callers.
 */
const MAX_TRACKED_ADDRESSES = 10_000;
const OVERFLOW_BUCKET = 'overflow';

/**
 * The unit an address is limited by (second review, M1c). One IPv6 subscriber usually holds a whole /64, so each
 * address in it would otherwise get its own limit: IPv6 is counted per /64. IPv4 (also written as ::ffff:a.b.c.d) is
 * counted per address. Anything unparseable is counted as given.
 */
export function limitKey(address: string): string {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (!a.includes(':')) return a;
  const halves = a.split('::');
  if (halves.length > 2) return a;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (tail.some((g) => g.includes('.'))) tail.splice(-1, 1, '0', '0'); // an embedded IPv4 tail is two groups, outside the /64 anyway
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

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

  /**
   * Counts one request and says whether it is refused. A refused request is not counted. The overall limit is a circuit
   * breaker for the whole process: a matching per-address limit at the reverse proxy keeps one caller from using it up.
   */
  take(address: string): Refusal {
    const w = minuteOf(this.clock());
    if (w !== this.window) {
      this.window = w;
      this.overall = 0;
      this.perAddress.clear();
    }
    if (this.overall >= this.limits.overall) return 'overall';
    let key = limitKey(address);
    if (!this.perAddress.has(key) && this.perAddress.size >= MAX_TRACKED_ADDRESSES) key = OVERFLOW_BUCKET;
    const used = this.perAddress.get(key);
    // The shared overflow bucket gets the room of many addresses: it is only reached under a flood the overall limit caps.
    const limit = key === OVERFLOW_BUCKET ? this.limits.perAddress * 10 : this.limits.perAddress;
    if ((used ?? 0) >= limit) return 'address';
    this.perAddress.set(key, (used ?? 0) + 1);
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
