import { createServer, type Server } from 'node:http';
import type { ModelClientFactory } from '../ai/client-factory';
import { OpenAiModelClient } from '../extraction/model';

/**
 * The load test's AI (10b spec 13.1 step 1): no real provider is ever called and nothing is charged.
 *
 * Route chosen: the provider hosts are fixed in code (ai/provider-clients.ts, P19/C38), so an approved model's connection
 * cannot be pointed at another base URL. Instead the worker registers a load-test-only client factory, and only when
 * KAINOW_LOAD_TEST=1 and KAINOW_LOAD_TEST_AI_URL names a loopback address: every attempt then goes, through the real
 * OpenAI-compatible client, to the fake server below. Everything before the call (connection choice, the sealed key,
 * spend reservation, the AI places) is the real code.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** The load-test factory when the installation asks for it; null otherwise. Throws when asked for with an unusable URL. */
export function loadTestClientFactory(env: Record<string, string | undefined>): ModelClientFactory | null {
  if (env.KAINOW_LOAD_TEST !== '1') return null;
  const raw = env.KAINOW_LOAD_TEST_AI_URL ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('KAINOW_LOAD_TEST=1 needs KAINOW_LOAD_TEST_AI_URL, the local fake AI provider (http://127.0.0.1:<port>/v1).');
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) {
    throw new Error('KAINOW_LOAD_TEST_AI_URL must be a loopback http address: the load test never sends anything off this machine.');
  }
  const base = raw.replace(/\/+$/, '');
  return {
    forAttempt({ apiKey }) {
      return new OpenAiModelClient(apiKey, base);
    },
  };
}

export interface FakeCall {
  /** The marker the load test wrote into the note (LT-…), or null. */
  marker: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface FakeAi {
  url: string;
  calls: FakeCall[];
  maxInFlight(): number;
  close(): Promise<void>;
}

/** The extraction answer: one item of each kind, quoting a sentence every load-test note contains. */
function answer(): string {
  const quote = 'Present: the Project Manager, the Owner and three Members.';
  const item = (kind: string, text: string) => ({ kind, text, owner: null, due: null, due_event: null, alternatives: [], source_quote: quote });
  return JSON.stringify({
    meeting_date: null,
    items: [item('decision', 'Review the figures before the next meeting'), item('action', 'Prepare the report'), item('risk', 'The supplier may be late'), item('question', 'Who signs off the plan?')],
  });
}

/** An OpenAI-compatible chat-completions server on loopback that answers after a delay of 3-8 s (by default). */
export async function startFakeAi(opts: { port: number; minMs?: number; maxMs?: number; random?: () => number }): Promise<FakeAi> {
  const minMs = opts.minMs ?? 3000;
  const maxMs = opts.maxMs ?? 8000;
  const random = opts.random ?? Math.random;
  const calls: FakeCall[] = [];
  let inFlight = 0;
  let most = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const call: FakeCall = { marker: text.match(/LT-[0-9a-f-]{36}/)?.[0] ?? null, startedAt: Date.now(), endedAt: null };
      calls.push(call);
      inFlight++;
      most = Math.max(most, inFlight);
      setTimeout(() => {
        inFlight--;
        call.endedAt = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            id: 'fake',
            object: 'chat.completion',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer() } }],
            usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 0 } },
          }),
        );
      }, minMs + random() * (maxMs - minMs));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    maxInFlight: () => most,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * For each request (asked at `requestedAt`, first reaching the provider at `reachedAt`): how long it waited while fewer
 * than `slots` calls were open. Only the start of a free place's idle time is counted, so polling delay shows up here.
 */
export function idleSlotWaitMs(requestedAt: number, reachedAt: number, calls: { startedAt: number; endedAt: number | null }[], slots: number): number {
  if (reachedAt <= requestedAt) return 0;
  const edges = new Set<number>([requestedAt, reachedAt]);
  for (const c of calls) {
    if (c.startedAt > requestedAt && c.startedAt < reachedAt) edges.add(c.startedAt);
    const end = c.endedAt ?? Number.POSITIVE_INFINITY;
    if (end > requestedAt && end < reachedAt) edges.add(end);
  }
  const points = [...edges].sort((a, b) => a - b);
  let idle = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const mid = (points[i] + points[i + 1]) / 2;
    const open = calls.filter((c) => c.startedAt <= mid && (c.endedAt ?? Number.POSITIVE_INFINITY) > mid).length;
    if (open < slots) idle += points[i + 1] - points[i];
  }
  return idle;
}
