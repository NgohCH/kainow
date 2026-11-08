import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARCHIVE_AFTER_MONTHS, archiveState } from './archive';

const closed = (closedOn: string, today: string, events: Array<{ kind: 'archived' | 'unarchived'; at: string }> = []) =>
  archiveState({ status: 'closed', closedOn, events, today });

test('archived twelve months after closing, in UTC+8', () => {
  assert.equal(ARCHIVE_AFTER_MONTHS, 12);
  assert.deepEqual(closed('2026-11-09', '2027-11-08'), { archived: false, automatic: false });
  assert.deepEqual(closed('2026-11-09', '2027-11-09'), { archived: true, automatic: true });
  assert.deepEqual(closed('2027-01-31', '2028-01-30'), { archived: false, automatic: false });
  assert.deepEqual(closed('2027-01-31', '2028-01-31'), { archived: true, automatic: true });
  assert.deepEqual(closed('2028-02-29', '2029-02-28'), { archived: true, automatic: true }, 'clamped to the last day of February');
  assert.deepEqual(archiveState({ status: 'active', closedOn: null, events: [], today: '2030-01-01' }), { archived: false, automatic: false });
});

test('manual archive and unarchive', () => {
  assert.deepEqual(closed('2026-11-09', '2026-11-10', [{ kind: 'archived', at: '2026-11-10' }]), { archived: true, automatic: false });
  assert.deepEqual(closed('2026-11-09', '2027-12-01', [{ kind: 'unarchived', at: '2027-11-20' }]), { archived: false, automatic: false });
  assert.deepEqual(
    closed('2026-11-09', '2026-11-12', [{ kind: 'archived', at: '2026-11-10' }, { kind: 'unarchived', at: '2026-11-11' }]),
    { archived: false, automatic: false },
  );
  assert.deepEqual(closed('2026-11-09', '2026-11-12', [{ kind: 'archived', at: '2026-01-10' }]), { archived: false, automatic: false }, 'events before the latest closing are ignored');
});
