import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmailCodeSender } from '../auth/code-senders';
import { recoveryNoticeEmail } from '../email/messages';
import type { MailTransport } from '../email/transport';
import { composeEmail } from './email';
import { LetterheadWiring } from './letterhead-wiring';
import type { Letterhead, OrganisationProfileService } from './organisation.service';

const logo = { content: Buffer.from([1, 2, 3]), mime: 'image/png', box: { width: 120, height: 40 } };
const registered: Letterhead = { name: 'Example Organisation', registered: true, logo };

test('an email opens with the organisation name, carries its logo inline, and says who sent it', () => {
  const m = composeEmail(registered, 'Your Kainow sign-in code', 'Your code is 123456.\n\nIt works once.');
  assert.equal(m.subject, 'Your Kainow sign-in code');
  assert.equal(m.text, 'Example Organisation\n\nYour code is 123456.\n\nIt works once.\n\nSent by Kainow for Example Organisation.');
  assert.match(m.html, /<img src="cid:logo" width="120" height="40" alt="Example Organisation"/);
  assert.match(m.html, /<p>Your code is 123456\.<\/p>\s*<p>It works once\.<\/p>/);
  assert.match(m.html, /Sent by Kainow for Example Organisation\./);
  assert.deepEqual(m.attachments, [{ filename: 'logo.png', content: logo.content, contentType: 'image/png', cid: 'logo' }]);
});

test('before setup an email carries Kainow and its default logo', () => {
  const m = composeEmail({ name: 'Kainow', registered: false, logo }, 'Set up Kainow', 'Open the link.');
  assert.equal(m.text, 'Kainow\n\nOpen the link.\n\nSent by Kainow.');
  assert.match(m.html, /alt="Kainow"/);
});

test('names and text are escaped in the HTML part and left as they are in the text part', () => {
  const m = composeEmail({ ...registered, name: 'A <b>&</b> "B"' }, 'S', 'Line <script>x</script>\nnext line');
  assert.ok(m.text.startsWith('A <b>&</b> "B"\n\n'));
  assert.ok(!m.html.includes('<script>'));
  assert.match(m.html, /A &lt;b&gt;&amp;&lt;\/b&gt; &quot;B&quot;/);
  assert.match(m.html, /Line &lt;script&gt;x&lt;\/script&gt;<br>next line/);
});

test('the SMTP sender sends every email through the letterhead, and Kainow defaults with none attached', async () => {
  const sent: Record<string, unknown>[] = [];
  const transport: MailTransport = { send: async (m) => (sent.push({ ...m }), { messageId: null }) };
  const sender = new EmailCodeSender(transport, 'kainow@example.org');
  await sender.sendSetupInvitation('first@example.org', 'http://localhost:3000/#/setup/t', new Date(Date.UTC(2026, 10, 16)));
  assert.equal(sent[0].from, 'kainow@example.org');
  assert.match(String(sent[0].text), /^Kainow\n\n/);
  assert.match(String(sent[0].text), /Sent by Kainow\.$/);
  sender.useLetterhead(async () => registered);
  await sender.send('a@example.org', '123456', 10);
  for (const m of sent.slice(1)) {
    assert.match(String(m.text), /^Example Organisation\n\n/);
    assert.match(String(m.html), /cid:logo/);
    assert.equal((m.attachments as unknown[]).length, 1);
  }
});

test('when the app starts, the email sender is given the letterhead for the email place', async () => {
  let source: (() => Promise<Letterhead>) | undefined;
  const sender = { useLetterhead: (s: () => Promise<Letterhead>) => (source = s) } as unknown as ConstructorParameters<typeof LetterheadWiring>[0];
  const places: string[] = [];
  const organisation = { letterhead: async (place: string) => (places.push(place), registered) } as unknown as OrganisationProfileService;
  new LetterheadWiring(sender, organisation).onModuleInit();
  assert.deepEqual(await source?.(), registered);
  assert.deepEqual(places, ['email']);
});

test('the setup and recovery invitations each have their own wording', async () => {
  const sent: Array<{ subject: string; text: string }> = [];
  const transport: MailTransport = { send: async (m) => (sent.push({ subject: String(m.subject), text: String(m.text) }), { messageId: null }) };
  const sender = new EmailCodeSender(transport, 'kainow@example.org');
  const expires = new Date(Date.UTC(2026, 10, 16, 2, 0));
  await sender.sendSetupInvitation('first@example.org', 'http://localhost:3000/#/setup/t', expires);
  await sender.sendSetupInvitation('first@example.org', 'http://localhost:3000/#/setup/t', expires, 'setup');
  await sender.sendSetupInvitation('back@example.org', 'http://localhost:3000/#/setup/r', expires, 'recovery');
  assert.equal(sent[0].subject, 'Set up Kainow');
  assert.deepEqual(sent[1], sent[0], 'setup is the default');
  assert.equal(sent[2].subject, 'Restore your Kainow Administrator access');
  assert.ok(
    sent[2].text.includes(
      'Kainow Administrator access is being restored for you. Open this link and sign in with the code Kainow emails you; you will then be an Enterprise Administrator:\n' +
        'http://localhost:3000/#/setup/r\n\n' +
        "The link works once and expires on 2026-11-16 02:00 UTC. If you did not expect this, contact your organisation's recovery custodian.",
    ),
    sent[2].text,
  );
});

test('the notice to a disabled Administrator gives the time in UTC+8 and the reason, and nothing else', () => {
  const m = recoveryNoticeEmail(new Date(Date.UTC(2026, 10, 9, 2, 0)), 'Both locked out');
  assert.equal(m.subject, 'Your Kainow Administrator access was disabled');
  assert.equal(
    m.body,
    'Your Kainow Administrator account was disabled on Mon 9 Nov 2026, 10:00 (UTC+8) so that Administrator access could be restored. ' +
      "Reason given: Both locked out. If you did not expect this, contact your organisation's recovery custodian.",
  );
});
