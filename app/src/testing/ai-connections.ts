import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared by the AI connection tests. Obviously fake keys only. */
export const KEY_A = `sk-test-${'x'.repeat(40)}`;
export const KEY_B = `sk-test-${'y'.repeat(40)}`;

export const ORG = {
  myrPerUsd: 4.1,
  monthlyLimitMyr: 200,
  daily: { mode: 'not_applied' },
  projectsMaySetLimits: false,
  projectsMayManageConnections: false,
  projectCeiling: { mode: 'not_applied' },
  maxAttempts: 3,
  timeoutSeconds: 120,
  concurrency: 2,
};

export const modelBody = (provider: 'openai' | 'anthropic', modelId: string) => ({
  provider,
  modelId,
  displayName: `Model ${modelId}`,
  inputUsdPerMillion: '2.00',
  cachedInputUsdPerMillion: '0.10',
  cacheWriteUsdPerMillion: '0',
  outputUsdPerMillion: '10.00',
  dataTerms: 'Not used for training; retained 30 days.',
  purposes: ['extraction'],
  restrictedOk: false,
  reason: 'Reviewed the provider terms',
});

/** A key file in a temporary folder; returns its path. */
export function keyFile(dir: string, name = 'p.key'): string {
  const path = join(dir, name);
  writeFileSync(path, randomBytes(32));
  return path;
}

