import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { formatWhen } from '../format.ts';
import { type SourceAddress, sourceHref } from '../proposalLinks.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { HumanProposals } from './HumanProposals.tsx';
import type { Person } from './AuthoriseForm.tsx';

/** One extraction run of the project, as `GET /projects/:projectId/proposal-runs` lists it. */
interface ProposalRun extends SourceAddress { runId: string; sourceTitle: string; finishedAt: string; waiting: number; total: number }

const columnsFor = (projectId: string): Column<ProposalRun>[] => [
  { key: 'source', header: 'Source and version', sortValue: (r) => r.sourceTitle.toLowerCase(), cell: (r) => <SourceLink projectId={projectId} run={r} /> },
  { key: 'finished', header: 'Finished', sortValue: (r) => r.finishedAt, cell: (r) => formatWhen(r.finishedAt) },
  { key: 'waiting', header: 'Waiting', sortValue: (r) => r.waiting, cell: (r) => `${r.waiting} of ${r.total}` },
  {
    key: 'open',
    header: 'Review',
    cell: (r) => (
      <a href={`#/runs/${r.runId}`} aria-label={`${r.waiting > 0 ? 'Review' : 'Open'} the proposals from ${r.sourceTitle}, version ${r.versionNo}`}>
        {r.waiting > 0 ? 'Review' : 'Open'}
      </a>
    ),
  },
];

/** The run's source, linked: the runs listed are those whose source the reader may open. */
function SourceLink({ projectId, run }: { projectId: string; run: ProposalRun }) {
  const href = sourceHref(projectId, run);
  const text = `${run.sourceTitle}, version ${run.versionNo}`;
  return href ? <a href={href}>{text}</a> : <>{text}</>;
}

/** The Proposals tab: the AI's proposals from each run on the project's notes and discussions (waiting first), then people's own proposals. */
export function ProjectProposals({
  projectId,
  canPropose,
  canReview,
  people,
  meId,
  focusId,
}: {
  projectId: string;
  canPropose: boolean;
  canReview: boolean;
  people: Person[];
  meId: string;
  focusId?: string;
}) {
  const [runs, setRuns] = useState<ProposalRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    api.get<{ runs: ProposalRun[] }>(`/projects/${projectId}/proposal-runs`).then(
      (r) => !stale && setRuns(r.runs),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [projectId]);

  const columns = columnsFor(projectId);
  const waiting = (runs ?? []).filter((r) => r.waiting > 0);
  const reviewed = (runs ?? []).filter((r) => r.waiting === 0);
  return (
    <>
      <section aria-labelledby="ai-proposals-heading">
        <h2 id="ai-proposals-heading">Proposals from AI</h2>
        <p className="meta">The AI proposes decisions, actions, questions and risks from the notes and the discussions it has analysed. Nothing becomes a record until a person authorises it.</p>
        {error && <p role="alert" className="error">{error}</p>}
        <DataTable
          caption="Waiting for review"
          columns={columns}
          rows={waiting}
          rowKey={(r) => r.runId}
          loading={!runs && !error}
          empty={runs ? 'No AI proposal is waiting for review.' : 'Loading'}
        />
        {reviewed.length > 0 && (
          <>
            <h3>Reviewed</h3>
            <DataTable caption="Reviewed: nothing waiting" columns={columns} rows={reviewed} rowKey={(r) => r.runId} empty="None." />
          </>
        )}
      </section>
      <HumanProposals projectId={projectId} canPropose={canPropose} canReview={canReview} people={people} meId={meId} focusId={focusId} />
    </>
  );
}
