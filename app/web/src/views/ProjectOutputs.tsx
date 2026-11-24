import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatDay, formatWhen, plural } from '../format.ts';
import {
  type DeletedOutput, EXPORT_NAME, type ExportKind, type OutputSettingsView, type OutputSummary, checkLabel, exportControls,
  exportPath, filenameFromDisposition, filingLabel, formatLabel, outputMeaning, outputStatusLabel, versionMeaning, versionStatusLabel,
} from '../outputs.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import type { ProjectRole, ProjectStatus } from '../projects.ts';
import { OutputPage, type ProjectPeople } from './OutputPage.tsx';
import { useOutputPolicy, useReportTypes, useReturnFocus } from './ProjectOutputSettings.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/**
 * "Export CSV" and "Save as output" for one kind of record, with the screen's current filters. Nothing at all is shown
 * unless the server says this person may export (spec 7.1); "Save as output" only when they may also submit.
 */
export function ExportControls({ projectId, kind, filters = {}, policy, onSaved }: {
  projectId: string;
  kind: ExportKind;
  filters?: Record<string, string | undefined>;
  policy: OutputSettingsView | null;
  onSaved?: (message: string) => void;
}) {
  const controls = exportControls(policy);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remember = useReturnFocus(saving);
  if (controls.length === 0) return null;
  const name = EXPORT_NAME[kind];

  /** Fetches the CSV first: a refusal is shown here in words, never saved as a file. */
  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(api.url(exportPath(projectId, kind, filters)), { credentials: 'same-origin' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
        const m = body?.message;
        setError((Array.isArray(m) ? m.join(' ') : m) || 'The export could not be made. Try again.');
        return;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filenameFromDisposition(res.headers.get('Content-Disposition'), `${kind}.csv`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch {
      setError('Cannot reach the Kainow server. Check that it is running, then try again.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="actions">
      <button type="button" onClick={() => void download()} disabled={downloading}>
        Export CSV<span className="visually-hidden"> of the {name}</span>
      </button>
      {controls.includes('save') && (
        <button type="button" aria-expanded={saving} onClick={() => { if (!saving) remember(); setSaving((v) => !v); }}>
          Save as output<span className="visually-hidden">: the {name} export</span>
        </button>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {saving && (
        <SaveExportForm
          projectId={projectId}
          kind={kind}
          filters={filters}
          mayChooseExisting={policy?.mayManage === true}
          onDone={(m) => {
            setSaving(false);
            onSaved?.(m);
          }}
          onCancel={() => setSaving(false)}
        />
      )}
    </div>
  );
}

/** Saves an export as a submitted output, or as a new version of a registered one (spec 7.3). */
function SaveExportForm({ projectId, kind, filters, mayChooseExisting, onDone, onCancel }: {
  projectId: string; kind: ExportKind; filters: Record<string, string | undefined>; mayChooseExisting: boolean; onDone: (message: string) => void; onCancel: () => void;
}) {
  const types = useReportTypes();
  const [registered, setRegistered] = useState<OutputSummary[]>([]);
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [typeId, setTypeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the Project Manager or a Deputy may add a version to an existing output (output.manage).
  useEffect(() => {
    if (!mayChooseExisting) return;
    api.get<{ outputs: OutputSummary[] }>(`/projects/${projectId}/outputs?status=registered`).then((r) => setRegistered(r.outputs), () => setRegistered([]));
  }, [projectId, mayChooseExisting]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    try {
      const body = target
        ? { kind, filters: clean, outputId: target }
        : { kind, filters: clean, ...(title.trim() ? { title } : {}), ...(typeId ? { reportTypeId: typeId } : {}) };
      const r = await api.post<{ id: string; title: string }>(`/projects/${projectId}/export/save`, body);
      onDone(target ? `Saved as a new version of "${r.title}".` : `Saved as the output "${r.title}". It waits to be registered.`);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="box stack change-form" onSubmit={submit} aria-label={`Save the ${EXPORT_NAME[kind]} export as an output`}>
      {mayChooseExisting && (
        <label>
          Save as
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">A new output</option>
            {registered.map((o) => (
              <option key={o.id} value={o.id}>A new version of "{o.title}"</option>
            ))}
          </select>
        </label>
      )}
      {!target && (
        <>
          <label>
            Title <span className="hint">Optional: the export's name and today's date when left empty.</span>
            <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Report type
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Exports (the default)</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        </>
      )}
      <p className="hint">The CSV is saved as it is now, with the filters on this screen. It is readable by everyone in the project.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy}>Save as output</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Submitting an uploaded document or a link to one (spec 4.1). Draft reports are submitted from the draft itself. */
function SubmitForm({ projectId, policy, onDone, onCancel }: { projectId: string; policy: OutputSettingsView; onDone: (o: { id: string; title: string }) => void; onCancel: () => void }) {
  const types = useReportTypes();
  const uid = useId();
  const [how, setHow] = useState<'upload' | 'link'>('upload');
  const [title, setTitle] = useState('');
  const [typeId, setTypeId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formats = policy.formats.output.map((f) => f.format);
  const accept = formats.map((f) => (f === 'md' ? '.md,.markdown' : `.${f}`)).join(',');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let r: { id: string; title: string };
      if (how === 'upload') {
        if (!file) throw new ApiError('Choose the file to upload.', 400);
        const form = new FormData();
        form.append('title', title);
        if (typeId) form.append('reportTypeId', typeId);
        form.append('file', file);
        r = await api.post(`/projects/${projectId}/outputs`, form);
      } else {
        r = await api.post(`/projects/${projectId}/outputs`, { kind: 'link', url, title, ...(typeId ? { reportTypeId: typeId } : {}) });
      }
      onDone(r);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="box stack change-form" onSubmit={submit} aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`} className="form-box-title">Submit an output</h3>
      <p className="meta">It waits for the Project Manager or a Deputy to register it. Submitting does not file or approve it.</p>
      <p className="hint">To submit a draft report, open it under Drafts and choose "Submit as output".</p>
      <fieldset>
        <legend>What are you submitting?</legend>
        <label className="check"><input type="radio" name={`${uid}-how`} checked={how === 'upload'} onChange={() => setHow('upload')} /> A file from this computer</label>
        <label className="check"><input type="radio" name={`${uid}-how`} checked={how === 'link'} onChange={() => setHow('link')} /> A link to a document in SharePoint or OneDrive</label>
      </fieldset>
      <label>
        Title
        <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Suggested report type
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          <option value="">Let the Project Manager choose</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </label>
      {how === 'upload' ? (
        <label>
          File
          <input type="file" required accept={accept} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span className="hint">This project accepts: {formats.map(formatLabel).join(', ') || 'none'}. Do not upload files holding passwords or keys.</span>
        </label>
      ) : (
        <label>
          Link
          <input type="url" required maxLength={2000} value={url} onChange={(e) => setUrl(e.target.value)} />
          <span className="hint">Kainow keeps the document where it is and does not manage its sharing. It must be in an approved storage location.</span>
        </label>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy}>Submit</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const yearOf = (day: string | null) => (day ? day.slice(0, 4) : '');

/** The Outputs tab: the register (summary first, then filters and the list), Submit, export, and deleted entries. */
export function ProjectOutputs({ projectId, outputId, roles, status, people }: {
  projectId: string; outputId?: string; roles: ProjectRole[]; status: ProjectStatus; people: ProjectPeople;
}) {
  if (outputId) return <OutputPage projectId={projectId} outputId={outputId} roles={roles} status={status} people={people} />;
  return <OutputRegister projectId={projectId} roles={roles} />;
}

function OutputRegister({ projectId, roles }: { projectId: string; roles: ProjectRole[] }) {
  const { policy } = useOutputPolicy(projectId);
  const types = useReportTypes();
  const [outputs, setOutputs] = useState<OutputSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [year, setYear] = useState('');
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  useReturnFocus(submitting, submitButton);
  const manages = roles.some((r) => r === 'pm' || r === 'deputy_pm');

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (statusFilter) q.set('status', statusFilter);
    if (typeFilter) q.set('reportTypeId', typeFilter);
    const qs = q.toString();
    api.get<{ outputs: OutputSummary[] }>(`/projects/${projectId}/outputs${qs ? `?${qs}` : ''}`).then(
      (r) => {
        setOutputs(r.outputs);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  }, [projectId, statusFilter, typeFilter]);
  useEffect(load, [load]);

  const years = useMemo(() => [...new Set((outputs ?? []).map((o) => yearOf(o.issueDate)).filter(Boolean))].sort().reverse(), [outputs]);
  const shown = (outputs ?? []).filter((o) => (!year || yearOf(o.issueDate) === year) && (!search.trim() || o.title.toLowerCase().includes(search.trim().toLowerCase())));
  const waiting = (outputs ?? []).filter((o) => o.status === 'submitted').length;
  const review = (outputs ?? []).filter((o) => o.reviewRequired).length;
  const columns: Column<OutputSummary>[] = [
    {
      key: 'title',
      header: 'Title',
      sortValue: (o) => o.title.toLowerCase(),
      cell: (o) => (
        <span>
          <a href={`#/projects/${projectId}/outputs/${o.id}`}>{o.title}</a>
          {(o.aiAssisted || o.audience.mode === 'restricted') && (
            <span className="meta work-parent">
              {[o.aiAssisted && 'AI-assisted', o.audience.mode === 'restricted' && 'Restricted'].filter(Boolean).join(' · ')}
            </span>
          )}
        </span>
      ),
    },
    { key: 'type', header: 'Report type', sortValue: (o) => o.reportType?.name.toLowerCase() ?? '', cell: (o) => o.reportType?.name ?? 'Not chosen yet' },
    { key: 'issued', header: 'Issue date', sortValue: (o) => o.issueDate ?? '', cell: (o) => (o.issueDate ? formatDay(`${o.issueDate}T00:00:00+08:00`) : 'Not issued yet') },
    {
      key: 'status',
      header: 'Status',
      sortValue: (o) => outputStatusLabel(o.status),
      cell: (o) => (
        <span className="label-stack">
          <StatusLabel meaning={outputMeaning(o.status)} word={outputStatusLabel(o.status)} />
          {o.reviewLabel && <StatusLabel meaning="review" word={o.reviewLabel} />}
        </span>
      ),
    },
    {
      key: 'version',
      header: 'Latest version',
      sortValue: (o) => o.latestVersion?.no ?? 0,
      cell: (o) => (o.latestVersion ? <StatusLabel meaning={versionMeaning(o.latestVersion.status)} word={`Version ${o.latestVersion.no}: ${versionStatusLabel(o.latestVersion.status)}`} /> : 'None'),
    },
    { key: 'filing', header: 'Filing', cell: (o) => (o.latestVersion ? o.latestVersion.filing.label || filingLabel(o.latestVersion.filing.state) : '—') },
    {
      key: 'check',
      header: 'Last check',
      cell: (o) => {
        const v = o.latestVersion;
        return v && v.filing.checkStatus ? checkLabel(v.filing.checkStatus, v.filing.lastCheckedAt, v.status) : '—';
      },
    },
  ];

  return (
    <section aria-labelledby="outputs-heading" className="box">
      <div className="settings-box-head">
        <h2 id="outputs-heading" className="box-title">Outputs</h2>
        {policy?.maySubmit && !submitting && <button type="button" ref={submitButton} className="primary" onClick={() => setSubmitting(true)}>Submit an output</button>}
      </div>
      {outputs && (
        <>
          <div className="stat-grid">
            <StatTile label={statusFilter || typeFilter ? 'In the register (filtered)' : 'In the register'} value={String(outputs.length)} />
            <StatTile label="Waiting to be registered" value={String(waiting)} meaning={waiting > 0 ? 'review' : undefined} word={waiting > 0 ? 'Submitted' : undefined} />
            <StatTile label="Access review needed" value={String(review)} meaning={review > 0 ? 'attention' : undefined} word={review > 0 ? 'Needs review' : undefined} />
          </div>
          <p role="status" className="visually-hidden">
            {plural(outputs.length, 'output')} in the register{statusFilter || typeFilter ? ' (filtered)' : ''}
            {waiting > 0 ? ` · ${waiting} submitted, waiting to be registered` : ''}
            {review > 0 ? ` · ${review} need an access review` : ''}
          </p>
        </>
      )}
      {notice && <p role="status" className="meta">{notice}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {submitting && policy && (
        <SubmitForm
          projectId={projectId}
          policy={policy}
          onCancel={() => setSubmitting(false)}
          onDone={(o) => {
            setSubmitting(false);
            setNotice(`Submitted "${o.title}". It waits for the Project Manager or a Deputy to register it.`);
            load();
          }}
        />
      )}
      <form className="inline-form filters" role="search" aria-label="Filter outputs" onSubmit={(e) => e.preventDefault()}>
        <label>
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Any</option>
            <option value="submitted">Submitted</option>
            <option value="registered">Registered</option>
            <option value="declined">Declined</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        </label>
        <label>
          Report type or category
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">Any</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label>
          Year
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="">Any</option>
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
        <label>
          Search titles <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </form>
      {statusFilter === 'withdrawn' ? (
        policy?.mayExport && <p className="hint">Withdrawn outputs are not exported. Choose another status to export the register.</p>
      ) : (
        <ExportControls
          projectId={projectId}
          kind="outputs"
          filters={{ status: statusFilter || undefined, reportTypeId: typeFilter || undefined }}
          policy={policy}
          onSaved={(m) => {
            setNotice(m);
            load();
          }}
        />
      )}
      <DataTable caption="Outputs register" columns={columns} rows={shown} rowKey={(o) => o.id} loading={!outputs && !error} empty="No outputs match." />
      {manages && <DeletedOutputs projectId={projectId} onRestored={(m) => { setNotice(m); load(); }} />}
    </section>
  );
}

/** Deleted register entries the PM or a Deputy may restore, with who deleted each, when and why. */
function DeletedOutputs({ projectId, onRestored }: { projectId: string; onRestored: (message: string) => void }) {
  const [rows, setRows] = useState<DeletedOutput[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const remember = useReturnFocus(open !== null, heading);
  const load = useCallback(() => {
    api.get<{ outputs: DeletedOutput[] }>(`/projects/${projectId}/outputs/deleted`).then((r) => setRows(r.outputs), () => setRows([]));
  }, [projectId]);
  useEffect(load, [load]);
  if (rows.length === 0) return null;
  const columns: Column<DeletedOutput>[] = [
    { key: 'title', header: 'Title', sortValue: (d) => d.title.toLowerCase(), cell: (d) => d.title },
    { key: 'deleted', header: 'Deleted', sortValue: (d) => d.deletedAt, cell: (d) => `${d.deletedBy.displayName}, ${formatWhen(d.deletedAt)}` },
    { key: 'reason', header: 'Reason', cell: (d) => `"${d.reason}"` },
    {
      key: 'restore',
      header: 'Restore',
      wide: true,
      cell: (d) => (
        <>
            {open !== d.id && <button type="button" className="link-button" onClick={() => { remember(); setOpen(d.id); setReason(''); setError(null); }}>Restore<span className="visually-hidden"> {d.title}</span></button>}
            {open === d.id && (
              <form
                className="inline-form stack change-form"
                aria-label={`Restore ${d.title}`}
                onKeyDown={(e) => e.key === 'Escape' && setOpen(null)}
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api.post(`/projects/${projectId}/outputs/${d.id}/restore`, { reason });
                    setOpen(null);
                    load();
                    onRestored(`Restored "${d.title}".`);
                  } catch (err) {
                    setError(errText(err));
                  }
                }}
              >
                <label>
                  Reason <input required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                <button className="primary">Restore</button>
                <button type="button" onClick={() => setOpen(null)}>Cancel</button>
                {error && <span role="alert" className="error">{error}</span>}
              </form>
            )}
        </>
      ),
    },
  ];
  return (
    <section aria-labelledby="deleted-outputs-heading" className="box">
      <h3 id="deleted-outputs-heading" className="box-title" tabIndex={-1} ref={heading}>Deleted outputs</h3>
      <p className="hint">Deleting never removed a file from storage. Restoring puts the entry back in the register.</p>
      <DataTable caption="Deleted register entries" columns={columns} rows={rows} rowKey={(d) => d.id} empty="None." />
    </section>
  );
}

/** "Submit as output" on a draft report version (spec 4.1): rendered in a format the project allows. */
export function SubmitDraftAsOutput({ projectId, draftVersionId, versionNo, title: draftTitle }: { projectId: string; draftVersionId: string; versionNo: number; title: string }) {
  const { policy } = useOutputPolicy(projectId);
  const types = useReportTypes();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(draftTitle.slice(0, 200));
  const [format, setFormat] = useState('');
  const [typeId, setTypeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  useReturnFocus(open, opener);
  if (!policy?.maySubmit) return null;
  const formats = policy.formats.output.map((f) => f.format).filter((f) => f === 'md' || f === 'docx' || f === 'pdf');
  const chosen = format || formats[0] || '';
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: string; title: string }>(`/projects/${projectId}/outputs`, {
        kind: 'draft', draftVersionId, format: chosen, title, ...(typeId ? { reportTypeId: typeId } : {}),
      });
      setDone(r);
      setOpen(false);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {done && (
        <p role="status">
          Submitted as the output <a href={`#/projects/${projectId}/outputs/${done.id}`}>{done.title}</a>. It waits for the Project Manager or a Deputy to register it.
        </p>
      )}
      {!open && <button type="button" ref={opener} onClick={() => { setOpen(true); setDone(null); }}>Submit as output<span className="visually-hidden"> (version {versionNo})</span></button>}
      {open && (
        <form className="box stack change-form" aria-labelledby={`${uid}-h`} onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <h3 id={`${uid}-h`} className="form-box-title">Submit version {versionNo} as an output</h3>
          {formats.length === 0 ? (
            <p className="warn">This project makes no Markdown, DOCX or PDF outputs. A PM, Owner or Sponsor can change this in Project settings › Outputs.</p>
          ) : (
            <fieldset>
              <legend>Format</legend>
              {formats.map((f) => (
                <label key={f} className="check"><input type="radio" name={`${uid}-f`} checked={chosen === f} onChange={() => setFormat(f)} /> {formatLabel(f)}</label>
              ))}
            </fieldset>
          )}
          <label>Title <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>
            Suggested report type
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">The usual type for this kind of draft</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <p className="hint">The file is made from this exact version. Who may read it follows the material the draft was built from.</p>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy || formats.length === 0}>Submit</button>
            <button type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
