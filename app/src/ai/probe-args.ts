import { type ProviderClient, realClientFactory } from './client-factory';
import type { Provider } from './keys';

/** A mistake in how a probe was started. The command prints the message and exits 2; the message never holds a key. */
export class ProbeUsageError extends Error {}

const KEY_VARIABLES: Record<Provider, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const DEFAULT_MODELS: Partial<Record<Provider, string>> = { openai: 'gpt-6.1-sol' };

export interface ProbeSetup {
  provider: Provider;
  apiKey: string;
  /** The command's own arguments, with `--provider` taken out. */
  args: string[];
}

/**
 * Reads `--provider openai|anthropic` (default openai) and that provider's key from the environment. The probes read
 * keys from the process environment only: never from the database or a file. Throws ProbeUsageError.
 */
export function resolveProbe(argv: string[], env: NodeJS.ProcessEnv): ProbeSetup {
  const args: string[] = [];
  let provider: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') {
      provider = argv[++i] ?? '';
    } else if (a.startsWith('--provider=')) {
      provider = a.slice('--provider='.length);
    } else {
      args.push(a);
    }
  }
  if (provider !== undefined && provider !== 'openai' && provider !== 'anthropic') {
    throw new ProbeUsageError('--provider must be openai or anthropic');
  }
  const chosen: Provider = provider ?? 'openai';
  const variable = KEY_VARIABLES[chosen];
  const apiKey = env[variable]?.trim();
  if (!apiKey) throw new ProbeUsageError(`${variable} is not set`);
  return { provider: chosen, apiKey, args };
}

/** The model to ask: the one named, else the provider's default. Anthropic has no default: the model id must be named. */
export function modelFor(provider: Provider, named: string | undefined): string {
  const model = named ?? DEFAULT_MODELS[provider];
  if (!model) throw new ProbeUsageError(`Name the model id for ${provider} as the last argument`);
  return model;
}

/** The same adapters the worker uses, built the way the client factory builds them. */
export function probeClient(provider: Provider, apiKey: string, timeoutMs: number): ProviderClient {
  return realClientFactory.forAttempt({ provider, apiKey, timeoutMs });
}

/** Prints the problem and exits 2 for a usage error; anything else exits 1. Never prints a key. */
export function exitWith(err: unknown): never {
  console.error(err instanceof Error ? err.message : err);
  process.exit(err instanceof ProbeUsageError ? 2 : 1);
}
