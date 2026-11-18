import type { SpendSettingsInput } from './spend.settings';
import { parseMicro } from './money';

/**
 * The values the Product Owner approved on 7 November 2026 (docs/MVP-DECISIONS.md): 1 USD = 4.1 MYR,
 * MYR 20 a month, and no daily limit by explicit decision. The model and its prices now go through the
 * approved catalogue (/ai/models), not these settings. Delegation is off, there is no ceiling, and the
 * call policy is the default (3 attempts, 120 seconds, 2 at once).
 */
export const MVP_SPEND_SETTINGS: SpendSettingsInput = {
  prices: { myrPerUsdMicro: parseMicro('4.1', 'rate') },
  monthlyLimitMicroMyr: parseMicro('20', 'monthly limit'),
  daily: { mode: 'not_applied' },
  projectsMaySetLimits: false,
  projectsMayManageConnections: false,
  projectCeiling: { mode: 'not_applied' },
  maxAttempts: 3,
  timeoutSeconds: 120,
  concurrency: 2,
};
