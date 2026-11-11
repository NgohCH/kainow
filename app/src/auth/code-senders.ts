import type { Clock } from './tokens';
import type { EmailConfig } from '../config';
import { DEFAULT_NAME, chooseLogo, defaultLogo } from '../organisation/branding';
import { composeEmail } from '../organisation/email';
import { createTransport, storeAttachments, type MailTransport } from '../email/transport';
import type { Letterhead } from '../organisation/organisation.service';
import type { CodeSender, SetupKind } from './tokens';

const utc = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');

/** The wording of the one-time link email, by kind. */
export function setupInvitationEmail(link: string, expiresAt: Date, kind: SetupKind = 'setup'): { subject: string; body: string } {
  if (kind === 'recovery') {
    return {
      subject: 'Restore your Kainow Administrator access',
      body:
        'Kainow Administrator access is being restored for you. Open this link and sign in with the code Kainow emails you; ' +
        `you will then be an Enterprise Administrator:\n${link}\n\n` +
        `The link works once and expires on ${utc(expiresAt)} UTC. If you did not expect this, contact your organisation's recovery custodian.`,
    };
  }
  return {
    subject: 'Set up Kainow',
    body:
      `You have been asked to set up Kainow as its first Enterprise Administrator.\n\n` +
      `Open this link and sign in with the code Kainow emails you; you will then set up your organisation:\n${link}\n\n` +
      `The link works once and expires on ${utc(expiresAt)} UTC.`,
  };
}

/** Local development only: writes the code to the server log. Refused unless LOG_SIGN_IN_CODES=true. */
export class LogCodeSender implements CodeSender {
  async send(email: string, code: string, validForMinutes: number): Promise<void> {
    console.log(`[sign-in code, development only] ${email}: ${code} (valid ${validForMinutes} minutes)`);
  }

  async sendSetupInvitation(email: string, link: string, expiresAt: Date, kind: SetupKind = 'setup'): Promise<void> {
    console.log(`[${kind} invitation, development only] ${email}: until ${expiresAt.toISOString()}: ${link}`);
  }
}

/** Kainow's own letterhead, used until the running app attaches the organisation's (and by the setup command). */
async function kainowLetterhead(): Promise<Letterhead> {
  const choice = chooseLogo('email', { wide: false, square: false });
  const logo = defaultLogo(choice.shape);
  return { name: DEFAULT_NAME, registered: false, logo: { content: logo.content, mime: logo.mime, box: choice.box } };
}

/** Sends every email with the organisation's letterhead: its name in the text, its logo inline in the HTML. */
export class EmailCodeSender implements CodeSender {
  private letterhead: () => Promise<Letterhead> = kainowLetterhead;

  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {}

  /** Called once the app starts, so emails carry the organisation's name and logo for the 'email' place. */
  useLetterhead(source: () => Promise<Letterhead>): void {
    this.letterhead = source;
  }

  private async deliver(to: string, subject: string, body: string): Promise<void> {
    const m = composeEmail(await this.letterhead(), subject, body);
    await this.transport.send({ from: this.from, to, subject: m.subject, text: m.text, html: m.html, attachments: storeAttachments(m.attachments) });
  }

  async send(email: string, code: string, validForMinutes: number): Promise<void> {
    await this.deliver(
      email,
      'Your Kainow sign-in code',
      `Your Kainow sign-in code is ${code}.\n\n` +
        `It works once and is valid for ${validForMinutes} minutes. ` +
        'If you did not ask to sign in, you can ignore this email.',
    );
  }

  async sendSetupInvitation(email: string, link: string, expiresAt: Date, kind: SetupKind = 'setup'): Promise<void> {
    const m = setupInvitationEmail(link, expiresAt, kind);
    await this.deliver(email, m.subject, m.body);
  }
}

/** Sign-in codes and the setup invitation go straight out through the chosen provider (the log provider prints them instead). */
export function createCodeSender(email: EmailConfig, clock: Clock = () => new Date()): CodeSender {
  return email.provider === 'log' ? new LogCodeSender() : new EmailCodeSender(createTransport(email, clock), email.from);
}
