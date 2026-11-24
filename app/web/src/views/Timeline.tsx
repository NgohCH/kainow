import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  type ProjectTimeline,
  type TimelineItem,
  type TimelineLine,
  TIMELINE_KIND_LABELS,
  dayLabel,
  monthLabel,
  updatedLabel,
  withTodayMarker,
} from '../dashboard.ts';
import { setHidden, type Prefs, type TimelineKind } from '../prefs.ts';
import { Box } from '../ui/Box.tsx';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { TimelineBars } from '../ui/TimelineBars.tsx';
import { barsLayout } from '../ui/timelineBars.ts';

const KINDS = Object.keys(TIMELINE_KIND_LABELS) as TimelineKind[];

type TaskDetail = { done: number; tasks: { id: string; title: string; status: string }[] };
type RiskDetail = { risks: { id: string; description: string; severity: string }[] };

/** What one dated line records. A due-date or risk-review line opens to list its items. */
function LineWhat({ line, projectId }: { line: TimelineLine; projectId: string }) {
  const [open, setOpen] = useState(false);
  const detail = line.detail as (Partial<TaskDetail> & Partial<RiskDetail> & { durationDays?: number }) | undefined;
  const items =
    line.kind === 'tasks_due'
      ? (detail?.tasks ?? []).map((t) => ({ id: t.id, text: `${t.title} (${t.status.replace(/_/g, ' ')})`, href: `#/projects/${projectId}/work/${t.id}` }))
      : line.kind === 'risk_review'
        ? (detail?.risks ?? []).map((r) => ({ id: r.id, text: `${r.severity}: ${r.description}`, href: null as string | null }))
        : [];
  const done = line.kind === 'tasks_due' && typeof detail?.done === 'number' && detail.done > 0 ? `${detail.done} done` : null;
  return (
    <>
      {items.length > 0 ? (
        <button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {line.label}
        </button>
      ) : line.kind === 'resource_needed_by' ? (
        <a href={`#/projects/${projectId}/resources`}>{line.label}</a>
      ) : (
        line.label
      )}
      {typeof detail?.durationDays === 'number' && <span className="meta"> ({detail.durationDays} {detail.durationDays === 1 ? 'day' : 'days'})</span>}
      {done && <span className="meta"> ({done})</span>}
      {open && (
        <ul className="plain">
          {items.map((i) => (
            <li key={i.id}>{i.href ? <a href={i.href}>{i.text}</a> : i.text}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The Timeline tab (spec 5.2): recorded dates grouped by month, a Today marker, and kind toggles saved as a preference. */
export function Timeline({ projectId, prefs, ready, onChange }: { projectId: string; prefs: Prefs; ready: boolean; onChange: (next: Prefs) => Promise<void> }) {
  const [t, setT] = useState<ProjectTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setT(null);
    setError(null);
    api.get<ProjectTimeline>(`/projects/${projectId}/timeline`).then(
      (r) => !stale && setT(r),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [projectId]);

  const hidden = prefs.timeline.hiddenKinds;
  async function toggle(kind: TimelineKind, show: boolean) {
    setSaveError(null);
    try {
      await onChange({ ...prefs, timeline: { hiddenKinds: setHidden(hidden, kind, !show, []) } });
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Could not save that choice. Try again.');
    }
  }

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!t) return <p className="loading">Loading timeline</p>;
  const months = withTodayMarker(
    t.months.map((m) => ({ month: m.month, lines: m.lines.filter((l) => !hidden.includes(l.kind)) })),
    t.today,
  ).filter((m) => m.items.length > 0);

  const columns: Column<TimelineItem>[] = [
    {
      key: 'day',
      header: 'Date',
      cell: (i) => (i.today ? <span className="timeline-today">Today, {dayLabel(t.today)}</span> : dayLabel(i.line.day)),
    },
    { key: 'kind', header: 'Kind', cell: (i) => (i.today ? '' : TIMELINE_KIND_LABELS[i.line.kind]) },
    { key: 'what', header: 'What', wide: true, cell: (i) => (i.today ? <span className="meta">Earlier dates are above, later ones below.</span> : <LineWhat line={i.line} projectId={projectId} />) },
  ];

  return (
    <section aria-labelledby="timeline-heading" className="timeline">
      <h2 id="timeline-heading">Timeline</h2>
      <p className="meta">
        Recorded dates from {dayLabel(t.range.from)} to {dayLabel(t.range.to)}. {updatedLabel(t.computedAt)}
      </p>
      <fieldset className="timeline-kinds" disabled={!ready}>
        <legend>Show</legend>
        {KINDS.map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={!hidden.includes(k)} onChange={(e) => toggle(k, e.target.checked)} />
            {TIMELINE_KIND_LABELS[k]}
          </label>
        ))}
      </fieldset>
      {saveError && <p role="alert" className="error">{saveError}</p>}
      {/* A response without the periods: leave the bars out rather than say there are none. */}
      {t.stagePeriods && <TimelineBars
        layout={barsLayout({ from: t.range.from, to: t.range.to, today: t.today, periods: t.stagePeriods, lines: t.months.flatMap((m) => m.lines), hiddenKinds: hidden })}
      />}
      {months.map((m) => {
        const keys = new Map(m.items.map((i, n) => [i, i.today ? `today-${n}` : `${i.line.day}-${i.line.kind}-${i.line.label}-${n}`]));
        return (
          <Box key={m.month} title={monthLabel(m.month)} headingLevel={3}>
            <DataTable caption={`Dates in ${monthLabel(m.month)}`} columns={columns} rows={m.items} rowKey={(i) => keys.get(i) ?? ''} empty="Nothing recorded this month." />
          </Box>
        );
      })}
    </section>
  );
}
