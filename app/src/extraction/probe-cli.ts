import { exitWith, modelFor, probeClient, resolveProbe } from '../ai/probe-args';
import { runProbe } from './probe';

/**
 * Usage: OPENAI_API_KEY=... npm run probe-ai -- [--provider openai] [model id]   (default gpt-6.1-sol)
 *        ANTHROPIC_API_KEY=... npm run probe-ai -- --provider anthropic <model id>
 * Sends one small request. The key is read from your shell's environment only and is never printed.
 */
async function main(): Promise<void> {
  const { provider, apiKey, args } = resolveProbe(process.argv.slice(2), process.env);
  const modelId = modelFor(provider, args[0]);
  console.log(`provider ${provider}, model ${modelId}`);
  const { ok, report } = await runProbe(probeClient(provider, apiKey, 60_000), modelId);
  console.log(report);
  process.exit(ok ? 0 : 1);
}

main().catch(exitWith);
