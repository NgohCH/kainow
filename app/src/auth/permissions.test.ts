import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIONS, can } from './permissions';

test('the action list has no duplicates and no blank names', () => {
  assert.equal(new Set(ACTIONS).size, ACTIONS.length);
  for (const action of ACTIONS) {
    assert.match(action, /^[a-z]+(\.[a-z]+)+$/);
  }
});

test('every action is allowed for the Enterprise Administrator', () => {
  for (const action of ACTIONS) {
    assert.equal(can('enterprise_administrator', action), true, `${action} should be allowed`);
  }
});

test('every action is denied for an unknown, missing or empty role', () => {
  for (const action of ACTIONS) {
    for (const role of ['guest', 'project_manager', '', undefined, null, 'ENTERPRISE_ADMINISTRATOR']) {
      assert.equal(can(role, action), false, `${action} should be denied for ${String(role)}`);
    }
  }
});

test('role names that are object properties are not treated as roles', () => {
  for (const role of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(can(role, 'user.manage'), false);
  }
});

test('an action that is not in the catalogue is denied even for the administrator', () => {
  for (const action of ['', 'user.delete', 'purge.everything', 'USER.MANAGE']) {
    assert.equal(can('enterprise_administrator', action), false);
  }
});
