/**
 * Access and records settings (D90): the archive delay, Audit/Oversight grant lengths, project invitation validity and
 * whether analytics and project records may be exported. One row in `access_settings`; the values and bounds below match its CHECKs.
 */
import type { Pool, PoolClient } from 'pg';

export interface AccessSettings {
  archiveAfterMonths: number;
  grantDefaultDays: number;
  grantMaxDays: number;
  invitationValidDays: number;
  analyticsExportAllowed: boolean;
  /** Whether projects may export their records as CSV (D106); Off until the Administrator turns it on. */
  projectExportsAllowed: boolean;
}

export const ACCESS_DEFAULTS: AccessSettings = {
  archiveAfterMonths: 12,
  grantDefaultDays: 30,
  grantMaxDays: 90,
  invitationValidDays: 7,
  analyticsExportAllowed: true,
  projectExportsAllowed: false,
};

type NumericKey = 'archiveAfterMonths' | 'grantDefaultDays' | 'grantMaxDays' | 'invitationValidDays';

export const ACCESS_BOUNDS: Record<NumericKey, { min: number; max: number }> = {
  archiveAfterMonths: { min: 1, max: 60 },
  grantDefaultDays: { min: 1, max: 90 },
  grantMaxDays: { min: 1, max: 365 },
  invitationValidDays: { min: 1, max: 30 },
};

const LABEL: Record<NumericKey, { name: string; unit: string }> = {
  archiveAfterMonths: { name: 'Archive delay', unit: 'months' },
  grantDefaultDays: { name: 'Default grant length', unit: 'days' },
  grantMaxDays: { name: 'Maximum grant length', unit: 'days' },
  invitationValidDays: { name: 'Invitation validity', unit: 'days' },
};

export const ACCESS_KEYS = ['archiveAfterMonths', 'grantDefaultDays', 'grantMaxDays', 'invitationValidDays', 'analyticsExportAllowed', 'projectExportsAllowed'] as const;

export type AccessValidation = { ok: true; value: AccessSettings } | { ok: false; field: string; message: string };

/** All six values, each whole and within its bounds; the default grant length may not exceed the maximum. */
export function validateAccessSettings(next: unknown): AccessValidation {
  const src = next && typeof next === 'object' ? (next as Record<string, unknown>) : {};
  const out: Partial<AccessSettings> = {};
  for (const key of Object.keys(ACCESS_BOUNDS) as NumericKey[]) {
    const { min, max } = ACCESS_BOUNDS[key];
    const v = src[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      return { ok: false, field: key, message: `${LABEL[key].name} must be ${min}–${max} ${LABEL[key].unit}.` };
    }
    out[key] = v;
  }
  if (typeof src.analyticsExportAllowed !== 'boolean') {
    return { ok: false, field: 'analyticsExportAllowed', message: 'Analytics export must be on or off.' };
  }
  out.analyticsExportAllowed = src.analyticsExportAllowed;
  if (typeof src.projectExportsAllowed !== 'boolean') {
    return { ok: false, field: 'projectExportsAllowed', message: 'Project exports must be on or off.' };
  }
  out.projectExportsAllowed = src.projectExportsAllowed;
  const value = out as AccessSettings;
  if (value.grantDefaultDays > value.grantMaxDays) {
    return {
      ok: false,
      field: 'grantDefaultDays',
      message: `Default grant length (${value.grantDefaultDays} days) cannot be longer than the maximum (${value.grantMaxDays} days).`,
    };
  }
  return { ok: true, value };
}

/** The settings in force; the defaults when the row is missing. */
export async function loadAccessSettings(db: Pool | PoolClient, lock = false): Promise<AccessSettings> {
  const { rows } = await db.query(
    `SELECT archive_after_months AS "archiveAfterMonths", grant_default_days AS "grantDefaultDays", grant_max_days AS "grantMaxDays",
            invitation_valid_days AS "invitationValidDays", analytics_export_allowed AS "analyticsExportAllowed",
            project_exports_allowed AS "projectExportsAllowed"
       FROM access_settings WHERE id${lock ? ' FOR UPDATE' : ''}`,
  );
  return rows[0] ?? { ...ACCESS_DEFAULTS };
}
