import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api, type Project } from '../api.ts';
import { formatWhen } from '../format.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { TEMPLATE_LIMITS, type ProjectStage, type StageChange, stageChangeText, validateTemplateDraft } from '../ui/stages.ts';

const HISTORY_COLUMNS: Column<StageChange>[] = [
  { key: 'at', header: 'When (UTC+8)', cell: (c) => formatWhen(c.at) },
  { key: 'actor', header: 'Who', cell: (c) => c.actor },
  { key: 'change', header: 'Change', cell: (c) => stageChangeText(c) },
  { key: 'reason', header: 'Reason', cell: (c) => c.reason },
];

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** Who may change a project's stages, and while the project is in what state (the server decides; this only explains). */
export function stagesEditable(project: Project): boolean {
  return project.myRoles.some((r) => r === 'pm' || r === 'owner' || r === 'sponsor') && !['deferred', 'closed'].includes(project.status) && !project.archived;
}

/** What the Stages box shows before it is opened. */
export function StagesSummary({ project }: { project: Project }) {
  const active = project.stages.filter((s) => s.status === 'active');
  const retired = project.stages.length - active.length;
  return (
    <p>
      {project.stageTemplate ? `From the template ${project.stageTemplate.name}. ` : ''}
      {active.length} {active.length === 1 ? 'stage' : 'stages'}: {active.map((s) => s.name).join(', ') || 'none'}.
      {retired > 0 ? ` ${retired} retired.` : ''}
    </p>
  );
}

/**
 * The project's own stages (D131), in order: move one up or down, retire one or bring it back, add one. Each change
 * is saved at once with the reason written above the list and is recorded. Everyone who can read the project sees the
 * list and its history; the Project Manager, Owner and Sponsors change it.
 */
