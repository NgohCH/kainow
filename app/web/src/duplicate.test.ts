import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type DupState, type Offer, REPLACED, blockedReason, buildBody, notCarriedReason, replacedOf, readRefusal, loadedAgain, purposeUnchanged, startPage, carriedTexts, chooseAllTasks, chooseTask, confirmText, copiedFromText, findIn, mergeOffer, parseDuplicateHash, problemsOf, refusalPart,
  startState, takeOutUnavailable, termParts, termsOf, withServerTerms,
} from './duplicate.ts';

const P = '00000000-0000-4000-8000-000000000001';
const offer = (over: Partial<Offer> = {}): Offer => ({
  asOf: '2026-11-25T00:00:00.000Z~0:0:0',
  original: {
    id: P, name: 'Harbour survey 2026', purpose: 'Survey the harbour for Example Customer.', purposeKey: 'purpose', plannedEnd: '2026-12-31',
    owningDepartment: { id: 'd1', name: 'Surveys', retired: false }, contributingDepartments: [],
  },
  stages: [{ id: 's1', key: 'stage:s1', name: 'Start', substages: [{ key: 'stage:s1:substage:0', name: 'Prepare' }, { key: 'stage:s1:substage:1', name: 'Kick off' }] }],
  holidays: [{ id: 'h1', key: 'holiday:h1', date: '2026-12-25', name: 'Closing day' }],
  settings: {
    requiredApprovals: null,
    notifications: { dayCounting: null, weekdays: null, leadDays: null, escalationDays: null, digestEnabled: false, digestFrequency: null, digestWeekday: null, digestTime: null },
    outputs: { inputFormats: null, outputFormats: null, exportRoles: ['pm', 'deputy', 'owner', 'sponsor'] },
    notCarried: [],
  },
  mayChange: { calendar: true, timings: true, digest: true, formats: true, exportRoles: true },
  tasks: [
    {
      id: 't1', title: 'Plan 2026 work', titleKey: 'task:t1:title', description: 'For Example  Customer', descriptionKey: 'task:t1:description',
      subtasks: [
        { id: 't2', parentId: 't1', title: 'Book boat', titleKey: 'task:t2:title', description: null, descriptionKey: 'task:t2:description' },
        { id: 't3', parentId: 't2', title: 'Pay deposit', titleKey: 'task:t3:title', description: null, descriptionKey: 'task:t3:description' },
      ],
    },
    { id: 't4', title: 'Report', titleKey: 'task:t4:title', description: null, descriptionKey: 'task:t4:description', subtasks: [] },
  ],
  risks: [{ id: 'r1', key: 'risk:r1', text: 'Storms in 2026' }],
  resources: [
    { id: 'l1', key: null, item: { id: 'i1', kind: 'equipment', reference: 'EQ-1', name: 'Boat' }, oneOffKind: null, description: '', quantity: '2.00', unit: 'days' },
    { id: 'l2', key: 'resource:l2', item: null, oneOffKind: 'other', description: 'Divers 2026', quantity: null, unit: null },
  ],
  limits: { tasks: 500, risks: 200, resources: 200, terms: 10, termChars: 100 },
  ...over,
});
const texts = (s: DupState, o = offer()) => problemsOf(o, s).map((p) => p.text);
const settled = (s: DupState, o = offer()): DupState => confirmText({ ...s, name: 'Quay survey', plannedEnd: '2027-12-31' }, o, 'purpose', true);
const body = (o: Offer, s: DupState) => buildBody(o, s) as any;

test('everything is prefilled; a copy cannot be created until name, planned end and purpose are decided', () => {
  const o = offer();
  const s = startState(o);
  assert.equal(s.name, 'Harbour survey 2026');
  assert.equal(s.tasks.t3.on, true);
  assert.equal(s.risks.r1.on, false, 'risks are offered, none ticked');
  assert.equal(s.resources.l1.on, true);
  assert.deepEqual(problemsOf(o, s).map((p) => p.field), ['dup-name', 'dup-planned-end', 'dup-purpose']);
  assert.deepEqual(problemsOf(o, settled(s)), []);
});

