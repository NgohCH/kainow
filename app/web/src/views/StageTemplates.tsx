import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { SettingsPage, type SettingsPageItem } from '../ui/SettingsPage.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { type StageTemplate, TEMPLATE_LIMITS as L, validateTemplateDraft } from '../ui/stages.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

interface DraftStage { key: number; name: string; substages: { key: number; name: string }[] }
let nextKey = 1;
const fromTemplate = (t?: StageTemplate): DraftStage[] =>
  (t?.stages ?? [{ name: '', substages: [] }]).map((s) => ({ key: nextKey++, name: s.name, substages: s.substages.map((n) => ({ key: nextKey++, name: n })) }));

export function StageList({ stages }: { stages: StageTemplate['stages'] }) {
  return (
    <ol className="stage-list">
      {stages.map((s) => (
        <li key={s.name}>
          {s.name}
          {s.substages.length > 0 && <span className="row-note"> ({s.substages.join(', ')})</span>}
        </li>
      ))}
    </ol>
  );
}

/** Add a template, or change one: name, description, the stage list (moved with buttons, no dragging), and a reason. */
function TemplateEditor({ template, onSaved, close }: { template?: StageTemplate; onSaved: () => void; close: () => void }) {
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [stages, setStages] = useState<DraftStage[]>(() => fromTemplate(template));
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, f: (s: DraftStage) => DraftStage) => setStages((all) => all.map((s, j) => (j === i ? f(s) : s)));
  const move = (i: number, by: -1 | 1) =>
    setStages((all) => {
      const next = [...all];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = { name, description, stages: stages.map((s) => ({ name: s.name, substages: s.substages.map((x) => x.name) })), reason };
    const found = validateTemplateDraft(body);
    setProblems(found);
    setError(null);
    if (found.length > 0) return;
    setBusy(true);
    try {
      if (template) await api.put(`/stage-templates/${template.id}`, body);
      else await api.post('/stage-templates', body);
      onSaved();
      close();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <label>
        Template name
        <input required maxLength={L.nameChars} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Description (optional)
        <textarea rows={2} maxLength={L.descriptionChars} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <fieldset>
        <legend>Stages, in order</legend>
        <p className="meta">A project that uses this template starts in its first stage. Changing a template does not change projects already using it.</p>
        <ol className="stage-editor">
          {stages.map((s, i) => (
            <li key={s.key} className="stage-editor-item">
              <div className="row">
                <label>
                  Stage {i + 1} name
                  <input maxLength={L.nameChars} value={s.name} onChange={(e) => patch(i, (x) => ({ ...x, name: e.target.value }))} />
                </label>
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move stage ${i + 1} up`}>Move up</button>
                <button type="button" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label={`Move stage ${i + 1} down`}>Move down</button>
                <button type="button" onClick={() => setStages((all) => all.filter((_, j) => j !== i))} aria-label={`Remove stage ${i + 1}`}>Remove stage</button>
              </div>
              <ul className="substage-editor">
                {s.substages.map((sub, k) => (
                  <li key={sub.key} className="row">
                    <label>
                      Substage {k + 1} of stage {i + 1}
                      <input
                        maxLength={L.nameChars}
                        value={sub.name}
                        onChange={(e) => patch(i, (x) => ({ ...x, substages: x.substages.map((y) => (y.key === sub.key ? { ...y, name: e.target.value } : y)) }))}
                      />
                    </label>
                    <button type="button" onClick={() => patch(i, (x) => ({ ...x, substages: x.substages.filter((y) => y.key !== sub.key) }))} aria-label={`Remove substage ${k + 1} of stage ${i + 1}`}>Remove</button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={s.substages.length >= L.substagesPerStage}
                onClick={() => patch(i, (x) => ({ ...x, substages: [...x.substages, { key: nextKey++, name: '' }] }))}
              >
                Add a substage to stage {i + 1}
              </button>
            </li>
          ))}
        </ol>
        <button type="button" disabled={stages.length >= L.stages} onClick={() => setStages((all) => [...all, { key: nextKey++, name: '', substages: [] }])}>Add a stage</button>
      </fieldset>
      <label>
        Reason for the change
        <input required maxLength={L.reasonChars} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {problems.length > 0 && (
        <ul role="alert" className="error">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row">
        <button className="primary" disabled={busy}>{template ? 'Save template' : 'Add template'}</button>
        <button type="button" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

/** Retire or bring back, with a reason. */
function StatusForm({ template, onSaved, close }: { template: StageTemplate; onSaved: () => void; close: () => void }) {
  const retiring = template.status === 'active';
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/stage-templates/${template.id}/${retiring ? 'retire' : 'restore'}`, { reason });
      onSaved();
      close();
    } catch (err) {
      setError(errText(err));
    }
  }
  return (
    <form className="stack" onSubmit={submit}>
      <p className="meta">
        {retiring
          ? 'A retired template cannot be chosen for new projects. Projects already using it keep their stages.'
          : 'A template that is brought back can be chosen for new projects again.'}
      </p>
      <label>
        Reason
        <input required maxLength={L.reasonChars} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary">{retiring ? 'Retire template' : 'Bring back template'}</button>
    </form>
  );
}

const statusLabel = (t: StageTemplate) => <StatusLabel meaning={t.status === 'active' ? 'active' : 'off'} word={t.status === 'active' ? 'In use' : 'Retired'} />;

/** Stage templates: the ready-made stage lists a new project chooses from. Administrators only. */
export function StageTemplates() {
  const [list, setList] = useState<StageTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<{ templates: StageTemplate[] }>('/stage-templates?all=1').then((r) => setList(r.templates), (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  const columns: Column<StageTemplate>[] = [
    { key: 'name', header: 'Name', sortValue: (t) => t.name.toLowerCase(), cell: (t) => t.name },
    { key: 'stages', header: 'Stages', sortValue: (t) => t.stages.length, cell: (t) => `${t.stages.length}: ${t.stages.map((s) => s.name).join(', ')}` },
    { key: 'using', header: 'Projects using it', sortValue: (t) => t.projectsUsing ?? 0, cell: (t) => String(t.projectsUsing ?? 0) },
    { key: 'status', header: 'Status', sortValue: (t) => t.status, cell: statusLabel },
  ];

  const items: SettingsPageItem[] = [
    {
      key: 'add',
      title: 'Add a template',
      opener: 'Add',
      current: <p className="meta">A new template starts with the stages you list. Give a reason so the change history says why.</p>,
      form: (close) => <TemplateEditor onSaved={load} close={close} />,
    },
    ...(list ?? []).map((t): SettingsPageItem => ({
      key: `t-${t.id}`,
      title: t.name,
      current: (
        <>
          <p>
            {statusLabel(t)} <span className="meta">Projects using it: {t.projectsUsing ?? 0}. Made by {t.createdByName}.</span>
          </p>
          {t.description && <p>{t.description}</p>}
          <StageList stages={t.stages} />
        </>
      ),
      form: (close) => (
        <>
          {t.status === 'active' && <TemplateEditor template={t} onSaved={load} close={close} />}
          <h4>{t.status === 'active' ? 'Retire this template' : 'Bring this template back'}</h4>
          <StatusForm template={t} onSaved={load} close={close} />
        </>
      ),
    })),
  ];

  return (
    <main className="page">
      <SettingsPage
        header={{ crumbs: [{ text: 'Settings', href: '#/settings' }], title: 'Stage templates', intro: 'Ready-made stage lists. A new project chooses one and starts in its first stage.' }}
        glance={
          <>
            {error && <p role="alert" className="error">{error}</p>}
            <DataTable caption="Stage templates" columns={columns} rows={list ?? []} rowKey={(t) => t.id} loading={list === null && !error} empty="No templates yet." />
          </>
        }
        settings={items}
      />
    </main>
  );
}
