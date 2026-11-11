import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupText } from './setup.ts';

test('a setup link keeps the setup wording', () => {
  const s = setupText('setup');
  assert.equal(s.heading, 'Set up Kainow');
  assert.equal(
    s.intro,
    'You are setting up Kainow as its first Enterprise Administrator. Sign in with the code Kainow emails you; you will then set up your organisation.',
  );
  assert.equal(s.message('used'), 'This setup link has been used. Sign in instead.');
  assert.equal(s.message('expired'), 'This setup link is no longer valid. Ask whoever installed Kainow to run the setup command again.');
  assert.equal(s.message('superseded'), 'This setup link is no longer valid. Ask whoever installed Kainow to run the setup command again.');
});

test('a recovery link says Administrator access is being restored, and who to ask when it has expired', () => {
  const s = setupText('recovery');
  assert.equal(s.intro, 'You are restoring Administrator access to Kainow. Sign in with the code Kainow emails you.');
  assert.equal(s.message('expired'), 'This link has expired. Ask your recovery custodian to run recover-admin again.');
  assert.equal(s.message('superseded'), 'This link has expired. Ask your recovery custodian to run recover-admin again.');
  assert.equal(s.message('used'), 'This setup link has been used. Sign in instead.');
});

test('an answer without a kind is treated as setup', () => {
  assert.deepEqual(setupText(undefined).intro, setupText('setup').intro);
});