test('a name that differs only by case or spacing is the same name', () => {
  assert.ok(texts({ ...settled(startState(offer())), name: '  HARBOUR   survey 2026 ' }).some((t) => /different/.test(t)));
});

test('the planned end: another date, or no planned end', () => {
  const s = settled(startState(offer()));
  assert.match(texts({ ...s, plannedEnd: '2026-12-31' })[0], /planned end/i);
  assert.match(texts({ ...s, plannedEnd: '' })[0], /planned end/i);
  assert.deepEqual(texts({ ...s, plannedEnd: '', noPlannedEnd: true }), []);
  assert.equal(body(offer(), { ...s, plannedEnd: '2027-01-01', noPlannedEnd: true }).plannedEnd, null);
});

test('old terms: one per line, found whatever the case and spacing, and only in what is to be copied', () => {
  const o = offer();
  let s = settled({ ...startState(o), termsText: ' 2026 \n\nexample customer' });
  assert.deepEqual(termsOf(s.termsText), ['2026', 'example customer']);
  assert.deepEqual(findIn('For Example  Customer', ['example customer']), ['example customer']);
  const fields = () => problemsOf(o, s).map((p) => p.field);
  assert.deepEqual(fields(), ['dup-task:t1:title', 'dup-task:t1:description', 'dup-resource:l2']);
  s = chooseTask(s, o, 't1', false);
  assert.deepEqual(fields(), ['dup-resource:l2']);
  s = { ...s, risks: { r1: { ...s.risks.r1, on: true } } };
  assert.deepEqual(fields(), ['dup-risk:r1', 'dup-resource:l2']);
  assert.ok(carriedTexts(o, { ...s, name: 'Y' }).some((t) => t.key === 'name'));
});

test('"Still correct" holds for the text and terms it was ticked for, and no others', () => {
  const o = offer();
  let s = settled({ ...startState(o), termsText: '2026' });
  s = chooseAllTasks(s, o, false);
  s = { ...s, resources: { ...s.resources, l2: { ...s.resources.l2, on: false } } };
  assert.deepEqual(problemsOf(o, s), []);
  s = chooseTask(s, o, 't1', true);
  assert.equal(problemsOf(o, s).length, 1);
  s = confirmText(s, o, 'task:t1:title', true);
  assert.deepEqual(problemsOf(o, s), []);
  assert.deepEqual(body(o, s).confirmedKeys, ['task:t1:title']);
  const edited = { ...s, tasks: { ...s.tasks, t1: { ...s.tasks.t1, title: 'Plan 2026 and 2027 work' } } };
  assert.equal(problemsOf(o, edited).length, 1, 'changed after the tick: asked again');
  assert.equal(problemsOf(o, { ...s, termsText: '2026\nplan' }).length, 1, 'another term found: asked again');
  assert.equal(problemsOf(o, confirmText(s, o, 'task:t1:title', false)).length, 1);
});

test('an old term left in a changed purpose is asked about too, with one tick', () => {
  const o = offer();
  let s: DupState = { ...startState(o), name: 'Quay', plannedEnd: '2027-12-31', termsText: 'example customer', purpose: 'Survey the quay for Example Customer' };
  s = chooseAllTasks(s, o, false);
  assert.deepEqual(problemsOf(o, s).map((p) => p.field), ['dup-purpose']);
  s = confirmText(s, o, 'purpose', true);
  assert.deepEqual(problemsOf(o, s), []);
  assert.deepEqual(body(o, s).confirmedKeys, ['purpose']);
  assert.equal(body(o, s).purposeConfirmed, true);
});

