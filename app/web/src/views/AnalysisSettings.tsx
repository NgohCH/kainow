import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import {
  explanationSentence,
  getOrganisationAnalysis,
  getProjectAnalysis,
  historyLine,
  inheritanceLines,
  organisationChange,
  orgDraftFrom,
  type OrgAnalysisView,
  clearBody,
  type ProjectAnalysisView,
  projectChange,
  projectDraftFrom,
  projectReadOnlyMessage,
  putOrganisationAnalysis,
  putProjectAnalysis,
  quietError,
  type SettingsHistoryRow,
} from '../analysisSettings.ts';
import { formatWhen } from '../format.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

function History({ rows }: { rows: SettingsHistoryRow[] }) {
  if (rows.length === 0) return <p className="meta">No changes yet.</p>;
  return (
    <details>
      <summary>Change history ({rows.length})</summary>
      <ul className="plain">
        {rows.map((h) => {
          const l = historyLine(h);
          return <li key={h.id}>{formatWhen(h.at)}: {l.who} {l.what} — {l.reason}</li>;
        })}
      </ul>
    </details>
  );
}

/** Shared by both forms: the saved message gets focus, so a screen reader reads it where the person was working. */
function useSavedNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) ref.current?.focus();
  }, [notice]);
  return { notice, setNotice, ref };
}

/** Administration → Organisation: the organisation's values and the delegation switch. Enterprise Administrator only. */
export function OrganisationAnalysisSettings() {
  const [view, setView] = useState<OrgAnalysisView | null>(null);
  const [draft, setDraft] = useState(orgDraftFrom({ automatic: true, quietMinutes: 5, projectsMayChange: false, history: [] }));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const saved = useSavedNotice();

  const show = useCallback((v: OrgAnalysisView) => {
    setView(v);
    setDraft(orgDraftFrom(v));
  }, []);
  useEffect(() => {
    getOrganisationAnalysis().then(show, (e) => setError(errText(e)));
  }, [show]);

  if (!view) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;
  const quiet = quietError(draft.quietText);
  const body = organisationChange(view, draft, reason);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    saved.setNotice(null);
    if (quiet) return setError(quiet);
    if (!body || !view) return;
    if (reason.trim() === '') return setError('Give a reason for the change.');
    try {
      show(await putOrganisationAnalysis(body));
      setReason('');
      saved.setNotice('Saved. The change applies from the next check.');
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <form className="stack" onSubmit={save} aria-label="Automatic analysis for the organisation">
      <h2>Automatic analysis</h2>
      <p className="meta">{explanationSentence(view)} Projects use this unless you let them set their own. Changes never reprocess past messages.</p>
      <fieldset className="panel stack settings-group">
        <legend>Organisation values</legend>
        <label className="check">
          <input type="checkbox" checked={draft.automatic} onChange={(e) => setDraft({ ...draft, automatic: e.target.checked })} /> Analyse discussions automatically
        </label>
        <label>
          Quiet period in minutes
          <input inputMode="numeric" value={draft.quietText} aria-invalid={quiet ? true : undefined} aria-describedby={quiet ? 'quiet-error quiet-hint' : 'quiet-hint'} onChange={(e) => setDraft({ ...draft, quietText: e.target.value })} />
          <span id="quiet-hint" className="hint">A whole number of minutes from 5 to 30. Analysis starts after this long without new messages.</span>
          {quiet && <span id="quiet-error" role="alert" className="error">{quiet}</span>}
        </label>
        <p className="meta">Fixed in this version: at most 2 automatic analyses per thread in any rolling 20 minutes.</p>
      </fieldset>
      <fieldset className="panel stack settings-group">
        <legend>What projects may change for themselves</legend>
        <label className="check">
          <input type="checkbox" checked={draft.projectsMayChange} onChange={(e) => setDraft({ ...draft, projectsMayChange: e.target.checked })} /> Projects may change automatic analysis
        </label>
      </fieldset>
      <div className="panel stack">
        <label>
          Reason for the change
          <textarea required rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        {!body && <p className="meta">Change a setting to save it.</p>}
        <button className="primary" disabled={!body || !!quiet}>Save changes</button>
      </div>
      <p ref={saved.ref} role="status" tabIndex={-1} className={saved.notice ? 'ok' : 'visually-hidden'}>{saved.notice ?? ''}</p>
      <History rows={view.history} />
    </form>
  );
}

