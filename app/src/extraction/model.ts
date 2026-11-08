import type { Usage } from '../spend/cost';
import { isCalendarDate } from './due';

export const ITEM_KINDS = ['decision', 'action', 'question', 'risk'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface RawItem {
  kind: ItemKind;
  text: string;
  owner: string | null;
  due: string | null;
  due_event: string | null;
  alternatives: string[];
  source_quote: string;
}

/** The model's answer: the meeting date the notes state (or null) and the proposed items. */
export interface ModelAnswer {
  meetingDate: string | null;
  items: RawItem[];
}

export interface ModelRequest {
  modelId: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ModelResult extends ModelAnswer {
  usage: Usage;
}

/**
 * The request failed. `outcome` says what is known about the charge:
 *   rejected  the provider answered with an error before doing any work (a 4xx response), so no charge
 *   unknown   a timeout, a lost connection or a server error: the provider may have done the work
 * `retryable` says whether trying again can help.
 */
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly outcome: 'rejected' | 'unknown',
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The provider did the work and reported usage, but the answer could not be used. The usage is still charged. */
export class ModelBadResponse extends Error {
  constructor(message: string, readonly usage: Usage) {
    super(message);
  }
}

/** Anything that can run an extraction. The real one calls OpenAI; tests use a fake. */
export interface ModelClient {
  extract(request: ModelRequest): Promise<ModelResult>;
}

const SCHEMA = {
  name: 'meeting_items',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['meeting_date', 'items'],
    properties: {
      meeting_date: { type: ['string', 'null'] },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'text', 'owner', 'due', 'due_event', 'alternatives', 'source_quote'],
          properties: {
            kind: { type: 'string', enum: [...ITEM_KINDS] },
            text: { type: 'string' },
            owner: { type: ['string', 'null'] },
            due: { type: ['string', 'null'] },
            due_event: { type: ['string', 'null'] },
            alternatives: { type: 'array', items: { type: 'string' } },
            source_quote: { type: 'string' },
          },
        },
      },
    },
  },
};

export const MAX_ITEMS = 200;
export const MAX_ALTERNATIVES = 4;

/**
 * Checks the model's JSON. Anything off is a bad response; nothing is repaired or guessed. A meeting date
 * that is not a real day is dropped (null), not refused. The newer fields may be absent from an answer
 * (read as null or an empty list), but a wrong type is a bad response.
 */
export function parseAnswer(content: unknown, usage: Usage): ModelAnswer {
  let data: unknown;
  try {
    data = JSON.parse(String(content));
  } catch {
    throw new ModelBadResponse('The answer was not valid JSON', usage);
  }
  const list = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(list) || list.length > MAX_ITEMS) {
    throw new ModelBadResponse('The answer did not contain a usable list of items', usage);
  }
  const optional = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' ? v : undefined);
  const meetingDate = (data as { meeting_date?: unknown }).meeting_date;
  const items = list.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const owner = optional(o.owner);
    const due = optional(o.due);
    const dueEvent = o.due_event === undefined ? null : optional(o.due_event);
    const alternatives = o.alternatives === undefined ? [] : o.alternatives;
    if (
      !(ITEM_KINDS as readonly unknown[]).includes(o.kind) ||
      typeof o.text !== 'string' ||
      o.text.trim() === '' ||
      typeof o.source_quote !== 'string' ||
      o.source_quote === '' ||
      owner === undefined ||
      due === undefined ||
      dueEvent === undefined ||
      !Array.isArray(alternatives) ||
      !alternatives.every((a) => typeof a === 'string')
    ) {
      throw new ModelBadResponse(`Item ${i + 1} in the answer was malformed`, usage);
    }
    const kind = o.kind as ItemKind;
    const answers =
      kind === 'question' ? (alternatives as string[]).map((a) => a.trim()).filter((a) => a !== '').slice(0, MAX_ALTERNATIVES) : [];
    return { kind, text: o.text, owner, due, due_event: dueEvent, alternatives: answers, source_quote: o.source_quote };
  });
  return { meetingDate: isCalendarDate(meetingDate) ? meetingDate : null, items };
}

/** Calls the OpenAI chat completions API with a strict JSON schema. Needs a key; the sandbox cannot reach it. */
export class OpenAiModelClient implements ModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.openai.com/v1',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async extract(req: ModelRequest): Promise<ModelResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(req.timeoutMs),
        body: JSON.stringify({
          model: req.modelId,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_completion_tokens: req.maxOutputTokens,
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
    } catch (err) {
      // The request may have reached the provider before the connection or the timer gave up.
      const why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'connection failed';
      throw new ModelCallError(`The AI request ${why}`, 'unknown', true);
    }

    if (!res.ok) {
      // Error bodies can echo input, so only the status goes into our messages.
      await res.body?.cancel().catch(() => undefined);
      const status = res.status;
      if (status >= 500) throw new ModelCallError(`The AI service answered ${status}`, 'unknown', true, status);
      if (status === 429) throw new ModelCallError('The AI service asked us to slow down (429)', 'rejected', true, status);
      throw new ModelCallError(`The AI service refused the request (${status})`, 'rejected', false, status);
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new ModelCallError('The AI answer could not be read', 'unknown', true, res.status);
    }
    const u = body?.usage;
    const input = Number(u?.prompt_tokens);
    const output = Number(u?.completion_tokens);
    const cached = Number(u?.prompt_tokens_details?.cached_tokens ?? 0);
    if (![input, output, cached].every((n) => Number.isInteger(n) && n >= 0) || cached > input) {
      // Without reported usage the real cost is unknown, so the estimate stays counted.
      throw new ModelCallError('The AI answer did not report usage', 'unknown', true, res.status);
    }
    const usage: Usage = { inputTokens: input, cachedInputTokens: cached, outputTokens: output };
    const choice = body?.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new ModelBadResponse('The answer was cut off at the output limit', usage);
    }
    if (choice?.message?.refusal) {
      throw new ModelBadResponse('The model declined to answer', usage);
    }
    return { ...parseAnswer(choice?.message?.content, usage), usage };
  }
}