test('terms the server found that this page did not are asked about until changed or confirmed', () => {
  const o = offer();
  const s: DupState = { ...settled(startState(o)), serverTerms: { 'task:t4:title': { text: 'Report', terms: ['Old'] } } };
  assert.deepEqual(problemsOf(o, s).map((p) => p.field), ['dup-task:t4:title']);
  assert.deepEqual(problemsOf(o, { ...s, tasks: { ...s.tasks, t4: { ...s.tasks.t4, title: 'Summary' } } }), []);
  assert.deepEqual(problemsOf(o, confirmText(s, o, 'task:t4:title', true)), []);
});

test('terms the server names under a new: key mark the row in that place', () => {
  const o = offer();
  let s: DupState = settled(startState(o));
  s = {
    ...s,
    stages: [{ ...s.stages[0], substages: [...s.stages[0].substages, { uid: 'n5', name: 'Zebra day' }] }, { uid: 'n6', name: 'Zebra stage', substages: [{ uid: 'n7', name: 'Zebra step' }] }],
    holidays: [...s.holidays, { uid: 'n8', date: '2027-01-01', name: 'Zebra fest' }],
  };
  const keys = ['new:stage:0:substage:2', 'new:stage:1', 'new:stage:1:substage:0', 'new:holiday:1'];
  const named = withServerTerms(s, o, keys.map((key) => ({ key, term: 'ZEBRA' })));
  assert.deepEqual(Object.keys(named.serverTerms), ['n5', 'stage:n6', 'n7', 'holiday:n8']);
  assert.deepEqual(problemsOf(o, named).map((p) => p.field), ['dup-n5', 'dup-stage:n6', 'dup-n7', 'dup-holiday:n8']);
  assert.ok(problemsOf(o, named).every((p) => !/Still correct/.test(p.text)), 'none can be confirmed');
  assert.deepEqual(body(o, confirmText(named, o, 'n5', true)).confirmedKeys, []);
  const here = { ...s, termsText: 'zebra' };
  assert.deepEqual(problemsOf(o, here).map((p) => p.field), problemsOf(o, named).map((p) => p.field), 'the page finds the same by itself');
});

test('asOf is sent back as it came', () => {
  const o = offer({ asOf: '2026-11-25T10:00:00.000Z~3:1:7' });
  assert.equal(body(o, startState(o)).asOf, '2026-11-25T10:00:00.000Z~3:1:7');
});

test('a refused Create: the three conflicts, an old page, what the server lists, and no answer', () => {
  const open = readRefusal(409, 'Something in the original is under review for a suspected credential. Create the copy when the review has ended.', {});
  assert.deepEqual([open.loadAgain, open.created, open.uncertain, open.hint], [true, null, false, 'You can load again now and go on with this page; Create works once the review has ended.']);
  const since = readRefusal(409, 'Something in the original was put under review or cleaned after you opened this page. Load the project again.', {});
  assert.deepEqual([since.loadAgain, since.created], [true, null]);
  assert.match(since.hint!, /keeps what you typed/);
  const twice = readRefusal(409, 'You created this project a moment ago.', { projectId: P });
  assert.deepEqual([twice.loadAgain, twice.created], [false, P]);
  assert.equal(readRefusal(400, 'Load the project again.', {}).loadAgain, true);
  const listed = readRefusal(400, 'A. B.', { problems: ['A.', 'B.', 5] });
  assert.deepEqual([listed.problems, listed.part, listed.loadAgain], [['A.', 'B.'], null, true]);
  assert.equal(readRefusal(400, 'Choose an active owning department.', null).part, 'departments');
  assert.equal(readRefusal(0, 'Cannot reach', undefined).uncertain, true);
  assert.equal(readRefusal(500, 'x', undefined).uncertain, true);
  assert.equal(readRefusal(503, 'read only', undefined).uncertain, false);
  assert.match(readRefusal(413, 'x', undefined).message, /too much text/);
});

