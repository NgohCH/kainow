import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  type ProjectDashboard,
  awaitingLabel,
  cancelledLabel,
  completionLabel,
  dayLabel,
  lateLabel,
  onTimeLabel,
  plannedEndLabel,
  updatedLabel,
} from '../dashboard.ts';
import { formatWhen, plural } from '../format.ts';
import { dashboardFinanceLines, resourceCountsLine } from '../resourceScreens.ts';
import { Bars } from './Bars.tsx';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const SEVERITY_LABEL: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

/** The figures block on the Overview tab (spec 5.1): only what `GET /projects/:id/dashboard` sends. */
export function ProjectFigures({ projectId, canReadWork }: { projectId: string; canReadWork: boolean }) {
  const [d, setD] = useState<ProjectDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let stale = false;
    setD(null);
    setError(null);
    setHidden(false);
    api.get<ProjectDashboard>(`/projects/${projectId}/dashboard`).then(
      (r) => !stale && setD(r),
      (e: Error) => {
        if (stale) return;
        // A 404 means the figures are not for this viewer; show nothing rather than a false "not found".
        if (e instanceof ApiError && e.status === 404) setHidden(true);
        else setError(e.message);
      },
    );
    return () => {
      stale = true;
    };
  }, [projectId]);

  if (hidden) return null;
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!d) return <p className="loading">Loading figures</p>;
  const m = d.measures;
  const c = m.completion;
  const o = m.onTime;
  const cancelled = cancelledLabel(c);
  const awaiting = awaitingLabel(o);
  const late = lateLabel(o);
  // The Work tab does not filter yet, so these link to the tab itself.
  const count = (n: number, label: string) =>
    canReadWork && n > 0 ? <a href={`#/projects/${projectId}/work`}>{plural(n, label)}</a> : <>{plural(n, label)}</>;

  return (
    <section aria-labelledby="figures-heading" className="figures">
      <h2 id="figures-heading">Figures</h2>
      <Bars
        caption="Task progress"
        items={[
          { label: 'Task completion', value: c.state === 'measurable' ? c.percent : null, max: 100, text: completionLabel(c) },
          { label: 'On-time completion', value: o.state === 'measured' ? o.percent : null, max: 100, text: onTimeLabel(o) },
        ]}
      />
      {cancelled && <p className="meta">{cancelled}</p>}
      {late && <p className="meta">{late}</p>}
      {awaiting && <p className="meta">{awaiting}</p>}

      <dl className="facts">
        <dt>Stage</dt>
        <dd>{m.stage ? `${m.stage.stage}${m.stage.substage ? `, ${m.stage.substage}` : ''}, ${plural(m.stage.days, 'day')} in stage` : 'No stage recorded'}</dd>
        <dt>Planned end</dt>
        <dd>{plannedEndLabel(m.plannedEnd)}</dd>
        <dt>Overdue</dt>
        <dd>{count(m.overdue, 'task')}</dd>
        <dt>Blocked</dt>
        <dd>{count(m.blocked, 'task')}</dd>
        <dt>Due in the next 7 days</dt>
        <dd>{count(m.dueSoon, 'task')}</dd>
        <dt>Pending invitations</dt>
        <dd>
          {d.invitations.count}
          {d.invitations.names && d.invitations.names.length > 0 && <span className="meta"> ({d.invitations.names.join(', ')})</span>}
        </dd>
      </dl>

      {(m.flags.missingRole || m.flags.noIndependentEscalation || m.flags.deadlineReview) && (
        <ul className="plain">
          {m.flags.missingRole && <li className="warn">A required role is vacant</li>}
          {m.flags.noIndependentEscalation && <li className="warn">No independent escalation recipient</li>}
          {m.flags.deadlineReview && <li className="warn">Deadline review required</li>}
        </ul>
      )}

      <h3>Decisions</h3>
      <p>{d.decisions.active} active</p>
      {d.decisions.recent.length > 0 && (
        <ul className="plain">
          {d.decisions.recent.map((x) => (
            <li key={x.id}>{x.title} <span className="meta">{formatWhen(x.at)}</span></li>
          ))}
        </ul>
      )}

      <h3>Questions</h3>
      <p>{m.questions.open} open, {m.questions.answered} answered</p>
      {d.questions.oldestOpen.length > 0 && (
        <ul className="plain">
          {d.questions.oldestOpen.map((x) => (
            <li key={x.id}>{x.text} <span className="meta">{formatWhen(x.at)}</span></li>
          ))}
        </ul>
      )}

      <h3>Risks</h3>
      <table className="table">
        <caption className="visually-hidden">Open and mitigating risks by severity</caption>
        <thead>
          <tr>
            <th scope="col">Severity</th>
            <th scope="col">Open or mitigating</th>
          </tr>
        </thead>
        <tbody>
          {SEVERITIES.map((s) => (
            <tr key={s}>
              <th scope="row">{SEVERITY_LABEL[s]}</th>
              <td>{m.risks.bySeverity[s]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="meta">{plural(m.risks.overdueReviews, 'review')} overdue</p>
      {d.risks.significant.length > 0 && (
        <ul className="plain">
          {d.risks.significant.map((r) => (
            <li key={r.id}>
              <strong>{SEVERITY_LABEL[r.severity] ?? r.severity}</strong> {r.description}
              {r.reviewOn && <span className="meta"> (review {dayLabel(r.reviewOn)})</span>}
            </li>
          ))}
        </ul>
      )}

      <h3>Resources</h3>
      <p>
        <a href={`#/projects/${projectId}/resources`}>{resourceCountsLine(d.resources.byStatus)}</a>
      </p>
      {d.resources.neededByPassed > 0 && <p className="warn">Resources past needed-by date: {d.resources.neededByPassed}</p>}
      {d.resources.overlapping > 0 && <p className="meta">{plural(d.resources.overlapping, 'line')} also recorded by other projects in the same period. Usage records, not bookings.</p>}

      <h3>Finance</h3>
      {dashboardFinanceLines(d.finance).map((t, i) => (
        <p key={i} className={i === 0 || t.startsWith('Financial tracking') ? undefined : 'meta'}>{t}</p>
      ))}
      {'figures' in d.finance && <p className="meta"><a href={`#/projects/${projectId}/resources`}>Open Finance on the Resources tab</a></p>}

      <details className="about-figures">
        <summary>About these figures</summary>
        <p>{d.coverage}</p>
      </details>
      <p className="meta">{updatedLabel(d.computedAt)}</p>
    </section>
  );
}
