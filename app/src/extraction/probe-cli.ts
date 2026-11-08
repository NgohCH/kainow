import { OpenAiModelClient } from './model';
import { runProbe } from './probe';

/** Usage: OPENAI_API_KEY=... npm run probe-ai -- [model id]   (default gpt-6.1-sol). Sends one small request. */
async function main(): Promise<void> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error('Set OPENAI_API_KEY first.');
  const modelId = process.argv[2] ?? 'gpt-6.1-sol';
  const { ok, report } = await runProbe(new OpenAiModelClient(key), modelId);
  console.log(report);
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
