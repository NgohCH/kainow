import { useCallback, useEffect, useState } from 'react';
import { sourceStorageLabel } from '../outputs.ts';
import { ApiError, api, type Project, type Run, type VersionSummary } from '../api.ts';
import { go } from '../App.tsx';
import { type AudienceView, returnedNotice, versionOriginText } from '../discussion.ts';
import { formatWhen, plural } from '../format.ts';
import { mayDraftSummary } from '../assist.ts';
import { type SourceKind, mayDeleteSource } from '../history.ts';
import { DeleteAction } from './DeleteRestore.tsx';
import { runFailureText } from '../quarantine.ts';
import { QuarantineNote, ReportSecret } from './ReportSecret.tsx';
import { AudiencePanel } from './AudiencePanel.tsx';
import { AiSettingsLink } from './AiLink.tsx';
import { SummaryRequest } from './SummaryView.tsx';
import { Intake } from './Intake.tsx';
import { SubmissionReview } from './Submissions.tsx';
import { Box } from '../ui/Box.tsx';
import { type Place, notePlace } from '../proposalLinks.ts';
import { useFocusItem } from './useFocusItem.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { Meaning } from '../ui/meanings.ts';

interface Detail {
  source: {
    id: string;
    title: string;
    createdAt: string;
    projectId: string;
    kind: string;
    label: string | null;
    /** "Possible credential removed — awaiting check" while this is a possible copy masked at once (history spec 7.4). */
    quarantineLabel?: string | null;
    publication: 'published' | 'submitted' | 'returned';
    intendedMode: 'project' | 'restricted' | null;
    returnedReason: string | null;
    provenance: string | null;
    audience: AudienceView;
    /** An approved shareable summary's labels; null for any other source. */
    summary?: { label: string; approved: string | null; from: string } | null;
    /** False for a shareable summary: it is never evidence. */
    mayExtract?: boolean;
  };
  mayAddVersion?: boolean;
  versions: VersionSummary[];
}

const STATUS_TEXT: Record<Run['status'], string> = {
  queued: 'Waiting to start',
  running: 'Reading the notes',
  succeeded: 'Ready to review',
  failed: 'Failed',
  blocked: 'Not sent',
};

const STATUS_MEANING: Record<Run['status'], Meaning> = {
  queued: 'draft',
  running: 'planned',
  succeeded: 'ok',
  failed: 'failing',
  blocked: 'blocked',
};

