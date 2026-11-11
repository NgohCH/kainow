import { join } from 'node:path';

/** Accepted passwordless sign-in defaults (MVP decision R05), plus one abuse-protection detail. */
export interface AuthSettings {
  codeTtlMinutes: number;
  maxCodeAttempts: number;
  lockoutMinutes: number;
  sessionHours: number;
  /** Design detail, not an accepted product default: minimum gap between codes for one account. */
  codeResendSeconds: number;
}

/** How one-time sign-in codes reach people. Other email is deferred to January. */
export type CodeDelivery = { kind: 'smtp'; url: string; from: string } | { kind: 'log' };

export interface DatabaseConfig {
  databaseUrl: string;
  migrationsDir: string;
}

export interface AppConfig extends DatabaseConfig {
  port: number;
  auth: AuthSettings;
  /** Secret used to hash one-time codes. Never stored in the database. */
  authSecret: string;
  cookieSecure: boolean;
  codeDelivery: CodeDelivery;
  /** Where people open Kainow; used for links in invitation emails. */
  appUrl: string;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  codeTtlMinutes: 10,
  maxCodeAttempts: 5,
  lockoutMinutes: 30,
  sessionHours: 12,
  codeResendSeconds: 60,
};

export const APP_CONFIG = Symbol('APP_CONFIG');

/** What the migration command and the worker need. They do not need sign-in settings. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  return {
    databaseUrl,
    // dist/config.js -> app/migrations
    migrationsDir: join(__dirname, '..', 'migrations'),
  };
}

/** Reads configuration from the environment. Secrets come only from here, never from files in the repo. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const database = loadDatabaseConfig(env);

  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${rawPort}"`);
  }

  const authSecret = env.AUTH_SECRET ?? '';
  if (authSecret.length < 32) {
    throw new Error('AUTH_SECRET must be set to a random value of at least 32 characters');
  }

  let codeDelivery: CodeDelivery;
  if (env.SMTP_URL) {
    if (!env.SMTP_FROM) {
      throw new Error('SMTP_FROM must be set when SMTP_URL is set');
    }
    codeDelivery = { kind: 'smtp', url: env.SMTP_URL, from: env.SMTP_FROM };
  } else if (env.LOG_SIGN_IN_CODES === 'true') {
    codeDelivery = { kind: 'log' };
  } else {
    throw new Error(
      'No way to deliver sign-in codes: set SMTP_URL and SMTP_FROM, or set LOG_SIGN_IN_CODES=true for local development only',
    );
  }

  return {
    ...database,
    port,
    auth: { ...DEFAULT_AUTH_SETTINGS },
    authSecret,
    // Browsers accept Secure cookies on http://localhost; set COOKIE_SECURE=false only if a browser does not.
    cookieSecure: env.COOKIE_SECURE !== 'false',
    appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    codeDelivery,
  };
}

/** In production, invitation links need the real address people use (review minor). */
export function appUrlWarning(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV === 'production' && !env.APP_URL) return 'APP_URL is not set; invitation links will point to http://localhost:3000.';
  return null;
}

export interface WorkerConfig extends DatabaseConfig {
  /** Absent means AI runs fail with a clear reason and nothing is sent or charged. */
  openAiApiKey: string | null;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return { ...loadDatabaseConfig(env), openAiApiKey: env.OPENAI_API_KEY?.trim() || null };
}
