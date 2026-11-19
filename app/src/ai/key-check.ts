import Anthropic from '@anthropic-ai/sdk';
import type { ProtectedKey, Sealed } from '../quarantine/protected-key';
import { type KeyBinding, KeyUnreadableError, type Provider, openApiKey } from './keys';
import { ANTHROPIC_BASE, OPENAI_BASE, anthropicSdk } from './provider-clients';

export type KeyCheck = { outcome: 'ok' } | { outcome: 'refused'; status: 401 | 403 } | { outcome: 'no_model' } | { outcome: 'unreachable' };

export { ANTHROPIC_BASE, OPENAI_BASE };
export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/** The one SDK call the check makes; tests pass a fake. */
export type ModelLister = Pick<Anthropic, 'models'>;

/**
 * Asks the provider about one model with this key. It is free: nothing is reserved or counted. Only the status is read, never a body.
 * 401 and 403: refused. 404: the key cannot use the model. Timeout, a lost connection, 5xx and any other answer: unreachable
 * (nothing is known about the key).
 */
export async function checkKey(
  provider: Provider,
  apiKey: string,
  modelId: string,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
  sdk?: ModelLister,
): Promise<KeyCheck> {
  try {
    const status = provider === 'anthropic' ? await anthropicStatus(apiKey, modelId, timeoutMs, sdk) : await openAiStatus(apiKey, modelId, timeoutMs, fetchImpl);
    return fromStatus(status);
  } catch {
    return { outcome: 'unreachable' };
  }
}

function fromStatus(status: number): KeyCheck {
  if (status >= 200 && status < 300) return { outcome: 'ok' };
  if (status === 401 || status === 403) return { outcome: 'refused', status };
  if (status === 404) return { outcome: 'no_model' };
  return { outcome: 'unreachable' };
}

async function openAiStatus(apiKey: string, modelId: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<number> {
  const res = await fetchImpl(`${OPENAI_BASE}/v1/models/${encodeURIComponent(modelId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.body?.cancel().catch(() => undefined);
  return res.status;
}

async function anthropicStatus(apiKey: string, modelId: string, timeoutMs: number, sdk?: ModelLister): Promise<number> {
  // Built with every option explicit, so nothing comes from the environment (P19); the SDK never retries.
  const client = sdk ?? anthropicSdk(apiKey, timeoutMs);
  try {
    await client.models.retrieve(modelId, undefined, { maxRetries: 0, timeout: timeoutMs });
    return 200;
  } catch (err) {
    if (err instanceof Anthropic.APIError && typeof err.status === 'number') return err.status;
    throw err;
  }
}

/** The sealed key row as stored (current row only). */
export type SealedRow = Sealed & { keyId: string };

/** Opens the stored key for a check and runs it. Throws KeyUnreadableError. The key stays in this call. */
export async function checkStoredKey(
  protectedKey: ProtectedKey,
  sealed: SealedRow,
  binding: KeyBinding,
  modelId: string,
  check: (provider: Provider, apiKey: string, modelId: string) => Promise<KeyCheck> = (p, k, m) => checkKey(p, k, m),
): Promise<KeyCheck> {
  const apiKey = openApiKey(protectedKey, sealed, binding);
  return check(binding.provider, apiKey, modelId);
}

/** True when the stored key opens under this protected key and this binding. Nothing is returned from the opened text. */
export function keyReadable(protectedKey: ProtectedKey, sealed: SealedRow, binding: KeyBinding): boolean {
  try {
    openApiKey(protectedKey, sealed, binding);
    return true;
  } catch (err) {
    if (err instanceof KeyUnreadableError) return false;
    throw err;
  }
}
