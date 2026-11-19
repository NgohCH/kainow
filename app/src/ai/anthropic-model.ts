import Anthropic from '@anthropic-ai/sdk';
import { MINUTES_SCHEMA, type MinutesAnswer, parseMinutes } from '../analysis/minutes';
import {
  ModelBadResponse,
  ModelCallError,
  type MinutesModel,
  type ModelClient,
  type ModelRequest,
  type ModelResult,
  type JsonSchemaModel,
  EXTRACTION_SCHEMA,
  parseAnswer,
} from '../extraction/model';
import type { Usage } from '../spend/cost';
import { anthropicSdk } from './provider-clients';

export interface ProviderClient extends ModelClient, MinutesModel, JsonSchemaModel {}

/** The OpenAI-style wrapper ({name, strict, schema}) is unwrapped: Anthropic takes the bare JSON schema. */
function bareSchema(schema: object): Record<string, unknown> {
  const s = schema as { name?: unknown; schema?: unknown };
  return (typeof s.name === 'string' && s.schema && typeof s.schema === 'object' ? s.schema : schema) as Record<string, unknown>;
}

const count = (v: unknown): number | null => (v === undefined || v === null ? 0 : Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);

/** Calls the Anthropic Messages API through the official SDK. One attempt per call: the SDK never retries. */
export class AnthropicModelClient implements ProviderClient {
  private readonly sdk: Pick<Anthropic, 'messages'>;

  constructor(apiKey: string, private readonly timeoutMs: number, sdk?: Pick<Anthropic, 'messages'>) {
    this.sdk = sdk ?? anthropicSdk(apiKey, timeoutMs);
  }

  async extract(req: ModelRequest): Promise<ModelResult> {
    const { content, usage } = await this.callJson(req, EXTRACTION_SCHEMA);
    return { ...parseAnswer(content, usage), usage };
  }

  async draftMinutes(req: ModelRequest): Promise<MinutesAnswer & { usage: Usage }> {
    const { content, usage } = await this.callJson(req, MINUTES_SCHEMA);
    return { ...parseMinutes(content, usage), usage };
  }

  async callJson(req: ModelRequest, schema: object): Promise<{ content: unknown; usage: Usage }> {
    let res: Anthropic.Message;
    try {
      res = await this.sdk.messages.create(
        {
          model: req.modelId,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          max_tokens: req.maxOutputTokens,
          output_config: { format: { type: 'json_schema', schema: bareSchema(schema) } },
        },
        { maxRetries: 0, timeout: req.timeoutMs ?? this.timeoutMs },
      );
    } catch (err) {
      throw mapError(err);
    }

    const u = res?.usage as unknown as Record<string, unknown> | undefined;
    const input = count(u?.input_tokens);
    const output = count(u?.output_tokens);
    const read = count(u?.cache_read_input_tokens);
    const write = count(u?.cache_creation_input_tokens);
    if (!u || input === null || output === null || read === null || write === null || u.input_tokens === undefined || u.output_tokens === undefined) {
      // Without reported usage the real cost is unknown, so the estimate stays counted.
      throw new ModelCallError('The AI answer did not report usage', 'unknown', true);
    }
    const usage: Usage = { inputTokens: input + read + write, cachedInputTokens: read, cacheWriteTokens: write, outputTokens: output };
    if (res.stop_reason === 'max_tokens') throw new ModelBadResponse('The answer was cut off at the output limit', usage);
    if (res.stop_reason === 'refusal') throw new ModelBadResponse('The model declined to answer', usage);
    const block = res.content?.find((b) => b.type === 'text');
    return { content: block && block.type === 'text' ? block.text : undefined, usage };
  }
}

/** Only the status goes into messages: error bodies can echo input. */
function mapError(err: unknown): ModelCallError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ModelCallError('The AI request timed out', 'unknown', true);
  if (err instanceof Anthropic.APIConnectionError) return new ModelCallError('The AI request connection failed', 'unknown', true);
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    const status = err.status;
    if (status >= 500) return new ModelCallError(`The AI service answered ${status}`, 'unknown', true, status);
    if (status === 429) return new ModelCallError('The AI service asked us to slow down (429)', 'rejected', true, status);
    return new ModelCallError(`The AI service refused the request (${status})`, 'rejected', false, status);
  }
  // Anything else leaves the outcome unknown; the SDK's own text is not passed on.
  return new ModelCallError('The AI request failed', 'unknown', true);
}
