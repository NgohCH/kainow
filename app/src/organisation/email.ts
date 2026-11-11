import type { Letterhead } from './organisation.service';

export type ComposedEmail = {
  subject: string;
  text: string;
  html: string;
  attachments: { filename: string; content: Buffer; contentType: string; cid: 'logo' }[];
};

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * One email in two parts: plain text that opens with the organisation name, and HTML with the logo embedded inline.
 * Both end by saying who sent it. Before setup the letterhead is Kainow's own.
 */
export function composeEmail(letterhead: Letterhead, subject: string, body: string): ComposedEmail {
  const closing = letterhead.registered ? `Sent by Kainow for ${letterhead.name}.` : 'Sent by Kainow.';
  const text = `${letterhead.name}\n\n${body}\n\n${closing}`;
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const { width, height } = letterhead.logo.box;
  const name = escape(letterhead.name);
  const html =
    `<!doctype html><html><body style="font-family: Arial, sans-serif; color: #1c2a2e;">\n` +
    `<table role="presentation" style="border-bottom: 1px solid #d3d1c7; padding-bottom: 8px; margin-bottom: 16px;"><tr>` +
    `<td><img src="cid:logo" width="${width}" height="${height}" alt="${name}" style="object-fit: contain;"></td>` +
    `<td style="padding-left: 12px; font-weight: bold;">${name}</td></tr></table>\n` +
    `${paragraphs}\n` +
    `<p style="color: #5f5e5a; font-size: 12px; margin-top: 24px;">${escape(closing)}</p>\n</body></html>`;
  const extension = letterhead.logo.mime === 'image/jpeg' ? 'jpg' : 'png';
  return { subject, text, html, attachments: [{ filename: `logo.${extension}`, content: letterhead.logo.content, contentType: letterhead.logo.mime, cid: 'logo' }] };
}
