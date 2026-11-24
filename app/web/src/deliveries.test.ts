import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failuresFirst, lastDay } from './deliveries.ts';

const at = (hoursAgo: number) => new Date(Date.UTC(2026, 10, 24, 12) - hoursAgo * 3600 * 1000).toISOString();
const now = Date.UTC(2026, 10, 24, 12);

test('failed and uncertain emails come first, each group keeping its order', () => {
  const rows = [
    { id: 'a', status: 'sent', createdAt: at(1) },
    { id: 'b', status: 'failed', createdAt: at(2) },
    { id: 'c', status: 'queued', createdAt: at(3) },
    { id: 'd', status: 'uncertain', createdAt: at(4) },
  ];
  assert.deepEqual(failuresFirst(rows).map((r) => r.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c', 'd']);
});

test('the last 24 hours count sent, failed, uncertain and waiting emails, and ignore older ones', () => {
  const rows = [
    { status: 'sent', createdAt: at(1) },
    { status: 'sent', createdAt: at(23) },
    { status: 'sent', createdAt: at(25) },
    { status: 'failed', createdAt: at(5) },
    { status: 'failed', createdAt: at(30) },
    { status: 'uncertain', createdAt: at(6) },
    { status: 'retry_wait', createdAt: at(2) },
  ];
  assert.deepEqual(lastDay(rows, now), { sent: 2, failed: 1, uncertain: 1, waiting: 1, total: 5 });
  assert.deepEqual(lastDay([], now), { sent: 0, failed: 0, uncertain: 0, waiting: 0, total: 0 });
});
