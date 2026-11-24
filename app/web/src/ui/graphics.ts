/** Text equivalents for the stage flow and the stacked bar (every graphic carries its values in words, O15). */
import type { Meaning } from './meanings.ts';

export interface Stage { name: string; state: 'done' | 'current' | 'todo'; days?: number }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Stage 3 of 5: Build, 34 days. Done: Initiation, Design." */
export function stageFlowText(stages: Stage[]): string {
  const at = stages.findIndex((s) => s.state === 'current');
  const done = stages.filter((s) => s.state === 'done').map((s) => s.name);
  const parts: string[] = [];
  if (at >= 0) {
    const s = stages[at];
    parts.push(`Stage ${at + 1} of ${stages.length}: ${s.name}${s.days === undefined ? '' : ', ' + plural(s.days, 'day', 'days')}.`);
  } else {
    parts.push(stages.length === 0 ? 'No stages.' : 'No stage is under way.');
  }
  if (done.length > 0) parts.push(`Done: ${done.join(', ')}.`);
  return parts.join(' ');
}

export interface BarPart { meaning: Meaning; label: string; count: number }
export interface LegendEntry extends BarPart { percent: number }

/** The parts with a count above zero, each with its whole-number percentage of the total. */
export function stackedBarLegend(parts: BarPart[]): LegendEntry[] {
  const shown = parts.filter((p) => p.count > 0);
  const total = shown.reduce((n, p) => n + p.count, 0);
  return shown.map((p) => ({ ...p, percent: Math.round((p.count / total) * 100) }));
}

/** "12 in all: 5 Done (42%), 7 Open (58%)." Counts are the values; percentages only help. */
export function stackedBarText(parts: BarPart[]): string {
  const legend = stackedBarLegend(parts);
  if (legend.length === 0) return 'None.';
  const total = legend.reduce((n, p) => n + p.count, 0);
  return `${total} in all: ${legend.map((p) => `${p.count} ${p.label} (${p.percent}%)`).join(', ')}.`;
}
