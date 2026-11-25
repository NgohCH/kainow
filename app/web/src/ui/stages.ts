/** Stage templates (D131, spec 14): the checks the server makes, shown in plain words before saving. */
import { plural } from '../format.ts';
import { stageDuration } from '../projects.ts';
import { STOPPED_LABEL, type Stage, type Stopped } from './graphics.ts';

export interface TemplateStage { name: string; substages: string[] }
export interface TemplateDraft { name: string; stages: TemplateStage[] }

export const TEMPLATE_LIMITS = { nameChars: 80, descriptionChars: 300, stages: 20, substagesPerStage: 10, reasonChars: 500 } as const;

const L = TEMPLATE_LIMITS;
const badName = (s: string) => s.trim() === '' || s.trim().length > L.nameChars;

/** What the server would refuse, in its words; an empty list means the draft can be saved. */
export function validateTemplateDraft(d: TemplateDraft): string[] {
  const problems: string[] = [];
  if (badName(d.name)) problems.push(`Give the template a name of 1 to ${L.nameChars} characters.`);
  if (d.stages.length === 0) problems.push('A template needs at least one stage.');
  if (d.stages.length > L.stages) problems.push(`A template can have at most ${L.stages} stages.`);
  const seen = new Set<string>();
  let unnamed = false;
  let unnamedSub = false;
  for (const s of d.stages) {
    if (badName(s.name)) {
      unnamed = true;
    } else {
      const key = s.name.trim().toLowerCase();
      if (seen.has(key)) problems.push(`Stage names must differ within a template: "${s.name.trim()}" appears twice.`);
      seen.add(key);
    }
    if (s.substages.length > L.substagesPerStage) problems.push(`A stage can have at most ${L.substagesPerStage} substages: ${s.name.trim() || 'a stage'} has ${s.substages.length}.`);
    if (s.substages.some(badName)) unnamedSub = true;
    const subs = s.substages.filter((x) => !badName(x)).map((x) => x.trim().toLowerCase());
    if (new Set(subs).size !== subs.length) problems.push(`Substage names must differ within a stage: ${s.name.trim() || 'a stage'} repeats one.`);
  }
  if (unnamed) problems.push(`Give each stage a name of 1 to ${L.nameChars} characters.`);
  if (unnamedSub) problems.push(`Give each substage a name of 1 to ${L.nameChars} characters.`);
  return [...new Set(problems)];
}

/** A template as the server lists it; `projectsUsing` only in the Administrator's full list. */
export interface StageTemplate {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'retired';
  position: number;
  createdByName: string;
  stages: TemplateStage[];
  projectsUsing?: number;
}

/** One of a project's own stages, as the project's page lists them (in order; retired ones keep their place). */
export interface ProjectStage { id: string; name: string; substages: string[]; status: 'active' | 'retired' }

/** What the server would refuse in a stage's new name, in its words; changing only the letter case is allowed. */
export function renameProblems(stages: readonly Pick<ProjectStage, 'id' | 'name'>[], id: string, name: string): string[] {
  const next = name.normalize('NFC').trim();
  if (badName(next)) return [`Give the stage a name of 1 to ${L.nameChars} characters.`];
  if (stages.some((s) => s.id === id && s.name === next)) return ['Give the stage a different name.'];
  if (stages.some((s) => s.id !== id && s.name.toLowerCase() === next.toLowerCase())) return ['This project already has a stage with that name.'];
  return [];
}

/** Whole UTC+8 calendar days from one instant to another (0 on the same day). */
function daysBetween(iso: string, to: Date): number {
  const day = (ms: number) => Math.floor((ms + 8 * 3_600_000) / 86_400_000);
  return Math.max(0, day(to.getTime()) - day(new Date(iso).getTime()));
}

/** How long the project has been in its stage; or, once a deferral or closure stopped it, that and how long it ran (D138). */
export function stageTiming(s: { startedAt: string; endedAt: string | null; stopped: Stopped | null }, now: Date): string {
  if (!s.stopped || !s.endedAt) return stageDuration(s.startedAt, now);
  return `${STOPPED_LABEL[s.stopped]}, after ${plural(daysBetween(s.startedAt, new Date(s.endedAt)), 'day')}`;
}

/**
 * The stage flow from the project's own stages: active stages in order. Done = before the current one and has a
 * period; current = the open period, with its days; the rest to do. In a Deferred or Closed project the last period is
 * stopped instead of current, with the days until then (D138). A current or stopped stage that is retired stays in its
 * place; one not in the list at all is added at the end, so the flow never hides where the project is.
 */
export function stageFlowFrom(
  stages: readonly { name: string; status: 'active' | 'retired' }[],
  periods: readonly { stage: string; startedAt: string; endedAt: string | null; stopped?: Stopped | null }[],
  now: Date,
): Stage[] {
  const last = periods[periods.length - 1];
  const here = periods.find((p) => p.endedAt === null) ?? (last?.stopped ? last : null);
  const names = stages.filter((s) => s.status === 'active' || s.name === here?.stage).map((s) => s.name);
  if (here && !names.includes(here.stage)) names.push(here.stage);
  const at = here ? names.indexOf(here.stage) : -1;
  const had = new Set(periods.map((p) => p.stage));
  return names.map((name, i): Stage => {
    if (i !== at) return { name, state: i < at && had.has(name) ? 'done' : 'todo' };
    const { startedAt, endedAt, stopped } = here!;
    if (endedAt !== null && stopped) return { name, state: 'stopped', stopped, days: daysBetween(startedAt, new Date(endedAt)) };
    return { name, state: 'current', days: daysBetween(startedAt, now) };
  });
}

/** One recorded change to a project's own stages. */
export interface StageChange {
  id: string;
  kind: 'added' | 'reordered' | 'retired' | 'restored' | 'renamed';
  /** The stage added, retired, brought back or renamed (its new name); null for a new order. */
  stage: string | null;
  actor: string;
  at: string;
  reason: string;
  previous: Omit<ProjectStage, 'id'>[];
  next: Omit<ProjectStage, 'id'>[];
}

/** What a stage change did, with the value before and after it. */
export function stageChangeText(c: StageChange): string {
  const order = (list: StageChange['next']) => list.map((s) => s.name).join(', ');
  if (c.kind === 'reordered') return `New order: ${order(c.next)}. Before: ${order(c.previous)}.`;
  if (c.kind === 'retired') return `Retired ${c.stage} (was in use).`;
  if (c.kind === 'restored') return `Brought back ${c.stage} (was retired).`;
  if (c.kind === 'renamed') {
    // The old name is in the same place of the list before; only one name differs.
    const was = c.previous.find((s, i) => s.name !== c.next[i]?.name)?.name;
    return was === undefined ? `Renamed to ${c.stage}.` : `Renamed ${was} to ${c.stage}.`;
  }
  const at = c.next.findIndex((s) => s.name === c.stage);
  const substages = c.next[at]?.substages ?? [];
  return `Added ${c.stage}${at >= 0 ? ` at place ${at + 1} of ${c.next.length}` : ''}${substages.length > 0 ? `, with substages ${substages.join(', ')}` : ''}.`;
}
