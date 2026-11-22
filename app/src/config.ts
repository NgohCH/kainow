import { join } from 'node:path';

/** Accepted passwordless sign-in defaults (MVP decision R05), plus one abuse-protection detail. */
export interface AuthSettings {
  codeTtlMinutes: number;
  maxCodeAttempts: number;
  lockoutMinutes: number;
  sessionHours: number;
  /** Design detail, not an accepted product default: minimum gap between codes for one account. */
  codeResendSeconds: number;
  /** Abuse protection per network address (design detail): see auth/address-limiter.ts. */
  addressWindowMinutes: number;
  maxCodeRequestsPerAddress: number;
  maxFailedCodesPerAddress: number;
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
  /** File holding the protected key (32 bytes); null means quarantine cleaning waits for it. */
  protectedKeyFile: string | null;
  /**
   * Express "trust proxy": which proxies may say who the caller is (X-Forwarded-For). null trusts none, so the caller is
   * the connecting address. Behind a reverse proxy set TRUST_PROXY (for example "loopback" or "1"), or every caller
   * looks like the proxy and shares one set of sign-in limits.
   */
  trustProxy: string | number | null;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  codeTtlMinutes: 10,
  maxCodeAttempts: 5,
  lockoutMinutes: 30,
  sessionHours: 12,
  codeResendSeconds: 60,
  addressWindowMinutes: 15,
  maxCodeRequestsPerAddress: 100,
  maxFailedCodesPerAddress: 10,
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
    if (env.LOG_SIGN_IN_CODES === 'true') {
      assertLogAllowed(env);
      return { provider: 'log' };
    }
    throw new Error(
      'No way to deliver sign-in codes: set EMAIL_PROVIDER (m365 or smtp) with its settings, or set LOG_SIGN_IN_CODES=true for local development only',
    );
  }
  throw new Error('EMAIL_PROVIDER must be m365, smtp or log');
}

/**
 * Printing sign-in codes to the log lets anyone who reads the log sign in as anyone. In production it is allowed only
 * while Kainow is reached on this computer alone (APP_URL unset or a loopback address), as INSTALL.md's trial does.
 */
function assertLogAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;
  let host = 'localhost';
  try {
    host = new URL(appUrlFrom(env)).hostname;
  } catch {
    host = '';
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    throw new Error('Sign-in codes cannot be printed to the log in production when APP_URL is not this computer: set EMAIL_PROVIDER (m365 or smtp)');
  }
}

function appUrlFrom(env: NodeJS.ProcessEnv): string {
  return (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function protectedKeyFileFrom(env: NodeJS.ProcessEnv): string | null {
  return env.KAINOW_PROTECTED_KEY_FILE?.trim() || null;
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
    appUrl: appUrlFrom(env),
    email,
    protectedKeyFile: protectedKeyFileFrom(env),
    trustProxy: trustProxyFrom(env),
  };
}

/** A number of proxy hops, or Express's address list ("loopback", "10.0.0.1, 10.0.0.2"). "true" is refused: it trusts anyone. */
export function trustProxyFrom(env: NodeJS.ProcessEnv): string | number | null {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw || raw === 'false') return null;
  if (raw === 'true') throw new Error('TRUST_PROXY=true would let any caller choose their own address; give the number of proxies or their addresses');
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/** In production, invitation links need the real address people use (review minor). */
export function appUrlWarning(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV === 'production' && !env.APP_URL) return 'APP_URL is not set; invitation links will point to http://localhost:3000.';
  return null;
}

export interface WorkerConfig extends DatabaseConfig {
  email: EmailConfig;
  /** Where people open Kainow; used for links in notification emails. */
  appUrl: string;
  protectedKeyFile: string | null;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return { ...loadDatabaseConfig(env), email: loadEmailConfig(env), appUrl: appUrlFrom(env), protectedKeyFile: protectedKeyFileFrom(env) };
}
