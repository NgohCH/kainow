import type { OpsSettings } from './settings';

export type StorageLevel = 'normal' | 'warning' | 'critical' | 'unknown';

/** The level for a percentage used (0 to 100); null means the location could not be measured. */
export function levelFor(usedPct: number | null, settings: OpsSettings): StorageLevel {
  if (usedPct === null || !Number.isFinite(usedPct)) return 'unknown';
  if (usedPct >= settings.storageCriticalPct) return 'critical';
  if (usedPct >= settings.storageWarningPct) return 'warning';
  return 'normal';
}
