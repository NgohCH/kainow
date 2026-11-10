import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../testing/fakes';
import { M365TokenSource, TokenError } from './m365-token';
import { M365_MESSAGES_PER_MINUTE, SendError, classify, createTransport, type StoredAttachment } from './transport';

const cfg = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-value-xyz' };

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fn, calls };
}

test('the token source asks Microsoft once and reuses the token until five minutes before it expires', async () => {
  const clock = new FakeClock(Date.UTC(2026, 10, 10, 0, 0, 0));
  const f = fakeFetch([
    { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } },
    { status: 200, body: { access_token: 'tok-2', expires_in: 3600 } },
  ]);
  const source = new M365TokenSource(cfg, f.fn, clock.now);
  assert.equal(await source.token(), 'tok-1');
  clock.advanceMinutes(54);
  assert.equal(await source.token(), 'tok-1');
  assert.equal(f.calls.length, 1);

  const call = f.calls[0];
  assert.equal(call.url, 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
  assert.equal(call.init.method, 'POST');
  const form = new URLSearchParams(String(call.init.body));
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), 'https://outlook.office365.com/.default');
  assert.equal(form.get('client_id'), 'client-1');

  clock.advanceMinutes(2); // 56 minutes: inside the last five
  assert.equal(await source.token(), 'tok-2');
  assert.equal(f.calls.length, 2);
});

test('a refused token request throws an error with the HTTP status and no secret', async () => {
  const f = fakeFetch([{ status: 401, body: { error: 'invalid_client', error_description: 'secret-value-xyz is wrong' } }]);
  const source = new M365TokenSource(cfg, f.fn, () => new Date(0));
  await assert.rejects(source.token(), (err: unknown) => {
    assert.ok(err instanceof TokenError);
    assert.equal(err.status, 401);
    assert.ok(!err.message.includes('secret-value-xyz'));
    return true;
  });
});

test('classify sorts failures into temporary and permanent with readable reasons', () => {
  const smtp = (responseCode: number) => Object.assign(new Error('x'), { responseCode });
  const code = (c: string) => Object.assign(new Error('x'), { code: c });
  const rows: [unknown, 'temporary' | 'permanent', number | null][] = [
    [smtp(421), 'temporary', 421],
    [smtp(450), 'temporary', 450],
    [code('ETIMEDOUT'), 'temporary', null],
    [code('ECONNECTION'), 'temporary', null],
    [code('ESOCKET'), 'temporary', null],
    [smtp(550), 'permanent', 550],
    [smtp(535), 'permanent', 535],
    [code('EAUTH'), 'permanent', null],
    [new TokenError(400), 'permanent', null],
    [new TokenError(401), 'permanent', null],
    [new TokenError(500), 'temporary', null],
    [new TokenError(0), 'temporary', null],
    [new Error('something odd'), 'temporary', null],
  ];
  for (const [err, kind, smtpCode] of rows) {
    const c = classify(err);
    assert.ok(c instanceof SendError);
    assert.equal(c.kind, kind, String((err as Error).message));
    assert.equal(c.smtpCode, smtpCode);
    assert.notEqual(c.reason, '');
  }
  assert.equal(classify(smtp(535)).reason, "The mail service rejected the sender's credentials");
  assert.equal(classify(code('EAUTH')).reason, "The mail service rejected the sender's credentials");
  assert.equal(classify(new TokenError(401)).reason, "The mail service rejected the sender's credentials");
  const own = new SendError('permanent', 550, 'r');
  assert.equal(classify(own), own);
});

test('a reason never repeats the underlying error text', () => {
  const c = classify(Object.assign(new Error('smtp://user:hunter2@mail.example.org refused'), { responseCode: 550 }));
  assert.ok(!c.reason.includes('hunter2'));
  assert.ok(!c.message.includes('hunter2'));
});

const attachments: StoredAttachment[] = [{ filename: 'logo.png', contentType: 'image/png', cid: 'logo', contentBase64: Buffer.from([1, 2, 3]).toString('base64') }];

test('the Microsoft 365 transport sends through smtp.office365.com with the cached OAuth2 token', async () => {
  const clock = new FakeClock(Date.UTC(2026, 10, 10));
  const f = fakeFetch([{ status: 200, body: { access_token: 'tok-1', expires_in: 3600 } }]);
  const created: Record<string, any>[] = [];
  const sent: Record<string, any>[] = [];
  const transport = createTransport({ provider: 'm365', ...cfg, from: 'Kainow <kainow@example.org>' }, clock.now, {
    fetch: f.fn,
    nodemailer: (o) => (
      created.push(o as Record<string, any>),
      { sendMail: async (m: Record<string, any>) => (sent.push(m), { messageId: '<id-1@example.org>' }) }
    ),
  });
  const message = { from: 'Kainow <kainow@example.org>', to: 'a@example.org', subject: 'S', text: 'T', html: '<p>T</p>', attachments };
  assert.deepEqual(await transport.send(message), { messageId: '<id-1@example.org>' });
  await transport.send(message);

  assert.equal(f.calls.length, 1);
  assert.equal(created.length, 2);
  assert.deepEqual(created[0], {
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    requireTLS: true,
    connectionTimeout: 120_000,
    greetingTimeout: 120_000,
    socketTimeout: 120_000,
    auth: { type: 'OAuth2', user: 'kainow@example.org', accessToken: 'tok-1' },
  });
  assert.equal(sent[0].to, 'a@example.org');
  assert.deepEqual(sent[0].attachments[0].content, Buffer.from([1, 2, 3]));
  assert.equal(sent[0].attachments[0].cid, 'logo');
});

