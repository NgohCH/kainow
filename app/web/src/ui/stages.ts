/** Stage templates (D131, spec 14): the checks the server makes, shown in plain words before saving. */
import type { Stage } from './graphics.ts';

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

/** Whole UTC+8 calendar days from an instant to now (0 on the day it happened). */
function daysSince(iso: string, now: Date): number {
  const day = (ms: number) => Math.floor((ms + 8 * 3_600_000) / 86_400_000);
  return Math.max(0, day(now.getTime()) - day(new Date(iso).getTime()));
}

/**
 * The stage flow from the project's own stages: active stages in order. Done = before the current one and has a
 * period; current = the open period, with its days; the rest to do. A current stage that is retired stays in its
 * place; one not in the list at all is added at the end, so the flow never hides where the project is.
 */
export function stageFlowFrom(
  stages: readonly { name: string; status: 'active' | 'retired' }[],
  periods: readonly { stage: string; startedAt: string; endedAt: string | null }[],
  now: Date,
): Stage[] {
  const open = periods.find((p) => p.endedAt === null) ?? null;
  const names = stages.filter((s) => s.status === 'active' || s.name === open?.stage).map((s) => s.name);
  if (open && !names.includes(open.stage)) names.push(open.stage);
  const at = open ? names.indexOf(open.stage) : -1;
  const had = new Set(periods.map((p) => p.stage));
  return names.map((name, i): Stage =>
    i === at ? { name, state: 'current', days: daysSince(open!.startedAt, now) } : i < at && had.has(name) ? { name, state: 'done' } : { name, state: 'todo' },
  );
}
