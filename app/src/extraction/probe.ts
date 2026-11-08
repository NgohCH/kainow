import { ModelCallError, type ModelClient } from './model';
import { EXTRACTION_SYSTEM_PROMPT } from './prompt';

const SAMPLE = 'Sam will send the revised budget to Priya by Friday.';

const HINTS: Record<number, string> = {
  400: 'the request was malformed: check the model name and the request fields (max_completion_tokens, response_format)',
  401: 'the key was not accepted: check OPENAI_API_KEY',
  403: 'the key has no access to this model or project',
  404: 'the model name was not found: check the model id',
  429: 'rate limit or quota reached',
};

/** Sends one small request through the app's own adapter and says what came back. Needs no database. */
export async function runProbe(client: ModelClient, modelId: string): Promise<{ ok: boolean; report: string }> {
  try {
    const { items, usage } = await client.extract({
      modelId,
      system: EXTRACTION_SYSTEM_PROMPT,
      user: SAMPLE,
      maxOutputTokens: 1000,
      timeoutMs: 60_000,
    });
    return {
      ok: true,
      report: `OK: the adapter works. ${items.length} item(s) came back. Usage: ${usage.inputTokens} input, ${usage.cachedInputTokens} cached input, ${usage.outputTokens} output tokens.`,
    };
  } catch (err) {
    if (err instanceof ModelCallError) {
      const hint = (err.status && HINTS[err.status]) || '';
      return { ok: false, report: `FAILED: ${err.message}${err.status ? ` (status ${err.status})` : ''}.${hint ? ` ${hint}.` : ''}` };
    }
    throw err;
  }
}