test('why a setting of the original is not carried, by its name', () => {
  const reason = "The Administrator does not let projects set their own digest now, so the new project uses the organisation's.";
  const o = offer({ settings: { ...offer().settings, notCarried: [{ setting: 'digest', notCarried: true, reason }] } });
  assert.equal(notCarriedReason(o, 'digest'), reason);
  assert.equal(notCarriedReason(o, 'formats'), undefined);
});

test('limits on the terms themselves', () => {
  const s = settled(startState(offer()));
  assert.match(texts({ ...s, termsText: Array.from({ length: 11 }, (_, i) => `zz${i}q`).join('\n') })[0], /at most 10/);
  assert.match(texts({ ...s, termsText: 'x'.repeat(101) })[0], /100 characters/);
});

test('choosing a subtask chooses everything above it; dropping a task drops everything below it', () => {
  const o = offer();
  const on = (s: DupState) => Object.entries(s.tasks).filter(([, t]) => t.on).map(([id]) => id);
  let s = chooseAllTasks(startState(o), o, false);
  assert.deepEqual(on(s), []);
  s = chooseTask(s, o, 't3', true);
  assert.deepEqual(on(s), ['t1', 't2', 't3']);
  s = chooseTask(s, o, 't2', false);
  assert.deepEqual(on(s), ['t1']);
  s = chooseTask(chooseAllTasks(s, o, true), o, 't1', false);
  assert.deepEqual(on(s), ['t4']);
});

test('a task left out keeps what was typed in it', () => {
  const o = offer();
  let s = startState(o);
  s = { ...s, tasks: { ...s.tasks, t4: { ...s.tasks.t4, title: 'My wording', due: '2027-02-03' } } };
  s = chooseTask(chooseTask(s, o, 't4', false), o, 't4', true);
  assert.equal(s.tasks.t4.title, 'My wording');
  assert.equal(body(o, s).tasks[1].due, '2027-02-03');
});

test('what would be refused is named beside its field: blanks, doubles, retired departments, limits', () => {
  const o = offer();
  const s = settled(startState(o));
  assert.equal(problemsOf(o, { ...s, stages: [] })[0].field, 'dup-stages');
  assert.equal(problemsOf(o, { ...s, stages: [{ ...s.stages[0], name: ' ' }] })[0].field, 'dup-stage:s1');
  assert.match(texts({ ...s, stages: [s.stages[0], { uid: 'n1', name: 'START', substages: [] }] })[0], /same name/);
  assert.match(texts({ ...s, holidays: [...s.holidays, { uid: 'n2', date: '2026-12-25', name: 'Other' }] })[0], /same date/);
  assert.equal(problemsOf(o, { ...s, resources: { ...s.resources, l1: { ...s.resources.l1, unit: '' } } })[0].field, 'dup-resource:l1:quantity');
  assert.equal(problemsOf(o, { ...s, resources: { ...s.resources, l1: { ...s.resources.l1, quantity: '1.234' } } }).length, 1);
  assert.equal(problemsOf(o, { ...s, tasks: { ...s.tasks, t2: { ...s.tasks.t2, title: '' } } })[0].field, 'dup-task:t2:title');
  const retired = offer({ original: { ...o.original, owningDepartment: { id: 'd1', name: 'Surveys', retired: true }, contributingDepartments: [{ id: 'd9', name: 'Old one', retired: true }] } });
  const rs = settled(startState(retired), retired);
  assert.equal(rs.owning, '');
  assert.deepEqual(problemsOf(retired, rs).map((p) => p.field), ['dup-owning', 'dup-contributing:d9']);
  const many = offer({ tasks: Array.from({ length: 501 }, (_, i) => ({ id: `m${i}`, title: 'x', titleKey: `task:m${i}:title`, description: null, descriptionKey: `task:m${i}:description`, subtasks: [] })) });
  assert.match(texts(settled(startState(many), many), many)[0], /501 tasks and subtasks; at most 500/);
});

