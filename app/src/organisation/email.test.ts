import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmtpCodeSender } from '../auth/code-senders';
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
  const transport = { sendMail: async (m: Record<string, unknown>) => void sent.push(m) };
  const sender = new SmtpCodeSender('smtp://unused', 'kainow@example.org', transport);
  await sender.sendSetupInvitation('first@example.org', 'http://localhost:3000/#/setup/t', new Date(Date.UTC(2026, 10, 16)));
  assert.equal(sent[0].from, 'kainow@example.org');
  assert.match(String(sent[0].text), /^Kainow\n\n/);
  assert.match(String(sent[0].text), /Sent by Kainow\.$/);
  sender.useLetterhead(async () => registered);
  await sender.send('a@example.org', '123456', 10);
  await sender.sendInvitation('a@example.org', 'http://x', 'P', 'Member', new Date());
  await sender.sendHoldAlert('a@example.org', 'P', 'http://x');
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
