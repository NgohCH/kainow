import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadConfig } from '../config';
import { SKIP_NO_DB, testDatabaseUrl } from '../testing/db';

async function startApp(databaseUrl: string): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create(AppModule.register(loadConfig({ DATABASE_URL: databaseUrl })), { logger: false });
  await app.listen(0);
  return { app, base: await app.getUrl() };
}

describe('GET /health', () => {
  test('is 200 and reports the database up when it answers', { skip: SKIP_NO_DB }, async () => {
    const { app, base } = await startApp(testDatabaseUrl() as string);
    try {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok', database: 'up' });
    } finally {
      await app.close();
    }
  });

  test('is 503 and says degraded when the database is unreachable, without leaking detail', async () => {
    const { app, base } = await startApp('postgres://nobody:nothing@127.0.0.1:1/none');
    try {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { status: 'degraded', database: 'down' });
      assert.doesNotMatch(text, /ECONNREFUSED|nobody|127\.0\.0\.1/);
    } finally {
      await app.close();
    }
  });
});
