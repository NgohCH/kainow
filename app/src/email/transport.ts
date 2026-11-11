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
  /** At most this many messages per rolling minute from one dispatcher process; unset means unpaced. */
  readonly perMinute?: number;
}

/**
 * Exchange Online's per-mailbox message rate limit (30 messages a minute). The Microsoft 365 transport is paced to it;
 * the SMTP and log transports are not paced.
 */
export const M365_MESSAGES_PER_MINUTE = 30;

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
const THROTTLED = 'The mail service is limiting how many messages can be sent just now';

/**
 * Whether a 5xx reply is in fact a sending-rate or quota limit (Exchange Online answers these with 5xx codes). Only
 * the enhanced status and fixed markers are looked for; the reply text itself is never kept.
 */
function throttled(reply: string): boolean {
  return /SubmissionQuotaExceeded/i.test(reply) || /\b4\.4\.2\b/.test(reply) || /\b5\.2\.0\b.*quota/i.test(reply) || /throttl/i.test(reply);
}

export function classify(err: unknown): SendError {
  if (err instanceof SendError) return err;
  if (err instanceof TokenError) {
    if (err.status === 0 || err.status === 429 || err.status >= 500) return new SendError('temporary', null, 'The Microsoft 365 sign-in service was unavailable');
    return new SendError('permanent', null, err.status === 400 || err.status === 401 ? CREDENTIALS : 'Microsoft 365 refused the request to send as this mailbox');
  }
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown; response?: unknown };
  const smtpCode = typeof e.responseCode === 'number' ? e.responseCode : null;
  const code = typeof e.code === 'string' ? e.code : null;
  if (smtpCode === 535 || code === 'EAUTH') return new SendError('permanent', smtpCode, CREDENTIALS);
  if (smtpCode !== null) {
    // 421, 432 and 450-452 among them: the service asks us to try again later.
    if (smtpCode >= 400 && smtpCode < 500) return new SendError('temporary', smtpCode, 'The mail service could not take the message just now');
    if (smtpCode >= 500 && typeof e.response === 'string' && throttled(e.response)) return new SendError('temporary', smtpCode, THROTTLED);
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
  /** Where the log provider writes (console.log unless a test replaces it). */
  print?: (line: string) => void;
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
    const print = deps.print ?? ((line: string) => console.log(line));
    return {
      async send(m) {
        // Development only (LOG_SIGN_IN_CODES=true): the text body is printed so local invitation links can be followed.
        print(`[email, development only] to ${m.to}: ${m.subject}\n${m.text}`);
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
    perMinute: M365_MESSAGES_PER_MINUTE,
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
