import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp } from '../bootstrap';
import { loadConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { resetPublicSchema, testDatabaseUrl } from './db';
import { CaptureSender, FakeClock, testEnv } from './fakes';
import { seedOrganisation } from './projects';

export interface Reply {
  status: number;
  body: any;
}

/** A signed-in person: every request carries their session cookie and anti-forgery token. */
export interface Client {
  userId: string;
  request(method: string, path: string, body?: unknown): Promise<Reply>;
  /** Sends raw bytes (a file upload) with the given type. */
  upload(method: string, path: string, body: Buffer, contentType: string): Promise<Reply>;
}

export interface TestApp {
  app: INestApplication;
  pool: Pool;
  base: string;
  clock: FakeClock;
  sender: CaptureSender;
  /** Signs in an existing account by its emailed code. */
  signIn(email: string): Promise<Client>;
  /** A request with no session. */
  anonymous(method: string, path: string, body?: unknown): Promise<Reply>;
  close(): Promise<void>;
}

async function send(base: string, method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/**
 * Starts the whole application on an empty migrated database, with a fake clock and a code-capturing sender.
 * The organisation is already set up unless `organisation: false` (for onboarding tests).
 */
export async function startTestApp(startAt = Date.UTC(2026, 10, 9, 2, 0, 0), opts: { organisation?: boolean; emailNudge?: { nudge(): Promise<void> } } = {}): Promise<TestApp> {
  const sender = new CaptureSender();
  const clock = new FakeClock(startAt);
  const config = loadConfig(testEnv(testDatabaseUrl() as string));
  const pool = new Pool({ connectionString: config.databaseUrl });
  await resetPublicSchema(pool);
  await runMigrations(pool, config.migrationsDir);
  if (opts.organisation !== false) await seedOrganisation(pool);
  const app = await createApp(config, { codeSender: sender, clock: clock.now, logger: false, extractionQueue: { enqueue: async () => undefined }, emailNudge: opts.emailNudge ?? { nudge: async () => undefined } });
  await app.listen(0);
  const base = await app.getUrl();

  async function signIn(email: string): Promise<Client> {
    await send(base, 'POST', '/auth/request-code', { email }, {});
    const res = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: sender.lastCode(email) }),
    });
    if (res.status !== 200) throw new Error(`Sign-in failed for ${email}: ${res.status}`);
    const cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0];
    const { csrfToken, user } = (await res.json()) as { csrfToken: string; user: { id: string } };
    // A fresh code may be requested at once by the next sign-in of the same person.
    clock.advanceSeconds(61);
    return {
      userId: user.id,
      request: (method, path, body) => send(base, method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken }),
      upload: async (method, path, body, contentType) => {
        const res = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': contentType }, body: new Uint8Array(body) });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : undefined };
      },
    };
  }

  return {
    app,
    pool,
    base,
    clock,
    sender,
    signIn,
    anonymous: (method, path, body) => send(base, method, path, body, {}),
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