test('settings: the body says what is on screen, and bad values are named', () => {
  const o = offer();
  const s = settled(startState(o));
  const { notCarried: _none, ...sent } = o.settings;
  assert.deepEqual(body(o, s).settings, sent);
  assert.deepEqual(body(o, { ...s, notifications: { ...s.notifications, leadDays: { own: true, value: '7, 1' } } }).settings.notifications.leadDays, [7, 1]);
  assert.equal(problemsOf(o, { ...s, notifications: { ...s.notifications, leadDays: { own: true, value: 'soon' } } })[0].field, 'dup-lead-days');
  assert.equal(problemsOf(o, { ...s, notifications: { ...s.notifications, weekdays: { own: true, value: [] } } })[0].field, 'dup-weekdays');
  assert.equal(problemsOf(o, { ...s, outputs: { ...s.outputs, exportRoles: [] } })[0].field, 'dup-export-roles');
  const digest = offer({ settings: { ...o.settings, notifications: { ...o.settings.notifications, digestEnabled: true, digestFrequency: 'weekly', digestWeekday: 2, digestTime: '08:30' } } });
  const ds = startState(digest);
  assert.deepEqual(body(digest, ds).settings, { ...sent, notifications: digest.settings.notifications });
  assert.deepEqual(body(digest, { ...ds, notifications: { ...ds.notifications, digest: { ...ds.notifications.digest, enabled: false } } }).settings.notifications, o.settings.notifications);
});

test('the body: ids, keys of kept substages, new stages without an id, only what was chosen, wording of a one-off line', () => {
  const o = offer();
  let s = settled(startState(o));
  s = { ...s, stages: [{ ...s.stages[0], substages: [s.stages[0].substages[1]] }, { uid: 'n', name: 'Handover', substages: [{ uid: 'm', name: 'Sign' }] }] };
  s = chooseTask(s, o, 't2', false);
  const b = body(o, s);
  assert.deepEqual(b.stages, [
    { id: 's1', name: 'Start', substages: [{ key: 'stage:s1:substage:1', name: 'Kick off' }] },
    { name: 'Handover', substages: [{ name: 'Sign' }] },
  ]);
  assert.deepEqual(b.tasks.map((t: any) => [t.id, t.subtasks.map((x: any) => x.id)]), [['t1', []], ['t4', []]]);
  assert.deepEqual(b.risks, []);
  assert.deepEqual(b.resources, [{ id: 'l1', quantity: '2.00', unit: 'days' }, { id: 'l2', quantity: null, unit: null, description: 'Divers 2026' }]);
  assert.deepEqual(b.holidays, [{ id: 'h1', date: '2026-12-25', name: 'Closing day' }]);
});

test('Load again keeps what was typed, takes the new text where nothing was, and takes out what is gone', () => {
  const o = offer();
  let s = settled({ ...startState(o), termsText: '2026' });
  s = { ...s, tasks: { ...s.tasks, t1: { ...s.tasks.t1, title: 'Plan 2027 work' } } };
  const next = offer({
    original: { ...o.original, purpose: 'A cleaned purpose.' },
    tasks: [
      { ...o.tasks[0], description: 'New words', subtasks: [o.tasks[0].subtasks[0]] },
      { id: 't9', title: 'Late task', titleKey: 'task:t9:title', description: null, descriptionKey: 'task:t9:description', subtasks: [] },
    ],
    risks: [],
  });
  const m = mergeOffer(o, next, s);
  assert.equal(m.state.name, 'Quay survey');
  assert.equal(m.state.purpose, 'A cleaned purpose.');
  assert.equal(m.state.tasks.t1.title, 'Plan 2027 work');
  assert.equal(m.state.tasks.t1.description, 'New words');
  assert.equal(m.state.tasks.t9.on, false, 'what is newly offered waits for a decision');
  assert.deepEqual(Object.keys(m.state.tasks), ['t1', 't2', 't9']);
  assert.deepEqual(m.removed, { task: 2, risk: 1 });
  assert.equal(m.added, 1);
  assert.ok(problemsOf(next, m.state).some((p) => p.field === 'dup-purpose'), 'the new purpose has not been confirmed');
});

