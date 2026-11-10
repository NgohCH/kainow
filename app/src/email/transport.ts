import { createTransport as nodemailerTransport } from 'nodemailer';
import type { Clock } from '../auth/tokens';
import type { EmailConfig } from '../config';
import type { ComposedEmail } from '../organisation/email';
import { M365TokenSource, TokenError } from './m365-token';

/** An attachment as stored with a composed email: base64, so the stored email is never rewritten. */
export type StoredAttachment = { filename: string; contentType: string; cid: string; contentBase64: string };

export type OutgoingEmail = { from: string; to: string; subject: string; text: string; html: string; attachments: StoredAttachment[] };

export interface MailTransport {
  send(m: OutgoingEmail): Promise<{ messageId: string | null }>;
}

export function storeAttachments(attachments: ComposedEmail['attachments']): StoredAttachment[] {
  return attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, cid: a.cid, contentBase64: a.content.toString('base64') }));
}

const CREDENTIALS = "The mail service rejected the sender's credentials";

/** A failure sorted for the retry rules. The reason is fixed readable text, never the underlying message (it can hold secrets). */
export class SendError extends Error {
  constructor(
    readonly kind: 'temporary' | 'permanent',
    readonly smtpCode: number | null,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'SendError';
  }
}

const TEMPORARY_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT']);

export function classify(err: unknown): SendError {
  if (err instanceof SendError) return err;
  if (err instanceof TokenError) {
    if (err.status === 0 || err.status === 429 || err.status >= 500) return new SendError('temporary', null, 'The Microsoft 365 sign-in service was unavailable');
    return new SendError('permanent', null, err.status === 400 || err.status === 401 ? CREDENTIALS : 'Microsoft 365 refused the request to send as this mailbox');
  }
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown };
  const smtpCode = typeof e.responseCode === 'number' ? e.responseCode : null;
  const code = typeof e.code === 'string' ? e.code : null;
  if (smtpCode === 535 || code === 'EAUTH') return new SendError('permanent', smtpCode, CREDENTIALS);
  if (smtpCode !== null) {
    if (smtpCode >= 400 && smtpCode < 500) return new SendError('temporary', smtpCode, 'The mail service could not take the message just now');
    if (smtpCode >= 500) return new SendError('permanent', smtpCode, 'The mail service refused the message or the address');
  }
  if (code === 'EENVELOPE') return new SendError('permanent', null, 'The mail service refused the message or the address');
  if (code !== null && TEMPORARY_CODES.has(code)) return new SendError('temporary', null, 'The mail service could not be reached');
  return new SendError('temporary', null, 'The message could not be sent');
}

type MailerLike = { sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }> };

export interface TransportDeps {
  fetch?: typeof fetch;
  /** Tests replace nodemailer. Gets a connection URL (smtp) or options (m365). */
  nodemailer?: (options: string | Record<string, unknown>) => MailerLike;
}

/** A slow send must end as a temporary failure well before the dispatcher's 10-minute uncertain threshold. */
export const SEND_TIMEOUT_MS = 2 * 60_000;
const TIMEOUTS = { connectionTimeout: SEND_TIMEOUT_MS, greetingTimeout: SEND_TIMEOUT_MS, socketTimeout: SEND_TIMEOUT_MS };

const addressOf = (from: string): string => /<([^>]+)>/.exec(from)?.[1] ?? from;

function toMessage(m: OutgoingEmail): Record<string, unknown> {
  return {
    from: m.from,
    to: m.to,
    subject: m.subject,
    text: m.text,
    html: m.html,
    attachments: m.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType, cid: a.cid })),
  };
}

export function createTransport(cfg: EmailConfig, clock: Clock, deps: TransportDeps = {}): MailTransport {
  const mailer = deps.nodemailer ?? ((o) => nodemailerTransport(o as never) as unknown as MailerLike);
  if (cfg.provider === 'log') {
    return {
      async send(m) {
        console.log(`[email, development only] to ${m.to}: ${m.subject}`);
        return { messageId: null };
      },
    };
  }
  if (cfg.provider === 'smtp') {
    const transport = mailer({ url: cfg.url, ...TIMEOUTS });
    return {
      async send(m) {
        const info = await transport.sendMail(toMessage(m));
        return { messageId: info?.messageId ?? null };
      },
    };
  }
  const tokens = new M365TokenSource(cfg, deps.fetch ?? fetch, clock);
  return {
    async send(m) {
      const accessToken = await tokens.token();
      const transport = mailer({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        requireTLS: true,
        ...TIMEOUTS,
        auth: { type: 'OAuth2', user: addressOf(cfg.from), accessToken },
      });
      const info = await transport.sendMail(toMessage(m));
      return { messageId: info?.messageId ?? null };
    },
  };
}
