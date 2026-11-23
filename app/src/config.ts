import { join } from 'node:path';
import { DEFAULT_SIGN_IN_LIMITS, type SignInLimits } from './auth/request-limit';

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
  /** File holding the protected key (32 bytes); null means quarantine cleaning waits for it. */
  protectedKeyFile: string | null;
  /** Where the release check looks for new releases (10b spec 6.2). */
  release: ReleaseSource;
  /** KAINOW_REQUIRE_PROTECTED_KEY=true: refuse to start unless the protected key loads. */
  requireProtectedKey: boolean;
  /** Request limits on the public sign-in steps (review G03). */
  signInLimits: SignInLimits;
  /** TRUST_PROXY: how many reverse proxies in front of Kainow append to X-Forwarded-For; 0 ignores that header. */
  trustProxyHops: number;
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
  const email = chooseEmailConfig(env);
  // Printed codes are as good as passwords, so production never logs them, whatever APP_URL says (review G02).
  // A local trial that reads codes from the log runs with NODE_ENV=development instead.
  if (email.provider === 'log' && env.NODE_ENV === 'production') {
    throw new Error(
      'LOG_SIGN_IN_CODES (the log email provider) is refused when NODE_ENV=production: set EMAIL_PROVIDER to m365 or smtp, or set NODE_ENV=development for a trial on your own computer',
    );
  }
  // Second review (M1b): NODE_ENV now comes from .env, so a server left on development would log codes again. Logged
  // codes are therefore also refused unless people open Kainow on this computer itself.
  if (email.provider === 'log' && !isLoopbackUrl(appUrlFrom(env))) {
    throw new Error(
      'LOG_SIGN_IN_CODES (the log email provider) is refused when APP_URL is not this computer (localhost or 127.0.0.1): set EMAIL_PROVIDER to m365 or smtp',
    );
  }
  return email;
}

/** True when the address is this computer only: localhost (or a name under it), 127.0.0.0/8 or ::1. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]';
}

function chooseEmailConfig(env: NodeJS.ProcessEnv): EmailConfig {
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

function appUrlFrom(env: NodeJS.ProcessEnv): string {
  return (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Where the release check reads the tags list. Both default in code; installations leave them unset. */
export interface ReleaseSource {
  repo: string;
  api: string;
}
export const DEFAULT_RELEASE_REPO = 'NgohCH/kainow';
export const DEFAULT_RELEASE_API = 'https://api.github.com';

export function releaseSourceFrom(env: NodeJS.ProcessEnv): ReleaseSource {
  return {
    repo: env.KAINOW_RELEASE_REPO?.trim() || DEFAULT_RELEASE_REPO,
    api: (env.KAINOW_RELEASE_API?.trim() || DEFAULT_RELEASE_API).replace(/\/+$/, ''),
  };
}

function protectedKeyFileFrom(env: NodeJS.ProcessEnv): string | null {
  return env.KAINOW_PROTECTED_KEY_FILE?.trim() || null;
}

/** KAINOW_REQUIRE_PROTECTED_KEY: unset or false means optional; true means the key file must be set (review G05). */
function protectedKeySettings(env: NodeJS.ProcessEnv): { protectedKeyFile: string | null; requireProtectedKey: boolean } {
  const raw = env.KAINOW_REQUIRE_PROTECTED_KEY?.trim() || 'false';
  if (raw !== 'true' && raw !== 'false') throw new Error('KAINOW_REQUIRE_PROTECTED_KEY must be true or false');
  const requireProtectedKey = raw === 'true';
  const protectedKeyFile = protectedKeyFileFrom(env);
  if (requireProtectedKey && !protectedKeyFile) {
    throw new Error('KAINOW_PROTECTED_KEY_FILE must be set when KAINOW_REQUIRE_PROTECTED_KEY=true');
  }
  return { protectedKeyFile, requireProtectedKey };
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

  const rawHops = env.TRUST_PROXY?.trim() || '0';
  const trustProxyHops = Number(rawHops);
  if (!/^\d+$/.test(rawHops) || trustProxyHops > 10) {
    throw new Error('TRUST_PROXY must be the number of reverse proxies in front of Kainow, from 0 to 10');
  }

  return {
    ...database,
    port,
    auth: { ...DEFAULT_AUTH_SETTINGS },
    authSecret,
    // Browsers accept Secure cookies on http://localhost; set COOKIE_SECURE=false only if a browser does not.
    cookieSecure: env.COOKIE_SECURE !== 'false',
    appUrl: appUrlFrom(env),
    email,
    ...protectedKeySettings(env),
    signInLimits: { ...DEFAULT_SIGN_IN_LIMITS },
    trustProxyHops,
    release: releaseSourceFrom(env),
  };
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
  requireProtectedKey: boolean;
  release: ReleaseSource;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return { ...loadDatabaseConfig(env), email: loadEmailConfig(env), appUrl: appUrlFrom(env), ...protectedKeySettings(env), release: releaseSourceFrom(env) };
}