test('Load again: what was typed over a text that has changed is replaced, with a note at the field and at the top', () => {
  const o = offer();
  let s = settled(startState(o), o);
  s = {
    ...s,
    purpose: 'Survey the quay for Example Customer, password 1234',
    stages: [{ ...s.stages[0], name: 'Start of hunter2', substages: [{ ...s.stages[0].substages[0], name: 'Prepare hunter2' }, s.stages[0].substages[1]] }],
    holidays: [{ ...s.holidays[0], name: 'Closing hunter2', date: '2027-12-25' }],
    tasks: { ...s.tasks, t1: { ...s.tasks.t1, title: 'Plan hunter2 for the quay', description: 'For the quay', due: '2027-05-05' }, t4: { ...s.tasks.t4, title: 'My report' } },
    risks: { r1: { on: true, text: 'Storms hunter2' } },
    resources: { ...s.resources, l2: { ...s.resources.l2, description: 'Divers hunter2', quantity: '3', unit: 'days' } },
  };
  const next = offer({
    original: { ...o.original, purpose: '[credential removed]' },
    stages: [{ ...o.stages[0], name: '[credential removed] a', substages: [{ key: 'stage:s1:substage:0', name: '[credential removed] b' }, o.stages[0].substages[1]] }],
    holidays: [{ ...o.holidays[0], name: '[credential removed] c' }],
    tasks: [{ ...o.tasks[0], title: '[credential removed] d' }, o.tasks[1]],
    risks: [{ ...o.risks[0], text: '[credential removed] e' }],
    resources: [o.resources[0], { ...o.resources[1], description: '[credential removed] f' }],
  });
  const { state: m } = mergeOffer(o, next, s);
  assert.equal(JSON.stringify(body(next, m)).includes('hunter2'), false);
  assert.equal(JSON.stringify(body(next, m)).includes('1234'), false);
  assert.deepEqual([m.tasks.t1.title, m.tasks.t1.description, m.tasks.t1.due, m.tasks.t4.title], ['[credential removed] d', 'For the quay', '2027-05-05', 'My report']);
  assert.deepEqual([m.name, m.holidays[0].date, m.resources.l2.quantity], ['Quay survey', '2027-12-25', '3']);
  assert.deepEqual(replacedOf(next, m).map((p) => p.field), ['dup-purpose', 'dup-stage:s1', 'dup-stage:s1:substage:0', 'dup-holiday:h1', 'dup-task:t1:title', 'dup-risk:r1', 'dup-resource:l2']);
  assert.ok(replacedOf(next, m).every((p) => p.text.endsWith(REPLACED)));
  assert.equal(REPLACED, 'The original changed, so what you typed here was replaced.');
  const again = { ...m, tasks: { ...m.tasks, t1: { ...m.tasks.t1, title: 'New wording' } } };
  assert.equal(replacedOf(next, again).some((p) => p.field === 'dup-task:t1:title'), false, 'the note goes once the text is changed');
  const cleared = mergeOffer(o, offer({ tasks: [{ ...o.tasks[0], description: null }, o.tasks[1]] }), s).state;
  assert.deepEqual([cleared.tasks.t1.description, replacedOf(o, cleared).map((p) => p.field)], ['', ['dup-task:t1:description']], 'also where nothing is left');
  assert.deepEqual(replacedOf(o, mergeOffer(o, offer({ tasks: [o.tasks[0], { ...o.tasks[1], title: 'Changed' }] }), startState(o)).state), [], 'no note where nothing was typed');
});