test('the SMTP transport hands the URL to nodemailer and the log transport sends nothing', async () => {
  let given: unknown;
  const smtp = createTransport({ provider: 'smtp', url: 'smtp://u:p@mail.example.org:587', from: 'a@example.org' }, () => new Date(), {
    nodemailer: (o) => ((given = o), { sendMail: async () => ({}) }),
  });
  assert.deepEqual(await smtp.send({ from: 'a@example.org', to: 'b@example.org', subject: 's', text: 't', html: 'h', attachments: [] }), { messageId: null });
  assert.deepEqual(given, { url: 'smtp://u:p@mail.example.org:587', connectionTimeout: 120_000, greetingTimeout: 120_000, socketTimeout: 120_000 });

  const log = createTransport({ provider: 'log' }, () => new Date());
  assert.deepEqual(await log.send({ from: 'x', to: 'b@example.org', subject: 's', text: 't', html: 'h', attachments: [] }), { messageId: null });
});

test('concurrent token requests share a single fetch', async () => {
  const f = fakeFetch([{ status: 200, body: { access_token: 'tok-1', expires_in: 3600 } }]);
  const source = new M365TokenSource(cfg, f.fn, () => new Date(0));
  const tokens = await Promise.all([source.token(), source.token(), source.token()]);
  assert.deepEqual(tokens, ['tok-1', 'tok-1', 'tok-1']);
  assert.equal(f.calls.length, 1);
});

test('a token request that hangs is aborted and becomes a temporary failure', async () => {
  const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;
  const source = new M365TokenSource(cfg, hanging, () => new Date(0), 20);
  await assert.rejects(source.token(), (err: unknown) => {
    assert.ok(err instanceof TokenError);
    assert.equal(err.status, 0);
    assert.equal(classify(err).kind, 'temporary');
    return true;
  });
});

test('throttling replies are temporary; other 5xx replies stay permanent; the reply text is never kept', () => {
  const reply = (responseCode: number, response: string) => Object.assign(new Error(response), { responseCode, response });
  const rows: [unknown, 'temporary' | 'permanent'][] = [
    [reply(421, '421 4.7.0 Try again later'), 'temporary'],
    [reply(432, '432 4.7.12 A password transition is needed'), 'temporary'],
    [reply(450, '450 4.2.1 Mailbox busy'), 'temporary'],
    [reply(451, '451 4.4.2 Timeout'), 'temporary'],
    [reply(452, '452 4.5.3 Too many recipients'), 'temporary'],
    [reply(554, '554 5.2.0 STOREDRV.Submission.Exception:SubmissionQuotaExceededException; Failed to process message'), 'temporary'],
    [reply(550, '550 5.2.0 Message rejected: sending quota exceeded for this mailbox'), 'temporary'],
    [reply(554, '554 4.4.2 Connection dropped'), 'temporary'],
    [reply(550, '550 5.7.1 Message throttled: too many messages'), 'temporary'],
    [reply(550, '550 5.1.1 User unknown'), 'permanent'],
    [reply(554, '554 5.2.0 Message could not be delivered'), 'permanent'],
    [reply(535, '535 5.7.3 Authentication unsuccessful, throttled'), 'permanent'],
  ];
  for (const [err, kind] of rows) {
    const c = classify(err);
    assert.equal(c.kind, kind, (err as Error).message);
    assert.ok(!c.reason.includes('SubmissionQuota') && !c.message.includes('STOREDRV') && !c.reason.includes('User unknown'));
  }
  assert.equal(classify(reply(554, '554 5.2.0 SubmissionQuotaExceeded')).smtpCode, 554);
});

test('only the Microsoft 365 transport is paced, at the one constant', () => {
  assert.equal(M365_MESSAGES_PER_MINUTE, 30);
  const m365 = createTransport({ provider: 'm365', ...cfg, from: 'Kainow <kainow@example.org>' }, () => new Date(), { fetch: fakeFetch([]).fn });
  assert.equal(m365.perMinute, M365_MESSAGES_PER_MINUTE);
  const smtp = createTransport({ provider: 'smtp', url: 'smtp://u:p@mail.example.org:587', from: 'a@example.org' }, () => new Date(), {
    nodemailer: () => ({ sendMail: async () => ({}) }),
  });
  assert.equal(smtp.perMinute, undefined);
  assert.equal(createTransport({ provider: 'log' }, () => new Date()).perMinute, undefined);
});

test('the log transport (development only) prints the recipient, subject and text body, so local invitation links can be followed', async () => {
  const lines: string[] = [];
  const log = createTransport({ provider: 'log' }, () => new Date(), { print: (l) => lines.push(l) });
  await log.send({ from: 'x', to: 'b@example.org', subject: 'You are invited', text: 'Open http://localhost:5173/#/invitations/abc', html: '<p>h</p>', attachments: [] });
  const out = lines.join('\n');
  assert.ok(out.includes('b@example.org'));
  assert.ok(out.includes('You are invited'));
  assert.ok(out.includes('Open http://localhost:5173/#/invitations/abc'));
  assert.ok(!out.includes('<p>h</p>'));
});
