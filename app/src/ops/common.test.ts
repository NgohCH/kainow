import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { OPS_FAILURES, codeMigrationLevel } from './common';
import { loadOpsConfig } from './config';

describe('ops common', () => {
  test('every failure code has plain fixed text without paths or ports', () => {
    const entries = Object.entries(OPS_FAILURES);
    assert.equal(entries.length, 15);
    for (const [code, text] of entries) {
      assert.ok(text.trim().length > 0, code);
      assert.ok(!text.includes('/'), `${code} has a slash`);
      assert.ok(!/:\d/.test(text), `${code} has a port`);
    }
  });

  test('config refuses a missing backup folder naming the variable, not a value', () => {
    assert.throws(
      () => loadOpsConfig({ DATABASE_URL: 'postgres://u:secretpw@db/x' }),
      (e: Error) => e.message.includes('KAINOW_BACKUP_DIR') && !e.message.includes('secretpw'),
    );
  });

  test('config defaults and label', () => {
    const base = { DATABASE_URL: 'postgres://u:p@db/x', KAINOW_BACKUP_DIR: '/backups' };
    const c = loadOpsConfig(base);
    assert.equal(c.folderLabel, '/backups');
    assert.equal(c.protectedKeyFile, null);
    assert.equal(c.dbDataDir, '/pgdata');
    const d = loadOpsConfig({ ...base, KAINOW_BACKUP_DIR_LABEL: 'D:\\kainow-backups', KAINOW_PROTECTED_KEY_FILE: '/run/k' });
    assert.equal(d.folderLabel, 'D:\\kainow-backups');
    assert.equal(d.protectedKeyFile, '/run/k');
  });

  test('the code migration level is the highest file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kainow-mig-'));
    try {
      for (const f of ['0001_a.sql', '0010_b.sql', '0002_c.sql', 'notes.txt']) writeFileSync(join(dir, f), '');
      assert.equal(codeMigrationLevel(dir), '0010_b.sql');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
