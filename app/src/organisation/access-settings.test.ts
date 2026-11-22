import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCESS_BOUNDS, ACCESS_DEFAULTS, validateAccessSettings } from './access-settings';

const with_ = (over: object) => validateAccessSettings({ ...ACCESS_DEFAULTS, ...over });

test('the defaults are valid and have the D90 values', () => {
  assert.deepEqual(ACCESS_DEFAULTS, { archiveAfterMonths: 12, grantDefaultDays: 30, grantMaxDays: 90, invitationValidDays: 7, analyticsExportAllowed: true, projectExportsAllowed: false });
  assert.deepEqual(validateAccessSettings(ACCESS_DEFAULTS), { ok: true, value: ACCESS_DEFAULTS });
  assert.deepEqual(ACCESS_BOUNDS, {
    archiveAfterMonths: { min: 1, max: 60 }, grantDefaultDays: { min: 1, max: 90 }, grantMaxDays: { min: 1, max: 365 }, invitationValidDays: { min: 1, max: 30 },
  });
});

test('each bound is refused with a message naming the field and range', () => {
  const cases: Array<[object, string, string]> = [
    [{ archiveAfterMonths: 0 }, 'archiveAfterMonths', 'Archive delay must be 1–60 months.'],
    [{ archiveAfterMonths: 61 }, 'archiveAfterMonths', 'Archive delay must be 1–60 months.'],
    [{ grantDefaultDays: 0 }, 'grantDefaultDays', 'Default grant length must be 1–90 days.'],
    [{ grantDefaultDays: 91 }, 'grantDefaultDays', 'Default grant length must be 1–90 days.'],
    [{ grantMaxDays: 0 }, 'grantMaxDays', 'Maximum grant length must be 1–365 days.'],
    [{ grantMaxDays: 366 }, 'grantMaxDays', 'Maximum grant length must be 1–365 days.'],
    [{ invitationValidDays: 0 }, 'invitationValidDays', 'Invitation validity must be 1–30 days.'],
    [{ invitationValidDays: 31 }, 'invitationValidDays', 'Invitation validity must be 1–30 days.'],
    [{ archiveAfterMonths: 1.5 }, 'archiveAfterMonths', 'Archive delay must be 1–60 months.'],
    [{ invitationValidDays: '7' }, 'invitationValidDays', 'Invitation validity must be 1–30 days.'],
    [{ analyticsExportAllowed: 'yes' }, 'analyticsExportAllowed', 'Analytics export must be on or off.'],
    [{ projectExportsAllowed: 'yes' }, 'projectExportsAllowed', 'Project exports must be on or off.'],
  ];
  for (const [over, field, message] of cases) assert.deepEqual(with_(over), { ok: false, field, message }, JSON.stringify(over));
  assert.equal(with_({ archiveAfterMonths: 1 }).ok, true);
  assert.equal(with_({ archiveAfterMonths: 60 }).ok, true);
  assert.equal(with_({ grantMaxDays: 365 }).ok, true);
  assert.equal(validateAccessSettings(null).ok, false);
});

test('a default length above the maximum is refused, naming the default length', () => {
  const r = with_({ grantDefaultDays: 60, grantMaxDays: 45 });
  assert.deepEqual(r, { ok: false, field: 'grantDefaultDays', message: 'Default grant length (60 days) cannot be longer than the maximum (45 days).' });
  assert.equal(with_({ grantDefaultDays: 45, grantMaxDays: 45 }).ok, true);
});
