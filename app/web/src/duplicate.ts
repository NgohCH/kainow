/**
 * Duplicating a project (D140): what the review page holds, what still has to be changed, and what is sent. The checks
 * mirror the server's (app/src/projects/duplicate.ts), which makes them again.
 */
import type { Department } from './api.ts';
import { parseLeadDays } from './settings.ts';
import { TEMPLATE_LIMITS } from './ui/stages.ts';

export interface OfferedTask { id: string; title: string; titleKey: string; description: string | null; descriptionKey: string }
export interface OfferedSubtask extends OfferedTask { parentId: string }
export interface OfferedTopTask extends OfferedTask { subtasks: OfferedSubtask[] }
export interface OfferedLine {
  id: string;
  /** Null for a catalogue item: its name is the catalogue's, not carried text. */
  key: string | null;
  item: { id: string; kind: string; reference: string; name: string } | null;
  oneOffKind: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
}
interface NamedDepartment { id: string; name: string; retired: boolean }
export interface NotificationRow {
  dayCounting: 'working' | 'calendar' | null;
  weekdays: number[] | null;
  leadDays: number[] | null;
  escalationDays: number | null;
  digestEnabled: boolean;
  digestFrequency: 'daily' | 'weekly' | null;
  digestWeekday: number | null;
  digestTime: string | null;
}
export interface OutputRow { inputFormats: string[] | null; outputFormats: string[] | null; exportRoles: string[] }

export type NotCarried = 'requiredApprovals' | 'holidays' | 'calendar' | 'timings' | 'digest' | 'formats' | 'exportRoles';

/** `GET /projects/:id/duplicate`. */
export interface Offer {
  original: {
    id: string; name: string; purpose: string; purposeKey: string; plannedEnd: string | null;
    owningDepartment: NamedDepartment; contributingDepartments: NamedDepartment[];
  };
  stages: Array<{ id: string; key: string; name: string; substages: Array<{ key: string; name: string }> }>;
  holidays: Array<{ id: string; key: string; date: string; name: string }>;
  settings: {
    requiredApprovals: number | null; notifications: NotificationRow; outputs: OutputRow;
    /** What the original has that a project may not set now: the new project uses the organisation's, for this reason. */
    notCarried: Array<{ setting: NotCarried; notCarried: true; reason: string }>;
  };
  mayChange: { calendar: boolean; timings: boolean; digest: boolean; formats: boolean; exportRoles: boolean };
  tasks: OfferedTopTask[];
  risks: Array<{ id: string; key: string; text: string }>;
  resources: OfferedLine[];
  /** Opaque: sent back as it came, so that a change made since for safety reasons is refused (409). */
  asOf: string;
  /** Why the project cannot be copied now, when it cannot. */
  blocked?: string | { reason: string } | null;
  limits: { tasks: number; risks: number; resources: number; terms: number; termChars: number };
}

export interface StageDraft { uid: string; id?: string; name: string; substages: Array<{ uid: string; key?: string; name: string }> }
export interface HolidayDraft { uid: string; id?: string; date: string; name: string }
export interface TaskDraft { on: boolean; title: string; description: string; due: string }
export interface LineDraft { on: boolean; quantity: string; unit: string; description: string }
/** One of the project's own settings, or the organisation's when `own` is false; what was typed is kept either way. */
export interface OwnSetting<T> { own: boolean; value: T }
export interface NotificationDraft {
  dayCounting: OwnSetting<'working' | 'calendar'>;
  weekdays: OwnSetting<number[]>;
  leadDays: OwnSetting<string>;
  escalationDays: OwnSetting<string>;
  digest: { enabled: boolean; frequency: 'daily' | 'weekly'; weekday: number; time: string };
}
export interface OutputDraft { inputFormats: OwnSetting<string[]>; outputFormats: OwnSetting<string[]>; exportRoles: string[] }

/** Everything on the review page, prefilled from the original. */
export interface DupState {
  name: string;
  plannedEnd: string;
  noPlannedEnd: boolean;
  purpose: string;
  owning: string;
  contributing: string[];
  stages: StageDraft[];
  holidays: HolidayDraft[];
  requiredApprovals: number | null;
  notifications: NotificationDraft;
  outputs: OutputDraft;
  tasks: Record<string, TaskDraft>;
  risks: Record<string, { on: boolean; text: string }>;
  resources: Record<string, LineDraft>;
  /** Old terms, one per line. */
  termsText: string;
  /** By text key: the text and terms "Still correct" was ticked for (see `signature`). */
  confirmed: Record<string, string>;
  /** Terms a refusal named, for the text it was about. */
  serverTerms: Record<string, { text: string; terms: string[] }>;
  /** By text key: the new text that took the place of what was typed, because the original changed. */
  replaced: Record<string, string>;
}

export type Part = 'details' | 'departments' | 'stages' | 'holidays' | 'settings' | 'tasks' | 'risks' | 'resources';
/** Something still to be changed, and the field to go to. */
export interface Problem { field: string; text: string; part: Part }

export const MAX_WORDING = 2_000;
export const MAX_DESCRIPTION = 4_000;

/** The id of the field that holds a carried text. */
export const fieldOf = (key: string): string => `dup-${key}`;

export function parseDuplicateHash(hash: string): string | null {
  return /^#\/projects\/([0-9a-f-]{36})\/duplicate$/i.exec(hash)?.[1] ?? null;
}

