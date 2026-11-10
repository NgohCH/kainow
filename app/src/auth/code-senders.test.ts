import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { createTransport } from '../email/transport';
import { EmailCodeSender, createCodeSender, LogCodeSender } from './code-senders';

const smtpSender = (url: string, from: string) => new EmailCodeSender(createTransport({ provider: 'smtp', url, from }, () => new Date()), from);

/** A bare-bones SMTP server that records each message it is given. */
function startSmtpServer(): Promise<{ port: number; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    socket.write('220 test ESMTP\r\n');
    let buffer = '';
    let inData = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 OK queued\r\n');
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250-test\r\n250 8BITMIME\r\n');
        else if (command === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ port, messages, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('the email sender delivers the code to the right person through a real SMTP exchange', async () => {
  const smtp = await startSmtpServer();
  try {
    const sender = smtpSender(`smtp://127.0.0.1:${smtp.port}/?ignoreTLS=true`, 'Kainow <no-reply@example.org>');
    await sender.send('person@example.org', '048213', 10);

    assert.equal(smtp.messages.length, 1);
    // Long lines are wrapped with "=" soft breaks in the message; join them back before matching.
    const message = smtp.messages[0].replace(/=\r\n/g, '');
    assert.match(message, /^From: Kainow <no-reply@example\.org>/m);
    assert.match(message, /^To: person@example\.org/m);
    assert.match(message, /^Subject: Your Kainow sign-in code/m);
    assert.match(message, /sign-in code is 048213\./);
    assert.match(message, /10 minutes/);
  } finally {
    await smtp.close();
  }
});

test('the email sender reports failure when the mail server cannot be reached', async () => {
  const sender = smtpSender('smtp://127.0.0.1:1/?ignoreTLS=true', 'a@example.org');
  await assert.rejects(sender.send('person@example.org', '123456', 10));
});

test('the Microsoft 365 setting also picks the email sender, so codes go through the same provider', () => {
  const m365 = { provider: 'm365', tenantId: 't', clientId: 'c', clientSecret: 's', from: 'kainow@example.org' } as const;
  assert.ok(createCodeSender(m365) instanceof EmailCodeSender);
});

test('the delivery setting picks the matching sender', () => {
  assert.ok(createCodeSender({ provider: 'log' }) instanceof LogCodeSender);
  assert.ok(createCodeSender({ provider: 'smtp', url: 'smtp://127.0.0.1:2525', from: 'a@example.org' }) instanceof EmailCodeSender);
});
