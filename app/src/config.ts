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

/** How email leaves Kainow: sign-in codes, invitations and everything in the outbox. */
export type EmailConfig =
  | { provider: 'm365'; tenantId: string; clientId: string; clientSecret: string; from: string }
  | { provider: 'smtp'; url: string; from: string }
  | { provider: 'log' };

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
  email: EmailConfig;
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

const missing = (name: string, when: string): Error => new Error(`${name} must be set when ${when}`);

/**
 * Chooses the email provider. EMAIL_PROVIDER unset keeps the older rules: SMTP_URL (with SMTP_FROM) gives smtp,
 * else LOG_SIGN_IN_CODES=true gives log. Messages name variables, never their values.
 */
export function loadEmailConfig(env: NodeJS.ProcessEnv): EmailConfig {
  const provider = env.EMAIL_PROVIDER || undefined;
  if (provider === 'm365') {
    const need = (name: string): string => {
      const value = env[name];
      if (!value) throw missing(name, 'EMAIL_PROVIDER=m365');
      return value;
    };
    return {
      provider: 'm365',
      tenantId: need('M365_TENANT_ID'),
      clientId: need('M365_CLIENT_ID'),
      clientSecret: need('M365_CLIENT_SECRET'),
      from: need('EMAIL_FROM'),
    };
  }
  if (provider === 'smtp') {
    if (!env.SMTP_URL) throw missing('SMTP_URL', 'EMAIL_PROVIDER=smtp');
    const from = env.EMAIL_FROM || env.SMTP_FROM;
    if (!from) throw missing('EMAIL_FROM', 'EMAIL_PROVIDER=smtp');
    return { provider: 'smtp', url: env.SMTP_URL, from };
  }
  if (provider === 'log' || provider === undefined) {
    if (provider === undefined && env.SMTP_URL) {
      if (!env.SMTP_FROM) throw new Error('SMTP_FROM must be set when SMTP_URL is set');
      return { provider: 'smtp', url: env.SMTP_URL, from: env.SMTP_FROM };
    }
    if (env.LOG_SIGN_IN_CODES === 'true') return { provider: 'log' };
    throw new Error(
      'No way to deliver sign-in codes: set EMAIL_PROVIDER (m365 or smtp) with its settings, or set LOG_SIGN_IN_CODES=true for local development only',
    );
  }
  throw new Error('EMAIL_PROVIDER must be m365, smtp or log');
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

  const email = loadEmailConfig(env);

  return {
    ...database,
    port,
    auth: { ...DEFAULT_AUTH_SETTINGS },
    authSecret,
    // Browsers accept Secure cookies on http://localhost; set COOKIE_SECURE=false only if a browser does not.
    cookieSecure: env.COOKIE_SECURE !== 'false',
    appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    email,
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
  email: EmailConfig;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return { ...loadDatabaseConfig(env), openAiApiKey: env.OPENAI_API_KEY?.trim() || null, email: loadEmailConfig(env) };
}
