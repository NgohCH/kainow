import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, RESTART_MESSAGE, RESTART_RETRY_MS, api, isRestarting, onRestarting, resetRestartForTests, setRestartEnv } from './api.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetRestartForTests();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A scripted restart: timers run when the test says, /health answers as the test says. */
function restartEnv(healthAnswers: Array<boolean | 'down'>) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const env = {
    timers,
    healthCalls: [] as string[],
    reloaded: 0,
    fetch: async (url: string) => {
      env.healthCalls.push(url);
      const a = healthAnswers.shift() ?? 'down';
      if (a === 'down') throw new TypeError('Failed to fetch');
      return { ok: a };
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
  const env = restartEnv(['down', 'down', false]);
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

  // Every 15 seconds /health is asked; the page reloads once it answers at all. A 503 answer (the notice page after a
  // failed update answers 503 for ever) reloads too, so people see the notice; only a network error retries.
  assert.deepEqual(env.timers.map((x) => x.ms), [RESTART_RETRY_MS]);
  assert.equal(RESTART_RETRY_MS, 15_000);
  await runNextTimer(env); // down
  assert.deepEqual(env.timers.map((x) => x.ms), [15_000]);
  await runNextTimer(env); // down
  assert.equal(env.reloaded, 0);
  await runNextTimer(env); // answers 503
  assert.equal(env.reloaded, 1);
  assert.deepEqual(env.healthCalls, ['/health', '/health', '/health']);
  assert.equal(env.timers.length, 0, 'no more retries after the reload');

  // A second failure while restarting starts no second watch.
  await assert.rejects(api.get('/projects'));
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
