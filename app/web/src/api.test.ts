import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, NOTICE_HEADER, RESTART_MESSAGE, RESTART_RETRY_MS, api, isRestarting, onRestarting, resetRestartForTests, setRestartEnv } from './api.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetRestartForTests();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** /health as the restart watch sees it: down (network error), Kainow ok, a proxy's error page, the notice page. */
type Health = 'down' | 'ok' | 'proxy502' | 'proxy504' | 'notice';

/** A scripted restart: timers run when the test says, /health answers as the test says. */
function restartEnv(healthAnswers: Health[]) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const env = {
    timers,
    healthCalls: [] as string[],
    reloaded: 0,
    fetch: async (url: string) => {
      env.healthCalls.push(url);
      const a = healthAnswers.shift() ?? 'down';
      if (a === 'down') throw new TypeError('Failed to fetch');
      const headers = new Headers(a === 'notice' ? { [NOTICE_HEADER]: '1' } : {});
      return { ok: a === 'ok', headers };
    },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
    },
    reload: () => {
      env.reloaded++;
    },
  };
  return env;
}

async function runNextTimer(env: ReturnType<typeof restartEnv>) {
  const next = env.timers.shift();
  assert.ok(next, 'a retry is scheduled');
  next.fn();
  await new Promise((r) => setTimeout(r, 0));
}

test('a network failure while the last banner was update maintenance shows the restart message and retries every 15 s', async () => {
  assert.equal(RESTART_MESSAGE, 'Kainow is restarting after an update…');
  const env = restartEnv(['down', 'proxy502', 'proxy504', 'notice']);
  setRestartEnv(env);
  const seen: boolean[] = [];
  onRestarting((on) => seen.push(on));

  globalThis.fetch = (async () => json({ protective: true, reason: 'update', text: 'Kainow is being updated.' })) as typeof fetch;
  await api.get('/operations/banner');

  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  await assert.rejects(api.get('/projects'), (e: unknown) => e instanceof ApiError && e.message === RESTART_MESSAGE && e.code === 'restarting');
  assert.equal(isRestarting(), true);
  assert.deepEqual(seen, [true]);

  // Every 15 seconds /health is asked. A network error or a proxy's 502/504 page keeps waiting (final review #38); the
  // notice page (503 with its mark, for ever after a failed update) reloads, so people see the notice.
  assert.deepEqual(env.timers.map((x) => x.ms), [RESTART_RETRY_MS]);
  assert.equal(RESTART_RETRY_MS, 15_000);
  await runNextTimer(env); // down
  assert.deepEqual(env.timers.map((x) => x.ms), [15_000]);
  await runNextTimer(env); // a proxy's 502
  await runNextTimer(env); // a proxy's 504
  assert.equal(env.reloaded, 0);
  assert.equal(isRestarting(), true);
  await runNextTimer(env); // the notice page
  assert.equal(env.reloaded, 1);
  assert.deepEqual(env.healthCalls, ['/health', '/health', '/health', '/health']);
  assert.equal(env.timers.length, 0, 'no more retries after the reload');

  // A second failure while restarting starts no second watch.
  await assert.rejects(api.get('/projects'));
});

test('behind a proxy: a 502 page while update maintenance was on starts the watch, which reloads when /health is ok', async () => {
  const env = restartEnv(['proxy502', 'ok']);
  setRestartEnv(env);
  globalThis.fetch = (async () => json({ protective: true, reason: 'update' })) as typeof fetch;
  await api.get('/operations/banner');
  globalThis.fetch = (async () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
  await assert.rejects(api.get('/projects'), (e: unknown) => e instanceof ApiError && e.message === RESTART_MESSAGE && e.code === 'restarting');
  assert.equal(isRestarting(), true);
  await runNextTimer(env); // the proxy still answers 502
  assert.equal(env.reloaded, 0);
  await runNextTimer(env); // Kainow is back
  assert.equal(env.reloaded, 1);
});

test('without update maintenance a proxy 502 is an ordinary error; the notice page always starts the watch', async () => {
  const env = restartEnv([]);
  setRestartEnv(env);
  globalThis.fetch = (async () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
  await assert.rejects(api.get('/projects'), (e: unknown) => e instanceof ApiError && e.status === 502);
  assert.equal(isRestarting(), false);
  globalThis.fetch = (async () => new Response('<html>notice</html>', { status: 503, headers: { 'Content-Type': 'text/html', [NOTICE_HEADER]: '1' } })) as typeof fetch;
  await assert.rejects(api.get('/projects'), (e: unknown) => e instanceof ApiError && e.message === RESTART_MESSAGE);
  assert.equal(isRestarting(), true);
});

test('an update refusal (503 update_in_progress) also counts as update maintenance', async () => {
  const env = restartEnv([]);
  setRestartEnv(env);
  globalThis.fetch = (async () =>
    json({ code: 'update_in_progress', message: 'Kainow is being updated. Nothing you have saved is affected; try again in a few minutes.' }, 503)) as typeof fetch;
  await assert.rejects(api.post('/projects', {}), (e: unknown) => e instanceof ApiError && e.code === 'update_in_progress');
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  await assert.rejects(api.get('/projects'), (e: unknown) => e instanceof ApiError && e.message === RESTART_MESSAGE);
  assert.equal(env.timers.length, 1);
});

test('without update maintenance a network failure is the usual message and nothing retries', async () => {
  const env = restartEnv([]);
  setRestartEnv(env);
  globalThis.fetch = (async () => json({ protective: true })) as typeof fetch;
  await api.get('/operations/banner'); // low-space protection, not an update
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  await assert.rejects(api.get('/projects'), (e: unknown) => e instanceof ApiError && e.message.startsWith('Cannot reach the Kainow server'));
  assert.equal(isRestarting(), false);
  assert.equal(env.timers.length, 0);

  // Update maintenance that has ended is forgotten.
  globalThis.fetch = (async () => json({ protective: true, reason: 'update' })) as typeof fetch;
  await api.get('/operations/banner');
  globalThis.fetch = (async () => json({ protective: false })) as typeof fetch;
  await api.get('/operations/banner');
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  await assert.rejects(api.get('/projects'), (e: unknown) => e instanceof ApiError && e.message.startsWith('Cannot reach'));
});
