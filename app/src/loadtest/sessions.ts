/**
 * Signing virtual people in through the real request-code / verify flow (10b spec 13.1 step 2). The test installation runs
 * with LOG_SIGN_IN_CODES=true, so each code appears in the API's log; the load test reads it from the log file the API
 * writes to. Each person signs in once, so the 60-second resend gap never applies.
 */

export interface Reply {
  status: number;
  body: any;
  ms: number;
}

export interface Session {
  email: string;
  userId: string;
  role: string;
  request(method: string, path: string, body?: unknown): Promise<Reply>;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The latest code the log shows for this address, or null. */
export function codeFromLog(log: string, email: string): string | null {
  const re = new RegExp(`\\[sign-in code, development only\\] ${escape(email)}: (\\d{6})`, 'g');
  let last: string | null = null;
  for (const m of log.matchAll(re)) last = m[1];
  return last;
}

/** Requests over keep-alive connections; a network failure is status 0. */
export function sessionFor(base: string, cookie: string, csrf: string, who: { email: string; userId: string; role: string }): Session {
  return {
    ...who,
    async request(method, path, body) {
      const started = performance.now();
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        const ms = performance.now() - started;
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
        return { status: res.status, body: parsed, ms };
      } catch {
        return { status: 0, body: undefined, ms: performance.now() - started };
      }
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Signs one person in. `readLog` returns the API log so far; the code written after the request is used (a code from an
 * earlier sign-in in the same log is ignored).
 */
export async function signIn(base: string, email: string, readLog: () => string, timeoutMs = 15_000, resendGapMs = 61_000): Promise<Session> {
  const count = () => (readLog().match(new RegExp(`\] ${escape(email)}: `, 'g')) ?? []).length;
  const waitForCode = async (seen: number): Promise<string | null> => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      // A new log line for this address, whatever its digits.
      if (count() > seen) return codeFromLog(readLog(), email);
      await sleep(100);
    }
    return null;
  };
  const request = async () => {
    const req = await fetch(`${base}/auth/request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (req.status !== 202) throw new Error(`request-code for ${email} answered ${req.status}`);
  };
  let seen = count();
  await request();
  let code = await waitForCode(seen);
  if (!code) {
    // A code asked for in the last minute (the seed signs the same people in) silences the next one: ask once more after the gap.
    await sleep(resendGapMs);
    seen = count();
    await request();
    code = await waitForCode(seen);
  }
  if (!code) throw new Error(`No sign-in code for ${email} appeared in the API log (is LOG_SIGN_IN_CODES=true?)`);
  const res = await fetch(`${base}/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }) });
  if (res.status !== 200) throw new Error(`Sign-in failed for ${email}: ${res.status}`);
  const cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0];
  const { csrfToken, user } = (await res.json()) as { csrfToken: string; user: { id: string; role: string } };
  return sessionFor(base, cookie, csrfToken, { email, userId: user.id, role: user.role });
}