/** Project → Settings. Everyone who can read the project sees the values; editing follows `canEdit`. */
export function ProjectAnalysisSettings({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProjectAnalysisView | null>(null);
  const [draft, setDraft] = useState(projectDraftFrom({ automatic: true, quietMinutes: 5, projectsMayChange: false, source: { automatic: 'organisation', quietMinutes: 'organisation' }, own: { automatic: null, quietMinutes: null }, canEdit: false, history: [] }));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const saved = useSavedNotice();

  const show = useCallback((v: ProjectAnalysisView) => {
    setView(v);
    setDraft(projectDraftFrom(v));
  }, []);
  useEffect(() => {
    getProjectAnalysis(projectId).then(show, (e) => setError(errText(e)));
  }, [projectId, show]);

  if (!view) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;
  const from = inheritanceLines(view);
  const why = projectReadOnlyMessage(view);
  const quiet = draft.quietBack ? null : quietError(draft.quietText);
  const body = projectChange(view, draft, reason);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    saved.setNotice(null);
    if (quiet) return setError(quiet);
    if (!body) return;
    if (reason.trim() === '') return setError('Give a reason for the change.');
    try {
      show(await putProjectAnalysis(projectId, body));
      setReason('');
      saved.setNotice('Saved. The change applies from the next check.');
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <section aria-label="Automatic analysis for this project" className="stack">
      <h2>Automatic analysis</h2>
      <p className="meta">{explanationSentence(view)}</p>
      {why !== null ? (
        <>
          <dl className="facts">
            <div><dt>Automatic analysis</dt><dd>{view.automatic ? 'On' : 'Off'}<span className="meta"> · {from.automatic}</span></dd></div>
            <div><dt>Quiet period</dt><dd>{view.quietMinutes} minutes<span className="meta"> · {from.quietMinutes}</span></dd></div>
          </dl>
          <p className="meta">{why}</p>
          {view.canClear && clearBody(view, reason) && (
            <form
              className="panel stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                saved.setNotice(null);
                const clear = clearBody(view, reason);
                if (!clear || reason.trim() === '') return setError('Give a reason for the change.');
                try {
                  show(await putProjectAnalysis(projectId, clear));
                  setReason('');
                  saved.setNotice('Saved. This project now uses the organisation’s values.');
                } catch (err) {
                  setError(errText(err));
                }
              }}
            >
              <label>
                Reason for the change
                <textarea required rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button className="primary">Use the organisation&apos;s value</button>
            </form>
          )}
        </>
      ) : (
        <form className="stack" onSubmit={save}>
          <fieldset className="panel stack settings-group">
            <legend>This project</legend>
            <div className="setting">
              <label className="check">
                <input type="checkbox" checked={draft.automatic} disabled={draft.automaticBack} onChange={(e) => setDraft({ ...draft, automatic: e.target.checked })} /> Analyse discussions automatically
              </label>
              <span className="hint">{from.automatic}</span>
              {view.source.automatic === 'project' && (
                <button type="button" className="quiet" aria-pressed={draft.automaticBack} onClick={() => setDraft({ ...draft, automaticBack: !draft.automaticBack })}>
                  {draft.automaticBack ? 'Keep the value set for this project' : "Use the organisation's value"}
                </button>
              )}
            </div>
            <div className="setting">
              <label>
                Quiet period in minutes
                <input inputMode="numeric" value={draft.quietText} disabled={draft.quietBack} aria-invalid={quiet ? true : undefined} aria-describedby={quiet ? 'project-quiet-error project-quiet-hint' : 'project-quiet-hint'} onChange={(e) => setDraft({ ...draft, quietText: e.target.value })} />
                <span id="project-quiet-hint" className="hint">A whole number of minutes from 5 to 30.</span>
                {quiet && <span id="project-quiet-error" role="alert" className="error">{quiet}</span>}
              </label>
              <span className="hint">{from.quietMinutes}</span>
              {view.source.quietMinutes === 'project' && (
                <button type="button" className="quiet" aria-pressed={draft.quietBack} onClick={() => setDraft({ ...draft, quietBack: !draft.quietBack })}>
                  {draft.quietBack ? 'Keep the value set for this project' : "Use the organisation's value"}
                </button>
              )}
            </div>
          </fieldset>
          <div className="panel stack">
            <label>
              Reason for the change
              <textarea required rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {error && <p role="alert" className="error">{error}</p>}
            {!body && <p className="meta">Change a setting to save it.</p>}
            <button className="primary" disabled={!body || !!quiet}>Save changes</button>
          </div>
        </form>
      )}
      {why !== null && error && <p role="alert" className="error">{error}</p>}
      <p ref={saved.ref} role="status" tabIndex={-1} className={saved.notice ? 'ok' : 'visually-hidden'}>{saved.notice ?? ''}</p>
      <History rows={view.history} />
    </section>
  );
}
