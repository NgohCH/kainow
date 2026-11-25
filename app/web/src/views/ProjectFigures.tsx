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
  stageLabel,
  updatedLabel,
} from '../dashboard.ts';
import { formatWhen, plural } from '../format.ts';
import { dashboardFinanceLines, resourceCountsLine } from '../resourceScreens.ts';
import { Box } from '../ui/Box.tsx';
import { Bars } from './Bars.tsx';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const SEVERITY_LABEL: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export type DashboardState = { d: ProjectDashboard | null; error: string | null; hidden: boolean };

/**
 * `GET /projects/:id/dashboard` for the Overview, read once and shared by its parts. A 404 means the figures are not
 * for this viewer: `hidden`, so nothing shows rather than a false "not found". Not read at all when `enabled` is false.
 */
export function useProjectDashboard(projectId: string, enabled: boolean): DashboardState {
  const [state, setState] = useState<DashboardState>({ d: null, error: null, hidden: !enabled });
  useEffect(() => {
    if (!enabled) return setState({ d: null, error: null, hidden: true });
    let stale = false;
    setState({ d: null, error: null, hidden: false });
    api.get<ProjectDashboard>(`/projects/${projectId}/dashboard`).then(
      (r) => !stale && setState({ d: r, error: null, hidden: false }),
      (e: Error) => {
        if (stale) return;
        if (e instanceof ApiError && e.status === 404) setState({ d: null, error: null, hidden: true });
        else setState({ d: null, error: e.message, hidden: false });
      },
    );
    return () => {
      stale = true;
    };
  }, [projectId, enabled]);
  return state;
}

/** The figures on the Overview tab (spec 5.1, 7.5), in boxes: only what `GET /projects/:id/dashboard` sends. */
export function ProjectFigures({ projectId, canReadWork, state }: { projectId: string; canReadWork: boolean; state: DashboardState }) {
  const { d, error, hidden } = state;
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
    <section aria-labelledby="figures-heading" className="overview-figures">
      <h2 id="figures-heading">Figures</h2>
      <div className="overview-boxes">
        <Box title="Task progress" headingLevel={3}>
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
        </Box>

        <Box title="At a glance" headingLevel={3}>
          <dl className="facts">
            <dt>Stage</dt>
            <dd>{m.stage ? `${stageLabel(m.stage)}${m.stage.stopped ? '' : ' in stage'}` : 'No stage recorded'}</dd>
            <dt>Planned end</dt>
            <dd>{plannedEndLabel(m.plannedEnd)}</dd>
            <dt>Overdue</dt>
            <dd>{count(m.overdue, 'task')}</dd>
            <dt>Blocked</dt>
            <dd>{count(m.blocked, 'task')}</dd>
            <dt>Due soon</dt>
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
        </Box>

        <Box title="Decisions" headingLevel={3}>
          <p>{d.decisions.active} active</p>
          {d.decisions.recent.length > 0 && (
            <ul className="plain">
              {d.decisions.recent.map((x) => (
                <li key={x.id}>{x.title} <span className="meta">{formatWhen(x.at)}</span></li>
              ))}
            </ul>
          )}
        </Box>

        <Box title="Questions" headingLevel={3}>
          <p>{m.questions.open} open, {m.questions.answered} answered</p>
          {d.questions.oldestOpen.length > 0 && (
            <ul className="plain">
              {d.questions.oldestOpen.map((x) => (
                <li key={x.id}>{x.text} <span className="meta">{formatWhen(x.at)}</span></li>
              ))}
            </ul>
          )}
        </Box>

        <Box title="Risks" headingLevel={3}>
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
        </Box>

        <Box title="Resources" headingLevel={3}>
          <p>
            <a href={`#/projects/${projectId}/resources`}>{resourceCountsLine(d.resources.byStatus)}</a>
          </p>
          {d.resources.neededByPassed > 0 && <p className="warn">Resources past needed-by date: {d.resources.neededByPassed}</p>}
          {d.resources.overlapping > 0 && <p className="meta">{plural(d.resources.overlapping, 'line')} also recorded by other projects in the same period. Usage records, not bookings.</p>}
        </Box>

        <Box title="Finance" headingLevel={3}>
          {dashboardFinanceLines(d.finance).map((t, i) => (
            <p key={i} className={i === 0 || t.startsWith('Financial tracking') ? undefined : 'meta'}>{t}</p>
          ))}
          {'figures' in d.finance && <p className="meta"><a href={`#/projects/${projectId}/resources`}>Open Finance on the Resources tab</a></p>}
        </Box>
      </div>

      <details className="about-figures">
        <summary>About these figures</summary>
        <p>{d.coverage}</p>
      </details>
      <p className="meta">{updatedLabel(d.computedAt)}</p>
    </section>
  );
}
