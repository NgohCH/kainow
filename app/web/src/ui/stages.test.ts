import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTemplateDraft } from './stages.ts';

const GENERAL = {
  name: 'General',
  stages: [
    { name: 'Initiation', substages: ['Define Purpose', 'Identify Participants'] },
    { name: 'Planning', substages: [] },
    { name: 'Closure', substages: ['Close Project'] },
  ],
};

test('a sound template has nothing to fix', () => {
  assert.deepEqual(validateTemplateDraft(GENERAL), []);
});

test('an empty or too long name is refused', () => {
  assert.equal(validateTemplateDraft({ ...GENERAL, name: '  ' }).length, 1);
  assert.match(validateTemplateDraft({ ...GENERAL, name: 'x'.repeat(81) })[0], /1 to 80/);
  assert.deepEqual(validateTemplateDraft({ ...GENERAL, name: 'x'.repeat(80) }), []);
});

test('a template needs a stage, and at most 20', () => {
  assert.match(validateTemplateDraft({ name: 'A', stages: [] })[0], /at least one stage/);
  const many = Array.from({ length: 21 }, (_, i) => ({ name: `S${i}`, substages: [] }));
  assert.match(validateTemplateDraft({ name: 'A', stages: many })[0], /at most 20 stages/);
  assert.deepEqual(validateTemplateDraft({ name: 'A', stages: many.slice(0, 20) }), []);
});

test('stage names must differ, ignoring case; so must substage names', () => {
  const dup = validateTemplateDraft({ name: 'A', stages: [{ name: 'Plan', substages: [] }, { name: ' plan ', substages: [] }] });
  assert.match(dup[0], /appears twice/);
  const sub = validateTemplateDraft({ name: 'A', stages: [{ name: 'Plan', substages: ['Scope', 'SCOPE'] }] });
  assert.match(sub[0], /repeats one/);
});

test('every stage and substage needs a name', () => {
  assert.match(validateTemplateDraft({ name: 'A', stages: [{ name: '', substages: [] }] })[0], /each stage a name/);
  assert.match(validateTemplateDraft({ name: 'A', stages: [{ name: 'P', substages: [''] }] })[0], /each substage a name/);
});