test('Load again: a row that is gone is dropped with what was typed in it; rows added here stay', () => {
  const o = offer();
  let s = startState(o);
  s = {
    ...s,
    stages: [{ ...s.stages[0], name: 'My start', substages: [{ ...s.stages[0].substages[0], name: 'My prepare' }, { uid: 'n1', name: 'Added step' }] }, { uid: 'n2', name: 'Added stage', substages: [] }],
    holidays: [{ ...s.holidays[0], name: 'My day' }, { uid: 'n3', date: '2027-01-01', name: 'Added day' }],
  };
  const m = mergeOffer(o, offer({ stages: [], holidays: [] }), s);
  assert.deepEqual(m.state.stages.map((x) => [x.name, x.substages.map((y) => y.name)]), [['', ['Added step']], ['Added stage', []]], 'an added substage stays, in a stage that still needs a name');
  assert.deepEqual(m.state.holidays.map((x) => x.name), ['Added day']);
  assert.equal(m.removed.stage, 1);
  assert.equal(m.removed.holiday, 1);
  const sub = mergeOffer(o, offer({ stages: [{ ...o.stages[0], substages: [o.stages[0].substages[1]] }] }), s);
  assert.deepEqual(sub.state.stages[0].substages.map((x) => x.name), ['Added step']);
  assert.equal(sub.removed.substage, 1);
  assert.deepEqual(mergeOffer(o, offer({ stages: [{ id: 's7', key: 'stage:s7', name: 'Fresh', substages: [] }] }), startState(o)).state.stages.map((x) => x.name), ['Fresh']);
});

test('a reason the project cannot be copied now is said', () => {
  assert.equal(blockedReason(offer()), null);
  assert.equal(blockedReason(offer({ blocked: 'Under review.' })), 'Under review.');
  assert.equal(blockedReason(offer({ blocked: { reason: 'Under review.' } })), 'Under review.');
});

test('Load again: a setting projects may no longer have goes back to the organisation', () => {
  const o = offer();
  const s = { ...startState(o), notifications: { ...startState(o).notifications, leadDays: { own: true, value: '7' }, dayCounting: { own: true, value: 'calendar' as const } } };
  const next = offer({ mayChange: { ...o.mayChange, calendar: false }, holidays: [] });
  const m = mergeOffer(o, next, s).state;
  assert.deepEqual([m.notifications.dayCounting.own, m.notifications.leadDays.own, m.holidays], [false, true, []]);
});

test('a subtask never stays ticked under a task that is not', () => {
  const o = offer();
  const s = chooseAllTasks(startState(o), o, true);
  const next = offer({ tasks: [{ ...o.tasks[0], subtasks: [o.tasks[0].subtasks[0], { ...o.tasks[0].subtasks[1], parentId: 't8' }, { ...o.tasks[0].subtasks[0], id: 't8', parentId: 't1' }] }] });
  const m = mergeOffer(o, next, s).state;
  assert.deepEqual([m.tasks.t8.on, m.tasks.t3.on], [false, false]);
});

test('what the server named as gone can be taken out with the rest kept', () => {
  const s = takeOutUnavailable(startState(offer()), offer(), ['t2', 'l1']);
  assert.deepEqual([s.tasks.t1.on, s.tasks.t2.on, s.tasks.t3.on, s.resources.l1.on], [true, false, false, false]);
});

test('a refusal is shown by the part it concerns', () => {
  assert.equal(refusalPart('Give each stage a name of 1 to 80 characters.'), 'stages');
  assert.equal(refusalPart('The Administrator has not allowed projects to change this setting. Keep each holiday as it was or take it out.'), 'holidays');
  assert.equal(refusalPart('The Administrator has not allowed projects to change their own formats.'), 'settings');
  assert.equal(refusalPart('Choose an active owning department.'), 'departments');
  assert.equal(refusalPart('Enter both a quantity and a unit, or neither.'), 'resources');
  assert.equal(refusalPart('Write a description of up to 4,000 characters.'), 'tasks');
  assert.equal(refusalPart('A subtask can be copied only with the task it belongs to.'), 'tasks');
  assert.equal(refusalPart('Give each risk 1 to 2,000 characters.'), 'risks');
  assert.equal(refusalPart('Not posted: this looks like it contains a password. Remove it and post again.'), null);
});

