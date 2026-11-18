import { OpenAiModelClient } from '../extraction/model';
import type { ProtectedKey, Sealed } from '../quarantine/protected-key';
import { AnthropicModelClient, type ProviderClient } from './anthropic-model';
import { type KeyBinding, openApiKey, type Provider } from './keys';
import { OPENAI_BASE } from './provider-clients';

export type { ProviderClient } from './anthropic-model';

/** Builds the client for one attempt. Tests inject a fake factory. */
export interface ModelClientFactory {
  forAttempt(c: { provider: Provider; apiKey: string; timeoutMs: number }): ProviderClient;
}

export const realClientFactory: ModelClientFactory = {
  forAttempt({ provider, apiKey, timeoutMs }) {
    return provider === 'anthropic' ? new AnthropicModelClient(apiKey, timeoutMs) : new OpenAiModelClient(apiKey, `${OPENAI_BASE}/v1`);
  },
};

/**
 * Opens the sealed key and returns the client for this attempt. The decrypted key is a local variable only:
 * it is never stored on an object that outlives the call (the client holds it for the attempt). Throws KeyUnreadableError.
 */
export function clientForAttempt(
  protectedKey: ProtectedKey,
  sealed: Sealed & { keyId: string },
  binding: KeyBinding,
  factory: ModelClientFactory,
  timeoutMs: number,
): ProviderClient {
  const apiKey = openApiKey(protectedKey, sealed, binding);
  return factory.forAttempt({ provider: binding.provider, apiKey, timeoutMs });
}
