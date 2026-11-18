import Anthropic from '@anthropic-ai/sdk';

/** The provider hosts, fixed in code: a project's key is only ever sent here (P19, C38). */
export const OPENAI_BASE = 'https://api.openai.com';
export const ANTHROPIC_BASE = 'https://api.anthropic.com';

/**
 * The one place an Anthropic SDK client is built. Every option the SDK would otherwise take from the environment is
 * given here, so ANTHROPIC_BASE_URL cannot redirect a key, ANTHROPIC_LOG cannot log a request body, ANTHROPIC_AUTH_TOKEN
 * cannot stand beside the key, and ANTHROPIC_OPEN_TELEMETRY* cannot trace content (final review I2). The SDK never retries:
 * the runners count attempts. (ANTHROPIC_CUSTOM_HEADERS can still add headers, but only on requests to ANTHROPIC_BASE.)
 */
export function anthropicSdk(apiKey: string, timeoutMs: number): Anthropic {
  return new Anthropic({ apiKey, authToken: null, baseURL: ANTHROPIC_BASE, logLevel: 'off', openTelemetry: false, maxRetries: 0, timeout: timeoutMs });
}
