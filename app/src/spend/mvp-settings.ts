import type { Prices } from './cost';
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

/**
 * The model and Standard rates approved on 7 November 2026, kept only so that spend reservation and the guarded call
 * still have a price until they read the catalogue. Bridged until Task 5 (reserve) and Task 10 (guarded call).
 */
export const MVP_BRIDGE_MODEL: { modelId: string; prices: Prices } = {
  modelId: 'gpt-6.1-sol',
  prices: {
    inputMicroUsdPerMillion: parseMicro('2.00', 'input'),
    cachedInputMicroUsdPerMillion: parseMicro('0.10', 'cached input'),
    cacheWriteMicroUsdPerMillion: 0n,
    outputMicroUsdPerMillion: parseMicro('10.00', 'output'),
    myrPerUsdMicro: MVP_SPEND_SETTINGS.prices.myrPerUsdMicro,
  },
};

/** The bridged model with the organisation's current exchange rate. Bridged until Task 5 / Task 10. */
export function bridgedModel(settings: { prices: { myrPerUsdMicro: bigint } }): { modelId: string; prices: Prices } {
  return { modelId: MVP_BRIDGE_MODEL.modelId, prices: { ...MVP_BRIDGE_MODEL.prices, myrPerUsdMicro: settings.prices.myrPerUsdMicro } };
}