test('marking an old term in its text', () => {
  assert.deepEqual(termParts('For Example  Customer now', ['example customer']), [{ text: 'For ', hit: false }, { text: 'Example  Customer', hit: true }, { text: ' now', hit: false }]);
  assert.deepEqual(termParts('nothing (here)', ['(x']), [{ text: 'nothing (here)', hit: false }]);
  const long = termParts(`${'a '.repeat(200)}2026 ${'b '.repeat(200)}`, ['2026']);
  assert.ok(long.map((p) => p.text).join('').length < 220, 'only the words around it');
  assert.ok(long.some((p) => p.hit && p.text === '2026'));
});

test('rows without an id are checked for old terms; with no key to confirm them under, they must be changed', () => {
  const o = offer();
  let s: DupState = { ...settled(startState(o)), termsText: 'zebra' };
  s = { ...s, stages: [...s.stages, { uid: 'n1', name: 'Zebra stage', substages: [{ uid: 'n2', name: 'Zebra step' }] }], holidays: [...s.holidays, { uid: 'n3', date: '2027-01-01', name: 'Zebra day' }] };
  assert.deepEqual(problemsOf(o, s).map((p) => p.field), ['dup-stage:n1', 'dup-n2', 'dup-holiday:n3']);
  assert.ok(problemsOf(o, s).every((p) => !/Still correct/.test(p.text)));
  for (const k of ['stage:n1', 'n2', 'holiday:n3']) s = confirmText(s, o, k, true);
  assert.equal(problemsOf(o, s).length, 3, 'a tick does not settle them');
  assert.deepEqual(body(o, s).confirmedKeys, []);
});

test('Load again merges into what is on the page when the answer comes, and offer and input change together', () => {
  const o = offer();
  const depts = [{ id: 'd1', name: 'Surveys', status: 'active' as const }];
  let page = startPage({ offer: o, departments: depts, approved: null });
  page = { ...page, dup: { ...page.dup, name: 'Typed while it was loading' } };
  const next = offer({ tasks: [...o.tasks, { id: 't9', title: 'Late', titleKey: 'task:t9:title', description: null, descriptionKey: 'task:t9:description', subtasks: [] }] });
  const after = loadedAgain(page, { offer: next, departments: depts, approved: null }, []);
  assert.equal(after.dup.name, 'Typed while it was loading');
  assert.equal(after.dup.tasks.t9.on, false);
  assert.equal(after.loaded.offer, next);
  assert.match(after.notice!, /What you typed is kept.*Newly offered: 1/);
});

test('a department chosen and retired since is something to change', () => {
  const o = offer();
  const s = { ...settled(startState(o)), owning: 'd5', contributing: ['d6'] };
  assert.deepEqual(problemsOf(o, s, new Set(['d1'])).map((p) => [p.part, p.field]), [['departments', 'dup-owning'], ['departments', 'dup-contributing:d6']]);
  assert.deepEqual(problemsOf(o, { ...s, owning: 'd1', contributing: [] }, new Set(['d1'])), []);
});

test('the purpose is unchanged however its case and spacing were changed', () => {
  const o = offer();
  assert.equal(purposeUnchanged(o, { ...startState(o), purpose: ' SURVEY  the harbour for example customer. ' }), true);
  assert.equal(purposeUnchanged(o, { ...startState(o), purpose: 'Another' }), false);
});

test('copiedFrom wording and the address', () => {
  assert.equal(copiedFromText(null), null);
  assert.equal(copiedFromText(undefined), null);
  assert.deepEqual(copiedFromText({ hidden: true }), { text: 'Copied from another project' });
  assert.deepEqual(copiedFromText({ id: P, name: 'Harbour' }), { text: 'Copied from', name: 'Harbour', href: `#/projects/${P}` });
  assert.equal(parseDuplicateHash(`#/projects/${P}/duplicate`), P);
  assert.equal(parseDuplicateHash(`#/projects/${P}`), null);
});