export type CopiedFrom = { id: string; name: string } | { hidden: true } | null;

/** "Copied from <name>" with its link where the reader may open the original; otherwise no name and no link. */
export function copiedFromText(from: CopiedFrom | undefined): { text: string; name?: string; href?: string } | null {
  if (!from) return null;
  return 'hidden' in from ? { text: 'Copied from another project' } : { text: 'Copied from', name: from.name, href: `#/projects/${from.id}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Old terms
// ---------------------------------------------------------------------------------------------------------------

// Hundreds of texts are compared on each keystroke; only the one being typed is new.
const plainCache = new Map<string, string>();
/** How text is compared: case, runs of white space and the two ways of writing an accented letter do not matter. */
function plain(s: string): string {
  const known = plainCache.get(s);
  if (known !== undefined) return known;
  const made = s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (plainCache.size > 5_000) plainCache.clear();
  plainCache.set(s, made);
  return made;
}

/** The old terms as typed: one per line, blank lines left out. */
export function termsOf(text: string): string[] {
  return text.split('\n').map((t) => t.normalize('NFC').trim()).filter((t) => t !== '');
}

/** The terms a text holds. */
export function findIn(text: string, terms: readonly string[]): string[] {
  const t = plain(text);
  return terms.filter((term) => {
    const find = plain(term);
    return find !== '' && t.includes(find);
  });
}

/** The terms one carried text holds: those on the page, and those a refusal named for this very text. */
export function foundFor(text: string, terms: readonly string[], server: { text: string; terms: string[] } | undefined): string[] {
  const here = findIn(text, terms);
  return server && plain(server.text) === plain(text) ? [...here, ...server.terms.filter((t) => !here.includes(t))] : here;
}

/** The old terms a carried text holds, and what a "Still correct" tick stands for: change the text, or find another term in it, and the question is asked again. */
export interface Asked { found: string[]; signature: string }
export function askedAbout(text: string, terms: readonly string[], server: { text: string; terms: string[] } | undefined): Asked {
  const found = foundFor(text, terms, server);
  return { found, signature: JSON.stringify([plain(text), found.map(plain).sort()]) };
}
const asked = (s: DupState, t: { key: string; text: string }, terms: readonly string[]): Asked => askedAbout(t.text, terms, s.serverTerms[t.key]);

export const REPLACED = 'The original changed, so what you typed here was replaced.';

/** A text around its old terms, in parts to mark; long text is cut to the words around the first one. */
export function termParts(text: string, terms: readonly string[]): Array<{ text: string; hit: boolean }> {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = terms.map((t) => escape(t.normalize('NFC').trim()).replace(/\s+/g, '\\s+')).filter((p) => p !== '').sort((a, b) => b.length - a.length);
  const t = text.normalize('NFC');
  const find = patterns.length === 0 ? null : new RegExp(patterns.join('|'), 'giu');
  const first = find?.exec(t);
  if (!find || !first) return [{ text: t.length > 160 ? `${t.slice(0, 160)}…` : t, hit: false }];
  const from = Math.max(0, first.index - 60);
  const to = Math.min(t.length, first.index + first[0].length + 90);
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = from;
  find.lastIndex = 0;
  const push = (s: string, hit: boolean) => s !== '' && out.push({ text: s, hit });
  for (const m of t.slice(from, to).matchAll(find)) {
    push(t.slice(at, from + m.index), false);
    push(m[0], true);
    at = from + m.index + m[0].length;
  }
  push(t.slice(at, to), false);
  if (from > 0) out.unshift({ text: '…', hit: false });
  if (to < t.length) out.push({ text: '…', hit: false });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The page's state
// ---------------------------------------------------------------------------------------------------------------

let made = 0;
/** An identity for a row added on the page (React keys only; never sent). */
export const newUid = (): string => `new-${++made}`;

const notificationDraft = (n: NotificationRow): NotificationDraft => ({
  dayCounting: { own: n.dayCounting !== null, value: n.dayCounting ?? 'working' },
  weekdays: { own: n.weekdays !== null, value: n.weekdays ?? [1, 2, 3, 4, 5] },
  leadDays: { own: n.leadDays !== null, value: (n.leadDays ?? []).join(', ') },
  escalationDays: { own: n.escalationDays !== null, value: n.escalationDays === null ? '' : String(n.escalationDays) },
  digest: { enabled: n.digestEnabled, frequency: n.digestFrequency ?? 'daily', weekday: n.digestWeekday ?? 1, time: n.digestTime ?? '09:00' },
});
const outputDraft = (o: OutputRow): OutputDraft => ({
  inputFormats: { own: o.inputFormats !== null, value: o.inputFormats ?? [] },
  outputFormats: { own: o.outputFormats !== null, value: o.outputFormats ?? [] },
  exportRoles: o.exportRoles,
});
const taskDraft = (t: OfferedTask, on: boolean): TaskDraft => ({ on, title: t.title, description: t.description ?? '', due: '' });
const lineDraft = (l: OfferedLine, on: boolean): LineDraft => ({ on, quantity: l.quantity ?? '', unit: l.unit ?? '', description: l.description });
const stageDraft = (s: Offer['stages'][number]): StageDraft => ({ uid: s.id, id: s.id, name: s.name, substages: s.substages.map((x) => ({ uid: x.key, key: x.key, name: x.name })) });
const holidayDraft = (h: Offer['holidays'][number]): HolidayDraft => ({ uid: h.id, id: h.id, date: h.date, name: h.name });

/** Every offered task with everything below it, in the order shown. */
export const allTasks = (o: Offer): Array<OfferedTask & { parentId: string | null }> => o.tasks.flatMap((t) => [{ ...t, parentId: null }, ...t.subtasks]);

/** Tasks and resource lines start ticked, risks do not (spec 14). */
export function startState(o: Offer): DupState {
  const { original } = o;
  return {
    name: original.name,
    plannedEnd: original.plannedEnd ?? '',
    noPlannedEnd: false,
    purpose: original.purpose,
    owning: original.owningDepartment.retired ? '' : original.owningDepartment.id,
    contributing: original.contributingDepartments.map((d) => d.id),
    stages: o.stages.map(stageDraft),
    holidays: o.holidays.map(holidayDraft),
    requiredApprovals: o.settings.requiredApprovals,
    notifications: notificationDraft(o.settings.notifications),
    outputs: outputDraft(o.settings.outputs),
    tasks: Object.fromEntries(allTasks(o).map((t) => [t.id, taskDraft(t, true)])),
    risks: Object.fromEntries(o.risks.map((r) => [r.id, { on: false, text: r.text }])),
    resources: Object.fromEntries(o.resources.map((l) => [l.id, lineDraft(l, true)])),
    termsText: '',
    confirmed: {},
    serverTerms: {},
    replaced: {},
  };
}

/** Choosing a task chooses everything above it; dropping one drops everything below it. */
export function chooseTask(s: DupState, o: Offer, id: string, on: boolean): DupState {
  const top = o.tasks.find((t) => t.id === id || t.subtasks.some((x) => x.id === id));
  if (!top) return s;
  const tasks = { ...s.tasks };
  const set = (taskId: string) => {
    if (tasks[taskId].on !== on) tasks[taskId] = { ...tasks[taskId], on };
  };
  if (on) {
    let at: string | undefined = id;
    while (at !== undefined) {
      set(at);
      at = at === top.id ? undefined : (top.subtasks.find((x) => x.id === at)?.parentId ?? top.id);
    }
  } else {
    const drop = (taskId: string) => {
      set(taskId);
      for (const x of top.subtasks) if (x.parentId === taskId) drop(x.id);
    };
    drop(id);
  }
  return { ...s, tasks };
}

export function chooseAllTasks(s: DupState, o: Offer, on: boolean): DupState {
  return { ...s, tasks: Object.fromEntries(allTasks(o).map((t) => [t.id, s.tasks[t.id].on === on ? s.tasks[t.id] : { ...s.tasks[t.id], on }])) };
}

/** Takes out what a refusal named as no longer available, keeping the rest. */
export function takeOutUnavailable(s: DupState, o: Offer, ids: readonly string[]): DupState {
  const gone = new Set(ids);
  let out = s;
  for (const id of ids) if (out.tasks[id]) out = chooseTask(out, o, id, false);
  const off = <T extends { on: boolean }>(rows: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, gone.has(id) ? { ...r, on: false } : r]));
  return { ...out, risks: off(out.risks), resources: off(out.resources) };
}

/**
 * A text without a key of the original (`keyless`: a new stage, substage or holiday) is known to the server by its place
 * (`sendKey`, `new:…`) and cannot be confirmed there: an old term in it must be changed.
 */
export interface Carried { key: string; sendKey?: string; keyless?: boolean; text: string; what: string; part: Part }

const short = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 50 ? `${t.slice(0, 49)}…` : t;
};
const inQuotes = (s: string, blank: string): string => (short(s) === '' ? blank : `“${short(s)}”`);

/** Every text that would be created, under the key the server knows it by, in the order of the page. */
export function carriedTexts(o: Offer, s: DupState): Carried[] {
  const out: Carried[] = [
    { key: 'name', text: s.name, what: 'The name', part: 'details' },
    { key: 'purpose', text: s.purpose, what: 'The purpose', part: 'details' },
  ];
  for (const [i, st] of s.stages.entries()) {
    out.push({ key: `stage:${st.uid}`, ...(st.id ? {} : { keyless: true, sendKey: `new:stage:${i}` }), text: st.name, what: `Stage ${inQuotes(st.name, 'without a name')}`, part: 'stages' });
    for (const [n, x] of st.substages.entries()) {
      out.push({ key: x.key ?? x.uid, ...(st.id && x.key ? {} : { keyless: true, sendKey: `new:stage:${i}:substage:${n}` }), text: x.name, what: `Substage ${inQuotes(x.name, 'without a name')}`, part: 'stages' });
    }
  }
  for (const [i, h] of s.holidays.entries()) out.push({ key: `holiday:${h.uid}`, ...(h.id ? {} : { keyless: true, sendKey: `new:holiday:${i}` }), text: h.name, what: `Holiday ${inQuotes(h.name, 'without a name')}`, part: 'holidays' });
  for (const t of allTasks(o)) {
    const d = s.tasks[t.id];
    if (!d.on) continue;
    const what = `${t.parentId ? 'Subtask' : 'Task'} ${inQuotes(d.title, 'without a title')}`;
    out.push({ key: t.titleKey, text: d.title, what: `${what}: title`, part: 'tasks' });
    if (d.description.trim() !== '') out.push({ key: t.descriptionKey, text: d.description, what: `${what}: description`, part: 'tasks' });
  }
  for (const r of o.risks) if (s.risks[r.id].on) out.push({ key: r.key, text: s.risks[r.id].text, what: `Risk ${inQuotes(s.risks[r.id].text, 'without wording')}`, part: 'risks' });
  for (const l of o.resources) {
    if (l.key && s.resources[l.id].on) out.push({ key: l.key, text: s.resources[l.id].description, what: `Resource ${inQuotes(s.resources[l.id].description, 'without a description')}`, part: 'resources' });
  }
  return out;
}

/** Keeps the terms a refusal named, for the texts they were named in. */
export function withServerTerms(s: DupState, o: Offer, named: ReadonlyArray<{ key: string; term: string }>): DupState {
  const serverTerms = { ...s.serverTerms };
  for (const t of carriedTexts(o, s)) {
    const terms = named.filter((n) => n.key === (t.sendKey ?? t.key)).map((n) => n.term);
    if (terms.length > 0) serverTerms[t.key] = { text: t.text, terms };
  }
  return { ...s, serverTerms };
}

/** Where what was typed has been replaced and not changed since, each with its field. */
export function replacedOf(o: Offer, s: DupState): Problem[] {
  const emptied = allTasks(o).filter((t) => s.tasks[t.id].on && s.tasks[t.id].description === '').map((t): Carried => ({ key: t.descriptionKey, text: '', what: `${t.parentId ? 'Subtask' : 'Task'} ${inQuotes(s.tasks[t.id].title, 'without a title')}: description`, part: 'tasks' }));
  return [...carriedTexts(o, s), ...emptied].filter((t) => s.replaced[t.key] !== undefined && s.replaced[t.key] === t.text).map((t) => ({ part: t.part, field: fieldOf(t.key), text: `${t.what}. ${REPLACED}` }));
}

/** Ticks (or unticks) "Still correct" for one text as it stands now. */
export function confirmText(s: DupState, o: Offer, key: string, on: boolean): DupState {
  const confirmed = { ...s.confirmed };
  delete confirmed[key];
  const carried = on ? carriedTexts(o, s).find((t) => t.key === key) : undefined;
  if (carried) confirmed[key] = asked(s, carried, termsOf(s.termsText)).signature;
  return { ...s, confirmed };
}

// ---------------------------------------------------------------------------------------------------------------
// What still has to be changed
// ---------------------------------------------------------------------------------------------------------------

const count = (n: number) => n.toLocaleString('en-US');
const twice = (names: string[]): boolean => new Set(names).size !== names.length;
const validQuantity = (q: string): boolean => /^\d{1,10}(\.\d{1,2})?$/.test(q.trim()) && Number(q) > 0;

/** The purpose is the original's, so it must be changed or confirmed. */
export const purposeUnchanged = (o: Offer, s: DupState): boolean => plain(s.purpose) === plain(o.original.purpose);

/**
 * What is still to be decided before the project can be created, in the order of the page; empty when nothing is.
 * `active` holds the departments in use, where they are known.
 */
export function problemsOf(o: Offer, s: DupState, active?: ReadonlySet<string>): Problem[] {
  const out: Problem[] = [];
  const add = (part: Part, field: string, text: string) => out.push({ part, field, text });
  const terms = termsOf(s.termsText);

  // The old terms themselves.
  if (terms.length > o.limits.terms) add('details', 'dup-terms', `List at most ${o.limits.terms} old terms.`);
  if (terms.some((t) => t.length > o.limits.termChars)) add('details', 'dup-terms', `An old term can be at most ${o.limits.termChars} characters.`);

  // What must be different.
  if (s.name.trim() === '') add('details', 'dup-name', 'Give the new project a name.');
  else if (plain(s.name) === plain(o.original.name)) add('details', 'dup-name', "Give the new project a name different from the original's.");
  if (!s.noPlannedEnd && s.plannedEnd === '') add('details', 'dup-planned-end', 'Give a planned end date or tick “No planned end”.');
  else if (!s.noPlannedEnd && s.plannedEnd === o.original.plannedEnd) add('details', 'dup-planned-end', "Give a planned end date different from the original's, or tick “No planned end”.");
  const carried = carriedTexts(o, s);
  // Beyond ten terms the server refuses before it looks; here only the first ten are searched for.
  const wanted = terms.slice(0, o.limits.terms);
  const holding = carried.flatMap((t) => {
    const a = asked(s, t, wanted);
    const ask = a.found.length > 0 || (t.key === 'purpose' && purposeUnchanged(o, s));
    const settled = s.confirmed[t.key] === a.signature && !(t.keyless && a.found.length > 0);
    return ask && !settled ? [{ ...t, ...a }] : [];
  });
  const addHolding = (part: Part) => {
    for (const t of holding.filter((h) => h.part === part)) {
      if (t.key === 'purpose' && s.purpose.trim() === '') continue;
      const named = t.found.map((f) => `“${f}”`).join(', ');
      if (t.found.length > 0 && t.keyless) add(part, fieldOf(t.key), `${t.what} still holds ${named}. Change it.`);
      else if (t.found.length > 0) add(part, fieldOf(t.key), `${t.what} still holds ${named}. Change it or tick “Still correct”.`);
      else add(part, fieldOf(t.key), 'Change the purpose or tick “Still correct”.');
    }
  };
  if (s.purpose.trim() === '') add('details', 'dup-purpose', "Describe the new project's purpose.");
  addHolding('details');
  if (s.owning !== '' && active && !active.has(s.owning)) add('departments', 'dup-owning', 'Choose another owning department: the one chosen has been retired.');
  if (s.owning === '') add('departments', 'dup-owning', o.original.owningDepartment.retired ? `Choose an owning department: ${o.original.owningDepartment.name} is retired.` : 'Choose an owning department.');
  for (const id of s.contributing) {
    const offered = o.original.contributingDepartments.find((d) => d.id === id);
    if (active ? !active.has(id) : offered?.retired) add('departments', `dup-contributing:${id}`, `Take out ${offered ? `the contributing department ${offered.name}: it is` : 'a contributing department that has been'} retired.`);
  }

  // Stages.
  const stageField = (st: StageDraft) => fieldOf(`stage:${st.uid}`);
  if (s.stages.length === 0) add('stages', 'dup-stages', 'Keep at least one stage.');
  if (s.stages.length > TEMPLATE_LIMITS.stages) add('stages', 'dup-stages', `A project can have at most ${TEMPLATE_LIMITS.stages} stages.`);
  for (const [i, st] of s.stages.entries()) {
    if (st.name.trim() === '') add('stages', stageField(st), 'Give each stage a name.');
    else if (s.stages.slice(0, i).some((x) => x.name.trim().toLowerCase() === st.name.trim().toLowerCase())) add('stages', stageField(st), `Two stages have the same name, ${inQuotes(st.name, '')}.`);
    const blank = st.substages.find((x) => x.name.trim() === '');
    if (blank) add('stages', fieldOf(blank.key ?? blank.uid), `Give each substage of ${inQuotes(st.name, 'this stage')} a name, or remove it.`);
    if (twice(st.substages.map((x) => x.name.trim().toLowerCase()).filter((x) => x !== ''))) add('stages', stageField(st), `Two substages of ${inQuotes(st.name, 'this stage')} have the same name.`);
    if (st.substages.length > TEMPLATE_LIMITS.substagesPerStage) add('stages', stageField(st), `A stage can have at most ${TEMPLATE_LIMITS.substagesPerStage} substages.`);
  }
  addHolding('stages');

  // Holidays.
  for (const [i, h] of s.holidays.entries()) {
    if (h.date === '') add('holidays', `dup-holiday-date:${h.uid}`, 'Give each holiday a date, or remove it.');
    else if (s.holidays.slice(0, i).some((x) => x.date === h.date)) add('holidays', `dup-holiday-date:${h.uid}`, 'Two holidays are on the same date. Keep one of them.');
    if (h.name.trim() === '') add('holidays', fieldOf(`holiday:${h.uid}`), 'Give each holiday a name, or remove it.');
  }
  addHolding('holidays');

  // Settings.
  const n = s.notifications;
  const lead = parseLeadDays(n.leadDays.value);
  if (n.weekdays.own && n.weekdays.value.length === 0) add('settings', 'dup-weekdays', 'Choose at least one working weekday.');
  if (n.leadDays.own && (lead.length < 1 || lead.length > 3 || new Set(lead).size !== lead.length || !lead.every((d) => d >= 1 && d <= 30))) {
    add('settings', 'dup-lead-days', 'Give one to three reminder days, each different, from 1 to 30.');
  }
  if (n.escalationDays.own && !/^([1-9]|10)$/.test(n.escalationDays.value.trim())) add('settings', 'dup-escalation', 'The escalation delay must be 1–10 days.');
  if (n.digest.enabled && n.digest.time === '') add('settings', 'dup-digest-time', 'Choose the time of the action-item email.');
  if (s.outputs.inputFormats.own && s.outputs.inputFormats.value.length === 0) add('settings', 'dup-input-formats', 'Choose at least one format it accepts.');
  if (s.outputs.outputFormats.own && s.outputs.outputFormats.value.length === 0) add('settings', 'dup-output-formats', 'Choose at least one format it makes.');
  if (s.outputs.exportRoles.length === 0) add('settings', 'dup-export-roles', 'Choose at least one role that may export.');

  // Tasks, risks and resources.
  const chosen = allTasks(o).filter((t) => s.tasks[t.id].on);
  const limit = (part: Part, n2: number, max: number, what: string) => {
    if (n2 > max) add(part, `dup-${part}`, `You chose ${count(n2)} ${what}; at most ${count(max)} can be copied at once. Take out ${count(n2 - max)}.`);
  };
  limit('tasks', chosen.length, o.limits.tasks, 'tasks and subtasks');
  for (const t of chosen) if (s.tasks[t.id].title.trim() === '') add('tasks', fieldOf(t.titleKey), `Give this ${t.parentId ? 'subtask' : 'task'} a title, or untick it (it was ${inQuotes(t.title, 'blank')}).`);
  addHolding('tasks');
  const risks = o.risks.filter((r) => s.risks[r.id].on);
  limit('risks', risks.length, o.limits.risks, 'risks');
  for (const r of risks) if (s.risks[r.id].text.trim() === '') add('risks', fieldOf(r.key), `Give this risk its wording, or untick it (it was ${inQuotes(r.text, 'blank')}).`);
  addHolding('risks');
  const lines = o.resources.filter((l) => s.resources[l.id].on);
  limit('resources', lines.length, o.limits.resources, 'resource lines');
  for (const l of lines) {
    const d = s.resources[l.id];
    const name = l.item ? l.item.name : inQuotes(d.description, 'this resource');
    const field = `dup-resource:${l.id}:quantity`;
    if ((d.quantity.trim() === '') !== (d.unit === '')) add('resources', field, `${name}: enter both a quantity and a unit, or neither.`);
    else if (d.quantity.trim() !== '' && d.quantity !== l.quantity && !validQuantity(d.quantity)) add('resources', field, `${name}: enter a quantity above 0 with at most 2 decimal places.`);
    if (!l.item && d.description.trim() === '') add('resources', fieldOf(`resource:${l.id}`), 'Describe each one-off resource, or untick it.');
  }
  addHolding('resources');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------------------------

function notificationsBody(o: Offer, n: NotificationDraft): NotificationRow {
  const was = o.settings.notifications;
  const untouchedOff = !n.digest.enabled && !was.digestEnabled;
  return {
    dayCounting: n.dayCounting.own ? n.dayCounting.value : null,
    weekdays: n.weekdays.own ? [...n.weekdays.value].sort((a, b) => a - b) : null,
    leadDays: n.leadDays.own ? parseLeadDays(n.leadDays.value) : null,
    escalationDays: n.escalationDays.own ? Number(n.escalationDays.value) : null,
    digestEnabled: n.digest.enabled,
    digestFrequency: n.digest.enabled ? n.digest.frequency : untouchedOff ? was.digestFrequency : null,
    digestWeekday: n.digest.enabled ? (n.digest.frequency === 'weekly' ? n.digest.weekday : null) : untouchedOff ? was.digestWeekday : null,
    digestTime: n.digest.enabled ? n.digest.time : untouchedOff ? was.digestTime : null,
  };
}

/** The body of `POST /projects/:id/duplicate`: what is on screen, settings included. */
export function buildBody(o: Offer, s: DupState): Record<string, unknown> {
  const terms = termsOf(s.termsText);
  const task = (t: OfferedTask) => ({ id: t.id, title: s.tasks[t.id].title, description: s.tasks[t.id].description, due: s.tasks[t.id].due || null });
  const confirmedNow = carriedTexts(o, s).flatMap((t) => {
    const a = asked(s, t, terms);
    return s.confirmed[t.key] === a.signature ? [{ key: t.key, held: a.found.length > 0 && !t.keyless }] : [];
  });
  return {
    asOf: o.asOf,
    name: s.name,
    plannedEnd: s.noPlannedEnd ? null : s.plannedEnd,
    noPlannedEnd: s.noPlannedEnd,
    purpose: s.purpose,
    purposeConfirmed: confirmedNow.some((c) => c.key === 'purpose'),
    owningDepartmentId: s.owning,
    contributingDepartmentIds: s.contributing,
    stages: s.stages.map((st) => ({ ...(st.id ? { id: st.id } : {}), name: st.name, substages: st.substages.map((x) => ({ ...(x.key ? { key: x.key } : {}), name: x.name })) })),
    holidays: s.holidays.map((h) => ({ ...(h.id ? { id: h.id } : {}), date: h.date, name: h.name })),
    settings: {
      requiredApprovals: s.requiredApprovals,
      notifications: notificationsBody(o, s.notifications),
      outputs: {
        inputFormats: s.outputs.inputFormats.own ? s.outputs.inputFormats.value : null,
        outputFormats: s.outputs.outputFormats.own ? s.outputs.outputFormats.value : null,
        exportRoles: s.outputs.exportRoles,
      },
    },
    tasks: o.tasks.filter((t) => s.tasks[t.id].on).map((t) => ({ ...task(t), subtasks: t.subtasks.filter((x) => s.tasks[x.id].on).map(task) })),
    risks: o.risks.filter((r) => s.risks[r.id].on).map((r) => ({ id: r.id, text: s.risks[r.id].text })),
    resources: o.resources.filter((l) => s.resources[l.id].on).map((l) => {
      const d = s.resources[l.id];
      return { id: l.id, quantity: d.quantity.trim() || null, unit: d.unit || null, ...(l.item ? {} : { description: d.description }) };
    }),
    oldTerms: terms,
    confirmedKeys: confirmedNow.filter((c) => c.held).map((c) => c.key),
  };
}

/** Why the project cannot be copied now, or null. */
export const blockedReason = (o: Offer): string | null => (typeof o.blocked === 'string' ? o.blocked : o.blocked?.reason) || null;

/** Why something the original has is not carried into the new project, in the server's words. */
export const notCarriedReason = (o: Offer, setting: NotCarried): string | undefined => o.settings.notCarried.find((n) => n.setting === setting)?.reason;

/** The part of the page a refusal in words is about; null when it could be any (such as the credential check). */
export function refusalPart(message: string): Part | null {
  const rules: Array<[RegExp, Part]> = [
    [/holiday/i, 'holidays'],
    [/\bsub-?stage|\bstage/i, 'stages'],
    [/not allowed projects|number of approvals|reminder|escalation|digest|weekday|working days|format|export role|setting/i, 'settings'],
    [/\btask|subtask|description of up to/i, 'tasks'],
    [/\brisk/i, 'risks'],
    [/quantity|\bunit\b|resource|one-off/i, 'resources'],
    [/department/i, 'departments'],
    [/purpose|planned end|project name|project a name|old term/i, 'details'],
  ];
  // The credential check names no field.
  if (/^Not posted/i.test(message)) return null;
  return rules.find(([words]) => words.test(message))?.[1] ?? null;
}

/** What a refused Create says, and what can be done about it. */
export interface Refusal {
  message: string;
  part: Part | null;
  problems: string[];
  loadAgain: boolean;
  /** Beside Load again: what it does. */
  hint: string | null;
  /** No answer, or one that says nothing about what happened. */
  uncertain: boolean;
  /** The project the same Create made a moment ago. */
  created: string | null;
}

export function readRefusal(status: number, said: string, body: unknown): Refusal {
  const data = (body && typeof body === 'object' ? body : {}) as { problems?: unknown; projectId?: unknown };
  const created = status === 409 && typeof data.projectId === 'string' ? data.projectId : null;
  const problems = Array.isArray(data.problems) ? data.problems.filter((p): p is string => typeof p === 'string') : [];
  const message = status === 413 ? 'There is too much text to copy at once. Take out some tasks or shorten descriptions.' : said;
  const loadAgain = created === null && (status === 400 || status === 409);
  const underReview = status === 409 && /is under review/.test(said);
  return {
    message, problems, created, loadAgain,
    part: problems.length > 0 || status === 409 ? null : refusalPart(message),
    hint: !loadAgain
      ? null
      : underReview
        ? 'You can load again now and go on with this page; Create works once the review has ended.'
        : 'The original may have changed since you opened this page. Loading it again keeps what you typed, except where the original itself changed.',
    uncertain: status === 0 || (status >= 500 && status !== 503),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Load again
// ---------------------------------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** What was typed stands; where nothing was typed, the newly loaded value is taken. */
const keep = <T>(typed: T, was: T, now: T): T => (same(typed, was) ? now : typed);

function mergeFields<T extends object>(typed: T, was: T, now: T): T {
  return Object.fromEntries((Object.keys(now) as (keyof T & string)[]).map((k) => [k, keep(typed[k], was[k], now[k])])) as T;
}

/** The kinds and numbers of what is gone, never its text (it may have been removed for what it held). */
export type Removed = Record<string, number>;

/** The page after loading the offer again: typed input kept, what is gone taken out, what is new unticked. */
export function mergeOffer(before: Offer, now: Offer, s: DupState): { state: DupState; removed: Removed; added: number } {
  const was = startState(before);
  const fresh = startState(now);
  const removed: Removed = {};
  let added = 0;
  const gone = (kind: string) => {
    removed[kind] = (removed[kind] ?? 0) + 1;
  };

  const replaced = { ...s.replaced };
  /** Text: what was typed on an unchanged original stands. Where the original changed (it may have been cleaned), the new one takes its place. */
  const text = (key: string, typed: string, old: string, next: string): string => {
    if (old === next) return typed;
    if (typed !== old && typed !== next) replaced[key] = next;
    return next;
  };
  const rows = <T extends { on: boolean }>(kind: string, typed: Record<string, T>, freshRows: Record<string, T>, merge: (id: string, typed: T, now: T) => T): Record<string, T> => {
    for (const id of Object.keys(typed)) if (!freshRows[id]) gone(kind);
    return Object.fromEntries(
      Object.entries(freshRows).map(([id, f]) => {
        if (typed[id]) return [id, { ...merge(id, typed[id], f), on: typed[id].on }];
        added++;
        return [id, { ...f, on: false }];
      }),
    );
  };
  /** Gone rows are dropped with what was typed in them; rows added here stay. */
  const substages = (t: StageDraft, w: StageDraft, f: StageDraft): StageDraft['substages'] => [
    ...t.substages.flatMap((x) => {
      if (x.key === undefined) return [x];
      const old = w.substages.find((y) => y.key === x.key);
      const next = f.substages.find((y) => y.key === x.key);
      if (old && next) return [{ ...x, name: text(x.key, x.name, old.name, next.name) }];
      gone('substage');
      return [];
    }),
    ...f.substages.filter((x) => !w.substages.some((y) => y.key === x.key)),
  ];
  const listed = <T extends { uid: string; id?: string }>(kind: 'stage' | 'holiday', typed: T[], wasRows: T[], freshRows: T[], merge: (typed: T, was: T, now: T) => T, left: (typed: T) => T[]): T[] => {
    const out: T[] = [];
    for (const row of typed) {
      const w = wasRows.find((x) => x.id !== undefined && x.id === row.id);
      const f = freshRows.find((x) => x.id !== undefined && x.id === row.id);
      if (row.id === undefined) out.push(row);
      else if (w && f) out.push(merge(row, w, f));
      else {
        gone(kind);
        out.push(...left(row));
      }
    }
    for (const f of freshRows) {
      if (wasRows.some((x) => x.id === f.id)) continue;
      added++;
      out.push(f);
    }
    return out;
  };
  /** Of a stage that is gone, only the substages added here stay, in a stage that needs a name. */
  const leftOfStage = (t: StageDraft): StageDraft[] => {
    const own = t.substages.filter((x) => x.key === undefined);
    return own.length === 0 ? [] : [{ uid: newUid(), name: '', substages: own }];
  };

  // What projects may no longer set goes back to the organisation's, whatever was typed: it could not be created.
  const may = now.mayChange;
  const notifications = mergeFields(s.notifications, was.notifications, fresh.notifications);
  if (!may.calendar) Object.assign(notifications, { dayCounting: fresh.notifications.dayCounting, weekdays: fresh.notifications.weekdays });
  if (!may.timings) Object.assign(notifications, { leadDays: fresh.notifications.leadDays, escalationDays: fresh.notifications.escalationDays });
  if (!may.digest) notifications.digest = fresh.notifications.digest;
  const outputs = mergeFields(s.outputs, was.outputs, fresh.outputs);
  if (!may.formats) Object.assign(outputs, { inputFormats: fresh.outputs.inputFormats, outputFormats: fresh.outputs.outputFormats });
  if (!may.exportRoles) outputs.exportRoles = fresh.outputs.exportRoles;

  const offered = new Map(allTasks(now).map((t) => [t.id, t]));
  let tasks = rows('task', s.tasks, fresh.tasks, (id, t, f) => {
    const o = offered.get(id) as OfferedTask;
    const w = was.tasks[id];
    return { ...t, title: text(o.titleKey, t.title, w.title, f.title), description: text(o.descriptionKey, t.description, w.description, f.description) };
  });
  // A subtask is never copied without what it belongs to.
  for (const t of allTasks(now)) if (t.parentId && tasks[t.id].on && !tasks[t.parentId]?.on) tasks = { ...tasks, [t.id]: { ...tasks[t.id], on: false } };

  return {
    state: {
      ...mergeFields(s, was, fresh),
      replaced,
      purpose: text('purpose', s.purpose, was.purpose, fresh.purpose),
      termsText: s.termsText,
      confirmed: s.confirmed,
      serverTerms: s.serverTerms,
      noPlannedEnd: s.noPlannedEnd,
      requiredApprovals: now.settings.requiredApprovals === null ? null : keep(s.requiredApprovals, was.requiredApprovals, fresh.requiredApprovals),
      notifications,
      outputs,
      stages: listed('stage', s.stages, was.stages, fresh.stages, (t, w, f) => ({ ...t, name: text(`stage:${t.uid}`, t.name, w.name, f.name), substages: substages(t, w, f) }), leftOfStage),
      holidays: !may.calendar
        ? []
        : listed('holiday', s.holidays, was.holidays, fresh.holidays, (t, w, f) => ({ ...t, date: keep(t.date, w.date, f.date), name: text(`holiday:${t.uid}`, t.name, w.name, f.name) }), () => []),
      tasks,
      risks: rows('risk', s.risks, fresh.risks, (id, t, f) => ({ ...t, text: text(now.risks.find((r) => r.id === id)?.key ?? id, t.text, was.risks[id].text, f.text) })),
      resources: rows('resource line', s.resources, fresh.resources, (id, t, f) => ({ ...mergeFields(t, was.resources[id], f), description: text(`resource:${id}`, t.description, was.resources[id].description, f.description) })),
    },
    removed,
    added,
  };
}

/** What loading again did, in plain words. */
export function mergedLine(removed: Removed, added: number, replaced = 0): string {
  const gone = Object.entries(removed).map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`);
  return [
    replaced === 0 ? 'Loaded again. What you typed is kept.' : `Loaded again. What you typed is kept, except in ${replaced} ${replaced === 1 ? 'place' : 'places'} where the original changed.`,
    gone.length > 0 ? `Taken out because it can no longer be copied, with what you typed there: ${gone.join(', ')}.` : '',
    added > 0 ? `Newly offered: ${added}. Newly offered tasks, risks and resources are not ticked.` : '',
  ].filter((x) => x !== '').join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// The page: what was loaded and what was made of it change together
// ---------------------------------------------------------------------------------------------------------------

export interface Loaded { offer: Offer; departments: Department[]; approved: { input: string[]; output: string[] } | null }
export interface Page {
  loaded: Loaded;
  dup: DupState;
  /** What the last Load again did. */
  notice: string | null;
  /** Departments chosen here that are no longer in use keep their names. */
  departmentNames: Record<string, string>;
}

const namesOf = (l: Loaded): Record<string, string> =>
  Object.fromEntries([l.offer.original.owningDepartment, ...l.offer.original.contributingDepartments, ...l.departments].map((d) => [d.id, d.name]));

export const startPage = (loaded: Loaded): Page => ({ loaded, dup: startState(loaded.offer), notice: null, departmentNames: namesOf(loaded) });

/** The page after Load again, from what is typed when the answer comes. */
export function loadedAgain(page: Page, next: Loaded, unavailable: readonly string[]): Page {
  const { offer } = page.loaded;
  const merged = mergeOffer(offer, next.offer, takeOutUnavailable(page.dup, offer, unavailable));
  return { loaded: next, dup: merged.state, notice: mergedLine(merged.removed, merged.added, replacedOf(next.offer, merged.state).length), departmentNames: { ...page.departmentNames, ...namesOf(next) } };
}
