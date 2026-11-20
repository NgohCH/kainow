import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventText, resourceActions, lineDefaultFilter, overlapText, statusLabel, unitLabel, validateLineForm, type LineForm } from './resources.ts';

const TAIL = "This is not a booking. Arrange use with the resource's owner outside Kainow.";

test('overlapText: names, hidden projects, both, and none', () => {
  assert.equal(overlapText(null), null);
  assert.equal(overlapText({ named: [], others: 0 }), null);
  assert.equal(
    overlapText({ named: [{ projectId: 'a', name: 'Alpha' }], others: 0 }),
    `Also recorded by 1 other project in this period: Alpha. ${TAIL}`,
  );
  assert.equal(
    overlapText({ named: [{ projectId: 'a', name: 'Alpha' }, { projectId: 'b', name: 'Beta' }, { projectId: 'c', name: 'Gamma' }], others: 0 }),
    `Also recorded by 3 other projects in this period: Alpha, Beta and Gamma. ${TAIL}`,
  );
  assert.equal(
    overlapText({ named: [{ projectId: 'a', name: 'Alpha' }, { projectId: 'b', name: 'Beta' }], others: 2 }),
    `Also recorded by 4 other projects in this period: Alpha, Beta and 2 projects you can't see. ${TAIL}`,
  );
  assert.equal(overlapText({ named: [{ projectId: 'a', name: 'Alpha' }], others: 1 }), `Also recorded by 2 other projects in this period: Alpha and 1 project you can't see. ${TAIL}`);
  assert.equal(overlapText({ named: [], others: 3 }), `Also recorded by 3 other projects in this period: 3 projects you can't see. ${TAIL}`);
});

test('lineDefaultFilter hides Finished and Cancelled', () => {
  for (const s of ['needed', 'arranged', 'in_use'] as const) assert.equal(lineDefaultFilter(s), true);
  for (const s of ['finished', 'cancelled'] as const) assert.equal(lineDefaultFilter(s), false);
});

test('unit and status labels', () => {
  assert.equal(unitLabel('person_hours'), 'Person-hours');
  assert.equal(unitLabel('square_metres'), 'Square metres');
  assert.equal(unitLabel(null), '');
  assert.equal(statusLabel('in_use'), 'In use');
  assert.equal(statusLabel('cancelled'), 'Cancelled');
});

const ok: LineForm = { itemId: null, oneOffKind: 'equipment', description: 'Folding tables', quantity: '2', unit: 'items', startsOn: '2026-12-01', endsOn: '2026-12-05', neededBy: '', notes: '' };

test('validateLineForm uses the server messages', () => {
  assert.equal(validateLineForm(ok), null);
  assert.equal(validateLineForm({ ...ok, oneOffKind: null }), 'Choose a catalogue item or describe a one-off resource.');
  assert.equal(validateLineForm({ ...ok, itemId: 'x' }), 'Choose a catalogue item or describe a one-off resource.');
  assert.equal(validateLineForm({ ...ok, oneOffKind: 'room' }), 'Choose Equipment, Facility or Other.');
  assert.equal(validateLineForm({ ...ok, description: '  ' }), 'Enter a description of 1 to 200 characters.');
  assert.equal(validateLineForm({ ...ok, description: 'x'.repeat(201) }), 'Enter a description of 1 to 200 characters.');
  assert.equal(validateLineForm({ ...ok, itemId: '0190aaaa-0000-7000-8000-000000000001', oneOffKind: null, description: '' }), null);
  assert.equal(validateLineForm({ ...ok, unit: null }), 'Enter both a quantity and a unit, or neither.');
  assert.equal(validateLineForm({ ...ok, quantity: '' }), 'Enter both a quantity and a unit, or neither.');
  assert.equal(validateLineForm({ ...ok, quantity: '', unit: null }), null);
  for (const q of ['0', '0.00', '1.234', '-1', 'abc', '1,5']) assert.equal(validateLineForm({ ...ok, quantity: q }), 'Enter a quantity above 0 with at most 2 decimal places.');
  assert.equal(validateLineForm({ ...ok, unit: 'litres' }), 'Choose a unit from the list.');
  assert.equal(validateLineForm({ ...ok, startsOn: '1 Dec' }), 'Enter dates as YYYY-MM-DD.');
  assert.equal(validateLineForm({ ...ok, neededBy: '2026-02-30' }), 'Enter dates as YYYY-MM-DD.');
  assert.equal(validateLineForm({ ...ok, startsOn: '' }), 'Enter a start date for the period.');
  assert.equal(validateLineForm({ ...ok, endsOn: '2026-11-30' }), 'The end date cannot be before the start date.');
  assert.equal(validateLineForm({ ...ok, endsOn: '' }), null);
  assert.equal(validateLineForm({ ...ok, notes: 'n'.repeat(2001) }), 'Notes can be up to 2,000 characters.');
});

test('resourceActions: buttons by role and project status', () => {
  const a = (roles: string[], status = 'active') => resourceActions(roles, status);
  assert.deepEqual(a(['pm']), { editLines: true, recordSpending: true, proposeBudget: true, adjustSpending: true, readOnly: false });
  assert.deepEqual(a(['deputy_pm']), { editLines: true, recordSpending: true, proposeBudget: true, adjustSpending: true, readOnly: false });
  assert.deepEqual(a(['owner']), { editLines: true, recordSpending: false, proposeBudget: true, adjustSpending: false, readOnly: false });
  assert.deepEqual(a(['sponsor']), { editLines: true, recordSpending: false, proposeBudget: true, adjustSpending: false, readOnly: false });
  assert.deepEqual(a(['member']), { editLines: false, recordSpending: false, proposeBudget: false, adjustSpending: false, readOnly: false });
  assert.deepEqual(a([]), { editLines: false, recordSpending: false, proposeBudget: false, adjustSpending: false, readOnly: false });
  for (const s of ['deferred', 'closed']) assert.deepEqual(a(['pm', 'owner'], s), { editLines: false, recordSpending: false, proposeBudget: false, adjustSpending: false, readOnly: true });
});

test('eventText words the history', () => {
  assert.equal(eventText({ kind: 'created', reason: null, detail: { previous: null, next: { status: 'needed' } } }), 'Added');
  assert.equal(eventText({ kind: 'status_changed', reason: null, detail: { previous: { status: 'needed' }, next: { status: 'in_use' } } }), 'Status changed. Status: Needed → In use');
  assert.equal(
    eventText({ kind: 'cancelled', reason: 'No longer needed', detail: { previous: { status: 'needed' }, next: { status: 'cancelled' } } }),
    'Cancelled. Status: Needed → Cancelled. Reason: No longer needed',
  );
  assert.equal(eventText({ kind: 'edited', reason: null, detail: { previous: { quantity: '2.00', unit: 'items' }, next: { quantity: '3.00', unit: 'hours' } } }), 'Edited. Quantity: 2.00 → 3.00; Unit: Items → Hours');
});
