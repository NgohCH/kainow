/**
 * Operations settings (D110, D113-D115): backup retention, the storage warning and critical levels, the safe floor
 * and the diagnostic retention. One row in `operations_settings`; the values and bounds match its CHECKs.
 */
import type { Pool, PoolClient } from 'pg';

export interface OpsSettings {
  backupRetentionDays: number;
  storageWarningPct: number;
  storageCriticalPct: number;
  safeFloorGb: number;
  diagnosticRetentionDays: number;
}

export const OPS_DEFAULTS: OpsSettings = {
  backupRetentionDays: 30,
  storageWarningPct: 80,
  storageCriticalPct: 90,
  safeFloorGb: 5,
  diagnosticRetentionDays: 30,
};

/** The critical level must also exceed the warning level (see validateOpsSettings), so its lowest value is 51. */
export const OPS_BOUNDS: Record<keyof OpsSettings, { min: number; max: number }> = {
  backupRetentionDays: { min: 7, max: 365 },
  storageWarningPct: { min: 50, max: 95 },
  storageCriticalPct: { min: 51, max: 99 },
  safeFloorGb: { min: 1, max: 1000 },
  diagnosticRetentionDays: { min: 7, max: 365 },
};

export const OPS_KEYS = Object.keys(OPS_DEFAULTS) as Array<keyof OpsSettings>;

const LABEL: Record<keyof OpsSettings, string> = {
  backupRetentionDays: 'Backup retention',
  storageWarningPct: 'Storage warning level',
  storageCriticalPct: 'Storage critical level',
  safeFloorGb: 'Safe floor',
  diagnosticRetentionDays: 'Diagnostic retention',
};

/** Every problem with the five values, as sentences; empty when all are whole numbers within their bounds. */
export function validateOpsSettings(next: OpsSettings): string[] {
  const problems: string[] = [];
  for (const key of OPS_KEYS) {
    const { min, max } = OPS_BOUNDS[key];
    const v = (next as unknown as Record<string, unknown>)[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      problems.push(`${LABEL[key]} must be a whole number from ${min} to ${max}.`);
    }
  }
  if (problems.length === 0 && next.storageCriticalPct <= next.storageWarningPct) {
    problems.push(`Storage critical level (${next.storageCriticalPct}) must be higher than the warning level (${next.storageWarningPct}).`);
  }
  return problems;
}

/** The settings in force; the defaults when the row is missing. */
export async function loadOpsSettings(db: Pool | PoolClient, lock = false): Promise<OpsSettings> {
  const { rows } = await db.query(
    `SELECT backup_retention_days AS "backupRetentionDays", storage_warning_pct AS "storageWarningPct",
            storage_critical_pct AS "storageCriticalPct", safe_floor_gb AS "safeFloorGb",
            diagnostic_retention_days AS "diagnosticRetentionDays"
       FROM operations_settings WHERE id${lock ? ' FOR UPDATE' : ''}`,
  );
  return rows[0] ?? { ...OPS_DEFAULTS };
}
