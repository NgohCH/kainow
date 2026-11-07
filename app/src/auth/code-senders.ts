import { createTransport } from 'nodemailer';
import type { CodeDelivery } from '../config';
import type { CodeSender } from './tokens';

/** Local development only: writes the code to the server log. Refused unless LOG_SIGN_IN_CODES=true. */
export class LogCodeSender implements CodeSender {
  async send(email: string, code: string, validForMinutes: number): Promise<void> {
    console.log(`[sign-in code, development only] ${email}: ${code} (valid ${validForMinutes} minutes)`);
  }
}

/** Sends the code by email. This is the only email the MVP sends; other email is deferred. */
export class SmtpCodeSender implements CodeSender {
  private readonly transport;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(url);
  }

  async send(email: string, code: string, validForMinutes: number): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: email,
      subject: 'Your Kainow sign-in code',
      text:
        `Your Kainow sign-in code is ${code}.\n\n` +
        `It works once and is valid for ${validForMinutes} minutes. ` +
        'If you did not ask to sign in, you can ignore this email.',
    });
  }
}

export function createCodeSender(delivery: CodeDelivery): CodeSender {
  return delivery.kind === 'smtp' ? new SmtpCodeSender(delivery.url, delivery.from) : new LogCodeSender();
}
