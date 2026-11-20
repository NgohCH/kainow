import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PgTools } from './pg-tools';

describe('pg client tools', () => {
  test('version() is 16', async (t) => {
    const tools = new PgTools('postgres://postgres:pw@127.0.0.1:5432/x');
    let major: number;
    try {
      major = await tools.version();
    } catch {
      if (process.env.CI) assert.fail('pg client tools not found (required in CI)');
      t.skip('pg client tools not found');
      return;
    }
    assert.equal(major, 16);
  });
  test('a malformed connection string fails with a fixed message that does not repeat it', () => {
    const tools = new PgTools('postgres://user:s3cret-pw@host:notaport/db');
    assert.throws(
      () => tools.dump([]),
      (e: Error) => e.message === 'The database connection setting is not a valid URL.' && !e.message.includes('s3cret'),
    );
  });
});