/** `place`: the passage a proposal's link points at; it is marked, scrolled to and focused once the text has loaded. */
export function NoteDetail({ sourceId, versionNo, place }: { sourceId: string; versionNo: number | null; place: Place | null }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [project, setProject] = useState<Project | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.get<Detail>(`/notes/${sourceId}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load these notes.');
    }
  }, [sourceId]);
  useEffect(() => void load(), [load]);

  const projectId = detail?.source.projectId;
  useEffect(() => {
    if (!projectId) return;
    api.get<{ project: Project }>(`/projects/${projectId}`).then(
      (r) => setProject(r.project),
      () => undefined,
    );
  }, [projectId]);

  const current = detail ? (versionNo ?? detail.versions[detail.versions.length - 1]?.versionNo ?? null) : null;
  const version = detail?.versions.find((v) => v.versionNo === current);

  useEffect(() => {
    if (current === null) return;
    setText(null);
    api.get<{ version: { text: string } }>(`/notes/${sourceId}/versions/${current}`).then((r) => setText(r.version.text), () => setText(null));
  }, [sourceId, current]);

  const loadRuns = useCallback(async () => {
    if (current === null) return;
    const r = await api.get<{ runs: Run[] }>(`/notes/${sourceId}/versions/${current}/extractions`).catch(() => null);
    if (r) setRuns(r.runs);
  }, [sourceId, current]);
  useEffect(() => void loadRuns(), [loadRuns]);

  const active = runs.some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(loadRuns, 2000);
    return () => clearInterval(t);
  }, [active, loadRuns]);

  async function extract() {
    setStarting(true);
    setError(null);
    try {
      await api.post(`/notes/${sourceId}/versions/${current}/extractions`);
      await loadRuns();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the extraction.');
    } finally {
      setStarting(false);
    }
  }

  const marked = text === null ? null : notePlace(text, place);
  // The address is part of the id, so following another link focuses again.
  const placeId = place ? `place-${current}-${place.start}-${place.end}` : undefined;
  useFocusItem(placeId, marked !== null && version !== undefined);

  if (error && !detail) return <main className="page narrow"><p role="alert" className="error">{error}</p><a href="#/projects">Projects</a></main>;
  if (!detail || !version) return <p className="loading">Loading</p>;

  const src = detail.source;
  const roles: string[] = project?.myRoles ?? [];
  const memberships = project?.memberships ?? [];
  const isReviewer = roles.some((r) => r !== 'member');
  const projectOpen = project ? ['draft', 'planned', 'active'].includes(project.status) : false;
  const published = src.publication === 'published';
  // Notes, minutes and approved summaries can be deleted; a discussion transcript is not deleted directly (its messages are).
  const sourceKind: SourceKind | null = src.kind === 'notes' ? 'note' : src.kind === 'minutes' ? 'minutes' : src.kind === 'summary' ? 'summary' : null;
  const mayDelete = project !== null && sourceKind !== null && mayDeleteSource(project.myRoles, project.status);

  return (
    <main className="page">
      <PageHeader
        crumbs={[
          { text: 'Projects', href: '#/projects' },
          { text: project?.name ?? 'Project', href: `#/projects/${src.projectId}` },
          { text: 'Notes', href: `#/projects/${src.projectId}/notes` },
        ]}
        title={src.title}
      />
      {mayDelete && sourceKind && (
        <p>
          <DeleteAction kind={sourceKind} id={sourceId} label={`${sourceKind === 'minutes' ? 'these minutes' : `this ${sourceKind}`}`} onDone={() => go(`#/projects/${src.projectId}/notes`)} />
        </p>
      )}
      {project && src.kind !== 'discussion' && (
        <p>
          <ReportSecret projectId={src.projectId} kind="source" id={sourceId} label={`this ${sourceKind === 'minutes' ? 'set of minutes' : (sourceKind ?? 'source')}`} onReported={() => go(`#/projects/${src.projectId}/notes`)} />
        </p>
      )}
      {(src.label || src.quarantineLabel || src.provenance || src.summary || src.publication !== 'published') && (
        <Box meaning={src.publication === 'submitted' ? 'review' : src.publication === 'returned' ? 'attention' : undefined}>
          {src.publication === 'submitted' && <p><StatusLabel meaning="review" word="Submitted for review" /></p>}
          {src.publication === 'returned' && <p><StatusLabel meaning="attention" word="Returned" /></p>}
          {src.label && <p className="meta">{src.label}</p>}
          <QuarantineNote text={src.quarantineLabel} />
          {src.provenance && <p className="meta">{src.provenance}</p>}
          {src.summary && (
            <p className="meta" role="note">
              {src.summary.label}
              {src.summary.approved && <> · {src.summary.approved}</>} · {src.summary.from}
            </p>
          )}
          {src.publication === 'submitted' && <p className="warn" role="note">Submitted for review. Only the person who submitted it and the reviewers can see it; it is not analysed, and not searched by other participants, until it is published.</p>}
          {src.publication === 'returned' && (
            <p className="warn" role="note">{returnedNotice(src.returnedReason)}</p>
          )}
        </Box>
      )}
      {src.publication === 'submitted' && isReviewer && (
        <SubmissionReview sourceId={sourceId} kind={src.kind} intendedMode={src.intendedMode} memberships={memberships} onDone={() => void load()} />
      )}
      {published && src.kind !== 'discussion' && (
        <AudiencePanel
          audience={src.audience}
          memberships={memberships}
          canChange={projectOpen && roles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor')}
          onChanged={() => void load()}
        />
      )}
      {published && src.kind !== 'discussion' && src.kind !== 'summary' && src.audience.mode === 'restricted' && mayDraftSummary(roles, projectOpen) && (
        <SummaryRequest target={{ kind: 'source', id: sourceId }} memberships={memberships} />
      )}
      <nav aria-label="Versions" className="versions">
        {detail.versions.map((v) => (
          <a key={v.id} href={`#/notes/${sourceId}/v/${v.versionNo}`} aria-current={v.versionNo === current ? 'page' : undefined}>
            Version {v.versionNo}
          </a>
        ))}
        {detail.mayAddVersion && <button className="quiet" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>Add a new version</button>}
      </nav>
      {adding && detail.mayAddVersion && (
        <section className="box" aria-label="Add a new version">
          <p className="hint">A new version keeps the old one. Proposals always point at the exact version they were made from.</p>
          <Intake
            withTitle={false}
            pasteUrl={`/notes/${sourceId}/versions`}
            uploadUrl={`/notes/${sourceId}/versions/upload`}
            submitLabel="Add version"
            onDone={(r) => {
              setAdding(false);
              void load().then(() => go(`#/notes/${sourceId}/v/${r.version.versionNo}`));
            }}
          />
        </section>
      )}
      <div className="split">
        <section aria-label="Notes text" className="note-text">
          <p className="meta">
            Version {version.versionNo}, {versionOriginText(version)}, {version.charCount.toLocaleString()} characters, added {formatWhen(version.createdAt)}.{' '}
            {version.origin === 'upload' && (version.originalWithheld ? <span className="warn" role="note">{version.originalWithheld}</span> : <a href={api.originalUrl(sourceId, version.versionNo)}>Download the original file</a>)}
          </p>
          {sourceStorageLabel(version.storage) && (
            <p className="meta">
              Storage: <span className={version.storage === 'failed' ? 'warn inline' : undefined}>{sourceStorageLabel(version.storage)}</span>
              {version.storage !== 'stored' && <span className="hint">The notes work as usual in Kainow while the files wait to be stored.</span>}
            </p>
          )}
          <div className="source" tabIndex={0}>
            {marked ? (
              <>
                {marked.before}
                <mark id={`item-${placeId}`} tabIndex={-1}>{marked.match}</mark>
                {marked.after}
              </>
            ) : (
              (text ?? 'Loading')
            )}
          </div>
        </section>
        {published && src.kind !== 'discussion' && src.mayExtract !== false && (
        <aside aria-labelledby="note-proposals-heading" className="box">
          <h2 id="note-proposals-heading" className="box-title">Proposals from this version</h2>
          <button className="primary" onClick={extract} disabled={starting || active}>
            {active ? 'Reading the notes' : runs.length ? 'Run again' : 'Find decisions and actions'}
          </button>
          {error && <p role="alert" className="error">{error}</p>}
          <AiSettingsLink projectId={src.projectId} show={runs[0]?.status === 'blocked'} />
          {runs.length === 0 && <p className="hint">Kainow sends this version to an AI model, then shows each proposal beside the passage it quoted. Nothing is saved as approved until you approve it.</p>}
          <ul className="list runs">
            {runs.map((r) => (
              <li key={r.id}>
                <StatusLabel meaning={STATUS_MEANING[r.status]} word={STATUS_TEXT[r.status]} />
                <span className="meta">{formatWhen(r.createdAt)}{r.requestedByLabel ? ` · ${r.requestedByLabel}` : ''}</span>
                {r.status === 'succeeded' && (
                  <>
                    <span>{plural(r.itemCount ?? 0, 'proposal')}{r.unlocatedCount ? `, ${r.unlocatedCount} not found in the notes` : ''}</span>
                    <a className="button" href={`#/runs/${r.id}`}>Review</a>
                  </>
                )}
                {(r.status === 'failed' || r.status === 'blocked') && <span className="reason">{runFailureText(r.failureCode, r.failureDetail)}</span>}
              </li>
            ))}
          </ul>
        </aside>
        )}
      </div>
    </main>
  );
}
