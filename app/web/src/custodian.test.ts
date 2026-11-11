import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUSTODIAN_HELP, custodianError } from './custodian.ts';

test('custodianError asks for both fields and limits each to 200 characters', () => {
  assert.equal(custodianError('Casey', 'c@example.org'), null);
  assert.equal(custodianError('  ', 'c@example.org'), "Give the custodian's name and how to reach them.");
  assert.equal(custodianError('Casey', ''), "Give the custodian's name and how to reach them.");
  assert.equal(custodianError('x'.repeat(201), 'c'), 'The name and the contact can each be at most 200 characters.');
  assert.equal(custodianError('  ' + 'x'.repeat(200) + ' ', 'c'), null, 'counted after trimming');
});

test('the explanation line names the INSTALL.md section', () => {
  assert.equal(CUSTODIAN_HELP, 'The person who can restore Administrator access if every Administrator is locked out. See INSTALL.md: Recovery custodian.');
});
