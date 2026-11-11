import type { CodeSender } from '../auth/tokens';

/** Environment for tests. Codes are logged, cookies are not Secure, the secret is a throwaway. */
export function testEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: 'test-only-secret-'.padEnd(48, 'x'),
    LOG_SIGN_IN_CODES: 'true',
    COOKIE_SECURE: 'false',
  };
}

/** Remembers every code instead of sending it, so tests can sign in. */
export class CaptureSender implements CodeSender {
  readonly sent: { email: string; code: string; validForMinutes: number }[] = [];
  failNext = false;

  async send(email: string, code: string, validForMinutes: number): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mail server unavailable');
    }
    this.sent.push({ email, code, validForMinutes });
  }

  readonly invitations: { email: string; link: string }[] = [];

  failNextInvitation = false;

  async sendInvitation(email: string, link: string): Promise<void> {
    if (this.failNextInvitation) {
      this.failNextInvitation = false;
      throw new Error('mail server unavailable');
    }
    this.invitations.push({ email, link });
  }

  readonly holdAlerts: { email: string; projectName: string; link: string }[] = [];

  async sendHoldAlert(email: string, projectName: string, link: string): Promise<void> {
    this.holdAlerts.push({ email, projectName, link });
  }

  readonly setupInvitations: { email: string; link: string; expiresAt: Date }[] = [];

  async sendSetupInvitation(email: string, link: string, expiresAt: Date): Promise<void> {
    this.setupInvitations.push({ email, link, expiresAt });
  }

  lastInvitation(email: string): string {
    const found = [...this.invitations].reverse().find((s) => s.email === email);
    if (!found) throw new Error(`no invitation was sent to ${email}`);
    return found.link;
  }

  lastCode(email: string): string {
    const found = [...this.sent].reverse().find((s) => s.email === email);
    if (!found) {
      throw new Error(`no code was sent to ${email}`);
    }
    return found.code;
  }
}

/** A clock the test moves by hand. */
export class FakeClock {
  constructor(public ms: number) {}

  readonly now = (): Date => new Date(this.ms);

  advanceSeconds(seconds: number): void {
    this.ms += seconds * 1000;
  }

  advanceMinutes(minutes: number): void {
    this.ms += minutes * 60_000;
  }
}

/** A six-digit code that is not the given one. */
export function differentCode(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
}
