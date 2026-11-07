import { join } from 'node:path';

/** Accepted passwordless sign-in defaults (MVP decision R05). */
export interface AuthSettings {
  codeTtlMinutes: number;
  maxCodeAttempts: number;
  lockoutMinutes: number;
  sessionHours: number;
}

export interface AppConfig {
  databaseUrl: string;
  port: number;
  migrationsDir: string;
  auth: AuthSettings;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  codeTtlMinutes: 10,
  maxCodeAttempts: 5,
  lockoutMinutes: 30,
  sessionHours: 12,
};

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Reads configuration from the environment. Secrets come only from here, never from files in the repo. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${rawPort}"`);
  }
  return {
    databaseUrl,
    port,
    // dist/config.js -> app/migrations
    migrationsDir: join(__dirname, '..', 'migrations'),
    auth: { ...DEFAULT_AUTH_SETTINGS },
  };
}
