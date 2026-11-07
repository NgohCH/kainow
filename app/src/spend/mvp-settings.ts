import type { SpendSettingsInput } from './spend.settings';
import { parseMicro } from './money';

/**
 * The values the Product Owner approved on 7 November 2026 (docs/MVP-DECISIONS.md):
 * gpt-6.1-sol at Standard rates in USD per 1 million tokens, 1 USD = 4.1 MYR,
 * MYR 20 a month, and no daily limit by explicit decision.
 */
export const MVP_SPEND_SETTINGS: SpendSettingsInput = {
  modelId: 'gpt-6.1-sol',
  prices: {
    inputMicroUsdPerMillion: parseMicro('2.00', 'input'),
    cachedInputMicroUsdPerMillion: parseMicro('0.10', 'cached input'),
    outputMicroUsdPerMillion: parseMicro('10.00', 'output'),
    myrPerUsdMicro: parseMicro('4.1', 'rate'),
  },
  monthlyLimitMicroMyr: parseMicro('20', 'monthly limit'),
  daily: { mode: 'not_applied' },
};
