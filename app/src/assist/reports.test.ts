import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReportOutput } from './prompts';
import { REPORT_SECTIONS, type ReportRecords, assembleDraft, renderFacts } from './reports';

const P = '0190a000-0000-7000-8000-000000000001';
const period = { from: '2026-11-02', to: '2026-11-15' };

function records(over: Partial<ReportRecords> = {}): ReportRecords {
  return { projectId: P, tasks: [], decisions: [], questions: [], risks: [], riskChanges: [], ...over };
}

const task = (id: string, title: string, dueOn: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  assignee: 'Ada Lim',
  dueOn,
  status,
  authorisedAt: new Date('2026-10-01T02:00:00Z'),
  completedAt: null,
  ...extra,
});

describe('report drafts (pure)', () => {
  test('sections are exactly spec 6.1', () => {
    assert.deepEqual(REPORT_SECTIONS.status, [
      'Summary',
      'Progress',
      'Overdue and blocked',
      'Due in the next 14 days',
      'Recent decisions',
      'Open questions',
      'Significant risks',
    ]);
    assert.deepEqual(REPORT_SECTIONS.specification, ['Purpose', 'Scope', 'Requirements', 'Constraints', 'Open questions', 'Decisions referenced']);
    assert.deepEqual(REPORT_SECTIONS.free_form, ['Draft']);
  });

  test('status report facts list overdue tasks with assignee and UTC+8 due date', () => {
    const facts = renderFacts(
      'status',
      records({
        tasks: [
          task('0190a000-0000-7000-8000-0000000000a1', 'Replace the pump seal', '2026-11-14', 'in_progress'),
          task('0190a000-0000-7000-8000-0000000000a2', 'Order filters', '2026-11-20', 'not_started'),
          task('0190a000-0000-7000-8000-0000000000a3', 'Paint the fence', '2026-12-30', 'blocked'),
          task('0190a000-0000-7000-8000-0000000000a4', 'Old finished job', '2026-11-01', 'completed'),
        ],
        // Authorised at 01:30 on 15 November in UTC+8 (17:30 UTC the day before): inside the period, shown as the 15th.
        decisions: [{ id: '0190a000-0000-7000-8000-0000000000d1', statement: 'Use the north gate', status: 'active', authorisedAt: new Date('2026-11-14T17:30:00Z') }],
      }),
      period,
    );
    const overdue = facts['Overdue and blocked'];
    assert.match(overdue, /\| \[Replace the pump seal\]\(#\/projects\/[^)]+\/work\/0190a000-0000-7000-8000-0000000000a1\) \| Ada Lim \| 2026-11-14 \| In progress \|/);
    assert.match(overdue, /Paint the fence/, 'blocked tasks are listed');
    assert.doesNotMatch(overdue, /Order filters|Old finished job/);
    const due = facts['Due in the next 14 days'];
    assert.match(due, /Order filters.*2026-11-20/);
    assert.doesNotMatch(due, /Replace the pump seal/);
    assert.match(facts['Recent decisions'], /Use the north gate.*2026-11-15/);
    assert.match(facts.Summary, /1 overdue/);
  });

  test('AI never supplies facts: facts come from records even if narrative disagrees', () => {
    const facts = renderFacts('status', records({ tasks: [task('0190a000-0000-7000-8000-0000000000a1', 'Replace the pump seal', '2026-11-14', 'in_progress')] }), period);
    const narrative: ReportOutput = {
      sections: [
        { section: 'Overdue and blocked', markdown: 'Nothing is overdue; the seal was done by Ben on 1 January [P1].', cited: ['P1'] },
        { section: 'Invented section', markdown: 'Should not appear.', cited: [] },
      ],
    };
    const body = assembleDraft(
      { title: 'Weekly status', kind: 'status', period, requester: 'Ada Lim', date: '2026-11-15' },
      facts,
      narrative,
      [{ marker: 'P1', location: 'Site notes — Paragraph 2', href: '#/notes/x' }],
    );
    const section = body.slice(body.indexOf('## Overdue and blocked'), body.indexOf('## Due in the next 14 days'));
    // Kainow's table comes first, from the record, whatever the AI wrote after it.
    assert.ok(section.indexOf('| Ada Lim | 2026-11-14 | In progress |') < section.indexOf('Nothing is overdue'), section);
    assert.ok(!body.includes('Invented section') && !body.includes('Should not appear'));
    assert.match(body, /^# Weekly status\n/);
    assert.match(body, /Drafted by AI for Ada Lim on 2026-11-15/);
    assert.match(body, /Period: 2026-11-02 to 2026-11-15/);
    for (const s of REPORT_SECTIONS.status) assert.ok(body.includes(`## ${s}\n`), s);
  });

  test('footnote links render for each cited marker', () => {
    const body = assembleDraft(
      { title: 'Pump spec', kind: 'specification', period: null, requester: 'Ada Lim', date: '2026-11-15' },
      {},
      { sections: [{ section: 'Purpose', markdown: 'Keep the pump running [P1][P3] and [P1, P3].', cited: ['P1', 'P3'] }] },
      [
        { marker: 'P1', location: 'Pump notes — Paragraph 1', href: '#/notes/a' },
        { marker: 'P2', location: 'Not cited', href: '#/notes/b' },
        { marker: 'P3', location: 'Plant thread — Message 4', href: '#/projects/p/threads/t?m=4' },
      ],
    );
    assert.match(body, /Keep the pump running \[\^P1\]\[\^P3\] and \[\^P1\]\[\^P3\]\./);
    assert.match(body, /## Sources\n\n\[\^P1\]: \[Pump notes — Paragraph 1\]\(#\/notes\/a\)\n\[\^P3\]: \[Plant thread — Message 4\]\(#\/projects\/p\/threads\/t\?m=4\)/);
    assert.ok(!body.includes('Not cited'), 'only cited sources are listed');
    assert.ok(!body.includes('Period:'), 'no period line without a period');
  });
});
