import { createTransport } from 'nodemailer';
import type { CodeDelivery } from '../config';
import { DEFAULT_NAME, chooseLogo, defaultLogo } from '../organisation/branding';
import { composeEmail } from '../organisation/email';
import type { Letterhead } from '../organisation/organisation.service';
import type { CodeSender } from './tokens';

/** Local development only: writes the code to the server log. Refused unless LOG_SIGN_IN_CODES=true. */
export class LogCodeSender implements CodeSender {
  async send(email: string, code: string, validForMinutes: number): Promise<void> {
    console.log(`[sign-in code, development only] ${email}: ${code} (valid ${validForMinutes} minutes)`);
  }

  async sendInvitation(email: string, link: string, projectName: string, role: string, expiresAt: Date): Promise<void> {
    console.log(`[invitation, development only] ${email}: ${role} in "${projectName}" until ${expiresAt.toISOString()}: ${link}`);
  }

  async sendHoldAlert(email: string, projectName: string, link: string): Promise<void> {
    console.log(`[hold alert, development only] ${email}: "${projectName}" ${link}`);
  }

  async sendSetupInvitation(email: string, link: string, expiresAt: Date): Promise<void> {
    console.log(`[setup invitation, development only] ${email}: until ${expiresAt.toISOString()}: ${link}`);
  }

  async sendDelegatedClosureNotice(email: string, projectName: string, outcome: string, link: string): Promise<void> {
    console.log(`[closure notice, development only] ${email}: "${projectName}" closed as ${outcome}: ${link}`);
  }
}

type MailTransport = { sendMail(message: Record<string, unknown>): Promise<unknown> };

/** Kainow's own letterhead, used until the running app attaches the organisation's (and by the setup command). */
async function kainowLetterhead(): Promise<Letterhead> {
  const choice = chooseLogo('email', { wide: false, square: false });
  const logo = defaultLogo(choice.shape);
  return { name: DEFAULT_NAME, registered: false, logo: { content: logo.content, mime: logo.mime, box: choice.box } };
}

/** Sends every email with the organisation's letterhead: its name in the text, its logo inline in the HTML. */
export class SmtpCodeSender implements CodeSender {
  private readonly transport: MailTransport;
  private letterhead: () => Promise<Letterhead> = kainowLetterhead;

  constructor(
    url: string,
    private readonly from: string,
    transport?: MailTransport,
  ) {
    this.transport = transport ?? createTransport(url);
  }

  /** Called once the app starts, so emails carry the organisation's name and logo for the 'email' place. */
  useLetterhead(source: () => Promise<Letterhead>): void {
    this.letterhead = source;
  }

  private async deliver(to: string, subject: string, body: string): Promise<void> {
    const m = composeEmail(await this.letterhead(), subject, body);
    await this.transport.sendMail({ from: this.from, to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments });
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

  async sendInvitation(email: string, link: string, projectName: string, role: string, expiresAt: Date): Promise<void> {
    await this.deliver(
      email,
      `You are invited to ${projectName} in Kainow`,
      `You have been invited to the project "${projectName}" in Kainow as ${role}.\n\n` +
        `Open this link, sign in with the code Kainow emails you, then accept or decline:\n${link}\n\n` +
        `The invitation expires on ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    );
  }

  async sendHoldAlert(email: string, projectName: string, link: string): Promise<void> {
    await this.deliver(
      email,
      `Kainow: action needed in ${projectName}`,
      `A member of the project "${projectName}" is On Hold and needs investigating.\n\n` +
        `Open the project's People tab to record a finding and restore or remove the membership:\n${link}`,
    );
  }

  async sendSetupInvitation(email: string, link: string, expiresAt: Date): Promise<void> {
    await this.deliver(
      email,
      'Set up Kainow',
      `You have been asked to set up Kainow as its first Enterprise Administrator.\n\n` +
        `Open this link and sign in with the code Kainow emails you; you will then set up your organisation:\n${link}\n\n` +
        `The link works once and expires on ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    );
  }

  async sendDelegatedClosureNotice(email: string, projectName: string, outcome: string, link: string): Promise<void> {
    await this.deliver(
      email,
      `${projectName} was closed by its Project Manager`,
      `The Project Manager closed the project "${projectName}" in Kainow, as you allowed, with the outcome ${outcome}.

` +
        `Open the project to see what was kept outstanding or left unresolved:
${link}`,
    );
  }
}

export function createCodeSender(delivery: CodeDelivery): CodeSender {
  return delivery.kind === 'smtp' ? new SmtpCodeSender(delivery.url, delivery.from) : new LogCodeSender();
}