export function StagesEditor({ project, reload }: { project: Project; reload: () => void }) {
  const editable = stagesEditable(project);
  const { stages } = project;
  const currentName = project.stage?.stage ?? null;
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const focusAfter = useRef<string | null>(null);

  // After a change the list is drawn again; put focus back on the button that was used (or the one beside it).
  useEffect(() => {
    if (!focusAfter.current) return;
    const el = document.querySelector<HTMLElement>(`[data-stage-action="${focusAfter.current}"]:not(:disabled)`);
    (el ?? document.getElementById('stages-reason'))?.focus();
    focusAfter.current = null;
  }, [stages]);

  async function change(path: string, body: Record<string, unknown>, done: string, focus: string | null) {
    setError(null);
    setNotice(null);
    if (reason.trim() === '') {
      setError('Give a reason for the change first.');
      document.getElementById('stages-reason')?.focus();
      return false;
    }
    setBusy(true);
    try {
      await api.post(`/projects/${project.id}/${path}`, { ...body, reason: reason.trim() });
      focusAfter.current = focus;
      setNotice(done);
      setReason('');
      reload();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const move = (i: number, by: -1 | 1) => {
    const ids = stages.map((s) => s.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    return change('stages/order', { ids }, `${stages[i].name} moved ${by < 0 ? 'up' : 'down'}.`, `${stages[i].id}:${by < 0 ? 'up' : 'down'}`);
  };

  return (
    <div className="stack">
      {!editable && (
        <p className="meta">
          {project.archived || ['deferred', 'closed'].includes(project.status)
            ? 'The stages cannot be changed while the project is Deferred, Closed or archived.'
            : 'Only the Project Manager, an Owner or a Sponsor can change the stages.'}
        </p>
      )}
      {editable && (
        <label>
          Reason for the change
          <input id="stages-reason" maxLength={TEMPLATE_LIMITS.reasonChars} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      <ol className="stage-editor">
        {stages.map((s, i) => {
          const isCurrent = s.name === currentName;
          return (
            <li key={s.id} className="stage-editor-item">
              <div className="row">
                <span>
                  {i + 1}. {s.name}
                  {s.substages.length > 0 && <span className="row-note"> ({s.substages.join(', ')})</span>}
                </span>
                {isCurrent && <StatusLabel meaning="active" word="Current stage" />}
                {s.status === 'retired' && <StatusLabel meaning="off" word="Retired" />}
              </div>
              {editable && (
                <div className="row">
                  <button type="button" data-stage-action={`${s.id}:up`} disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.name} up`}>Move up</button>
                  <button type="button" data-stage-action={`${s.id}:down`} disabled={busy || i === stages.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.name} down`}>Move down</button>
                  {s.status === 'active' ? (
                    <button
                      type="button"
                      data-stage-action={`${s.id}:retire`}
                      disabled={busy || isCurrent}
                      title={isCurrent ? 'This is the current stage. Move to another stage first.' : undefined}
                      onClick={() => change(`stages/${s.id}/retire`, {}, `${s.name} retired.`, `${s.id}:restore`)}
                      aria-label={`Retire ${s.name}`}
                    >
                      Retire
                    </button>
                  ) : (
                    <button type="button" data-stage-action={`${s.id}:restore`} disabled={busy} onClick={() => change(`stages/${s.id}/restore`, {}, `${s.name} brought back.`, `${s.id}:retire`)} aria-label={`Bring back ${s.name}`}>
                      Bring back
                    </button>
                  )}
                </div>
              )}
              {isCurrent && editable && <p className="meta">This is the current stage. Move to another stage before retiring it.</p>}
            </li>
          );
        })}
      </ol>
      {editable && <AddStage stages={stages} busy={busy} change={change} />}
      <DataTable caption="Change history" columns={HISTORY_COLUMNS} rows={project.stageChanges} rowKey={(c) => c.id} empty="No changes yet." />
    </div>
  );
}

function AddStage({ stages, busy, change }: { stages: ProjectStage[]; busy: boolean; change: (path: string, body: Record<string, unknown>, done: string, focus: string | null) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [substages, setSubstages] = useState('');
  const [position, setPosition] = useState(stages.length + 1);
  const [problems, setProblems] = useState<string[]>([]);
  // A stage added at the end stays "at the end" as the list grows.
  const [atEnd, setAtEnd] = useState(true);
  const place = atEnd ? stages.length + 1 : Math.min(position, stages.length + 1);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const subs = substages.split('\n').map((x) => x.trim()).filter((x) => x !== '');
    const found = validateTemplateDraft({ name: 'Stage', stages: [{ name, substages: subs }] });
    if (stages.some((s) => s.name.toLowerCase() === name.trim().toLowerCase())) found.push('This project already has a stage with that name.');
    if (stages.filter((s) => s.status === 'active').length >= TEMPLATE_LIMITS.stages) found.push(`A project can have at most ${TEMPLATE_LIMITS.stages} stages in use. Retire one first.`);
    setProblems(found);
    if (found.length > 0) return;
    if (await change('stages', { name: name.trim(), substages: subs, position: place }, `${name.trim()} added.`, null)) {
      setName('');
      setSubstages('');
      setAtEnd(true);
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label="Add a stage">
      <h4>Add a stage</h4>
      <label>
        Stage name
        <input maxLength={TEMPLATE_LIMITS.nameChars} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Substages (optional, one on each line)
        <textarea rows={3} value={substages} onChange={(e) => setSubstages(e.target.value)} />
      </label>
      <label>
        Place in the list
        <select
          value={place}
          onChange={(e) => {
            setPosition(Number(e.target.value));
            setAtEnd(Number(e.target.value) === stages.length + 1);
          }}
        >
          {stages.length > 0 && <option value={1}>At the start</option>}
          {stages.slice(0, -1).map((s, i) => (
            <option key={s.id} value={i + 2}>After {s.name}</option>
          ))}
          <option value={stages.length + 1}>{stages.length > 0 ? `At the end, after ${stages[stages.length - 1].name}` : 'First stage'}</option>
        </select>
      </label>
      {problems.length > 0 && (
        <ul role="alert" className="error">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      <div className="row">
        <button className="primary" disabled={busy}>Add stage</button>
      </div>
    </form>
  );
}
