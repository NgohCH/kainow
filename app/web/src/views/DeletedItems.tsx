import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Project } from '../api.ts';
import { threadPath } from '../discussion.ts';
import { formatWhen } from '../format.ts';
import {
  type DeletedDetail,
  type DeletedItem,
  type DeletedKind,
  KIND_NOUN,
  type RecordKind,
  type SourceKind,
  deletedLabel,
  getDeletedItem,
  isRecordKind,
  listDeletedItems,
  mayRestoreRecord,
  mayRestoreSource,
} from '../history.ts';
import { RestoreAction } from './DeleteRestore.tsx';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const KINDS = new Set<string>(Object.keys(KIND_NOUN));

/** The project's Deleted items, for a holder of Inspect Deleted Content (read-only; the server answers 404 to anyone else). */
export function DeletedItemsList({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<DeletedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listDeletedItems(projectId).then(setItems, (e) => setError(errText(e, 'Could not load the Deleted items.')));
  }, [projectId]);
  return (
    <section aria-labelledby="deleted-items-heading">
      <h2 id="deleted-items-heading">Deleted items</h2>
      <p className="meta">Read-only. Your access includes Inspect Deleted Content for this project, and each time you open one is recorded. These items are not searched, summarised or used to answer questions.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {!items && !error && <p className="loading">Loading</p>}
      {items && items.length === 0 && <p className="empty">Nothing is deleted at present.</p>}
      {items && items.length > 0 && (
        <ul className="list">
          {items.map((i) => (
            <li key={`${i.kind}:${i.id}`}>
              <a href={i.href}>
                <strong>{i.title}</strong>
                <span className="meta">
                  {KIND_NOUN[i.kind][0].toUpperCase() + KIND_NOUN[i.kind].slice(1)} · {deletedLabel(i.deletedBy, i.deletedAt, i.deleteReason)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One Deleted item, read-only, with its Deleted label. Restore is offered to those who may restore it. */
export function DeletedItemPage({ projectId, kind, itemId }: { projectId: string; kind: string; itemId: string }) {
  const [item, setItem] = useState<DeletedDetail | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const back = `#/projects/${projectId}/deleted`;

  useEffect(() => {
    if (!KINDS.has(kind)) return setError('That item could not be found.');
    getDeletedItem(projectId, kind as DeletedKind, itemId).then(setItem, (e) => setError(errText(e, 'Could not load this item.')));
    api.get<{ project: Project }>(`/projects/${projectId}`).then((r) => setProject(r.project), () => undefined);
  }, [projectId, kind, itemId]);

  const done = useCallback((message: string) => {
    setRestored(message);
    setItem(null);
  }, []);

  if (restored) {
    return (
      <main className="page narrow">
        <p role="status">{restored}</p>
        <p><a href={back}>Back to Deleted items</a></p>
      </main>
    );
  }
  if (!item) {
    return (
      <main className="page narrow">
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
        <p><a href={back}>Back to Deleted items</a></p>
      </main>
    );
  }
  const roles = project?.myRoles ?? [];
  const delegated = Boolean(project?.recordDeletionDelegation);
  const restorable: SourceKind | RecordKind | null =
    item.kind === 'message'
      ? null
      : isRecordKind(item.kind)
        ? mayRestoreRecord(roles, delegated)
          ? item.kind
          : null
        : mayRestoreSource(roles)
          ? item.kind
          : null;

  return (
    <main className="page narrow">
      <p><a href={back}>Back to Deleted items</a></p>
      <h1>{item.title}</h1>
      <p className="warn" role="note">{deletedLabel(item.deletedBy, item.deletedAt, item.deleteReason)}</p>
      <p className="meta">{KIND_NOUN[item.kind][0].toUpperCase() + KIND_NOUN[item.kind].slice(1)}. Read-only.</p>
      <DeletedBody item={item} projectId={projectId} />
      {restorable && (
        <p>
          <RestoreAction kind={restorable} id={item.id} label={item.title} onDone={done} />
        </p>
      )}
      {item.kind === 'message' && <p className="meta">A deleted message is restored from its thread by the Project Manager or a Deputy.</p>}
    </main>
  );
}

function DeletedBody({ item, projectId }: { item: DeletedDetail; projectId: string }) {
  switch (item.kind) {
    case 'note':
    case 'minutes':
    case 'summary':
      return (
        <section aria-label="Text">
          {item.versionNo !== undefined && <p className="meta">Latest version: {item.versionNo}</p>}
          <div className="source" tabIndex={0}>{item.text}</div>
        </section>
      );
    case 'message':
      return (
        <section aria-label="Message">
          <p className="meta">
            {item.no !== undefined ? `#${item.no} · ` : ''}
            {item.author}
            {item.createdAt ? ` · ${formatWhen(item.createdAt)}` : ''}
          </p>
          <p className="message-text">{item.text}</p>
          {item.threadId && <p><a href={`${threadPath(projectId, item.threadId)}${item.no !== undefined ? `?m=${item.no}` : ''}`}>Open its thread</a></p>}
        </section>
      );
    case 'task':
      return (
        <dl className="facts">
          <dt>Status</dt>
          <dd>{item.status}</dd>
          <dt>Assigned to</dt>
          <dd>{item.assignee}</dd>
          <dt>Due</dt>
          <dd>{item.dueOn}</dd>
        </dl>
      );
    case 'decision':
      return (
        <dl className="facts">
          <dt>Status</dt>
          <dd>{item.status}</dd>
          {item.rationale && (
            <>
              <dt>Rationale</dt>
              <dd>{item.rationale}</dd>
            </>
          )}
        </dl>
      );
    case 'question':
      return (
        <>
          <dl className="facts">
            <dt>Status</dt>
            <dd>{item.status}</dd>
          </dl>
          {item.answers && item.answers.length > 0 && (
            <ul className="plain answers" aria-label="Answers">
              {item.answers.map((a, i) => (
                <li key={i}>
                  {a.text} <span className="meta">— {a.author}, {formatWhen(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    case 'risk':
      return (
        <dl className="facts">
          <dt>Status</dt>
          <dd>{item.status}</dd>
          <dt>Severity</dt>
          <dd>{item.severity}</dd>
          {item.mitigation && (
            <>
              <dt>Mitigation</dt>
              <dd>{item.mitigation}</dd>
            </>
          )}
          {item.reviewOn && (
            <>
              <dt>Review on</dt>
              <dd>{item.reviewOn}</dd>
            </>
          )}
        </dl>
      );
  }
}
