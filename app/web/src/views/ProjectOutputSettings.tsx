import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen } from '../format.ts';
import { EXPORT_ROLES, EXPORT_ROLE_LABEL, type ExportRole, type OutputSettingsView, type ReportType, effectiveSourceLabel, formatLabel } from '../outputs.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** The project's output settings as this person sees them (who may submit and export); null until loaded or if refused. */
export function useOutputPolicy(projectId: string): { policy: OutputSettingsView | null; reload: () => void } {
  const [policy, setPolicy] = useState<OutputSettingsView | null>(null);
  const reload = useCallback(() => {
    api.get<OutputSettingsView>(`/projects/${projectId}/output-settings`).then(setPolicy, () => setPolicy(null));
  }, [projectId]);
  useEffect(reload, [reload]);
  return { policy, reload };
}

/** Active report types (the choice offered when submitting and registering). */
export function useReportTypes(): ReportType[] {
  const [types, setTypes] = useState<ReportType[]>([]);
  useEffect(() => {
    api.get<{ reportTypes: ReportType[] }>('/report-types').then((r) => setTypes(r.reportTypes), () => setTypes([]));
  }, []);
  return types;
}

const NOT_YOURS = 'The Project Manager, the Owner or a Sponsor can change this when the Administrator allows projects to; otherwise an Enterprise Administrator. Not while the project is Deferred or Closed.';
const who = (editable: boolean) => (editable ? 'You may change this.' : NOT_YOURS);

/**
 * Project settings › Outputs (spec 8.3): the output destination, formats and export roles, each with its effective
 * value, where it comes from and who may change it (Q01). Changes need a reason and are versioned on the server.
 */
export function ProjectOutputSettings({ projectId }: { projectId: string }) {
  const { policy: view, reload } = useOutputPolicy(projectId);
  const uid = useId();
  const [destinationId, setDestinationId] = useState('');
  const [inputMode, setInputMode] = useState<'all' | 'own'>('all');
  const [inputFormats, setInputFormats] = useState<string[]>([]);
  const [outputMode, setOutputMode] = useState<'all' | 'own'>('all');
  const [outputFormats, setOutputFormats] = useState<string[]>([]);
  const [roles, setRoles] = useState<ExportRole[]>([]);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = useCallback((v: OutputSettingsView) => {
    setDestinationId(v.destination?.id ?? '');
    setInputMode(v.projectFormats.input ? 'own' : 'all');
    setInputFormats(v.projectFormats.input ?? v.approvedFormats.input);
    setOutputMode(v.projectFormats.output ? 'own' : 'all');
    setOutputFormats(v.projectFormats.output ?? v.approvedFormats.output);
    setRoles(v.exportRoles);
    setReason('');
  }, []);
  useEffect(() => {
    if (view) reset(view);
  }, [view, reset]);

  if (!view) return null;
  const anyEditable = view.editable.destination || view.editable.formats || view.editable.exportRoles;
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!view) return;
    setError(null);
    setNotice(null);
    const body: Record<string, unknown> = { reason };
    if (view.editable.destination && destinationId !== (view.destination?.id ?? '')) body.destinationId = destinationId || null;
    if (view.editable.formats) {
      body.inputFormats = inputMode === 'all' ? null : inputFormats;
      body.outputFormats = outputMode === 'all' ? null : outputFormats;
    }
    if (view.editable.exportRoles) body.exportRoles = roles;
    try {
      await api.put(`/projects/${projectId}/output-settings`, body);
      setEditing(false);
      setNotice('The output settings were saved.');
      reload();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <section aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Outputs</h2>
      <dl className="settings-summary">
        <dt>Output destination</dt>
        <dd>
          {view.destination ? view.destination.label : 'None chosen: outputs cannot be filed yet'}
          {view.destination?.needsNewLocation && <span className="warn inline">No longer approved: choose another destination</span>}
          <span className="hint">{effectiveSourceLabel(view.sources.destination)}. Changing it applies to new filings only; filed files stay where they are. {who(view.editable.destination)}</span>
        </dd>
        <dt>Formats it accepts (notes and documents)</dt>
        <dd>
          {view.formats.input.map((f) => formatLabel(f.format)).join(', ') || 'None'}
          <span className="hint">{effectiveSourceLabel(view.sources.formats.input)}. {who(view.editable.formats)}</span>
        </dd>
        <dt>Formats it makes (outputs)</dt>
        <dd>
          {view.formats.output.map((f) => formatLabel(f.format)).join(', ') || 'None'}
          <span className="hint">{effectiveSourceLabel(view.sources.formats.output)}. {who(view.editable.formats)}</span>
        </dd>
        <dt>Who may export</dt>
        <dd>
          {view.exportRoles.map((r) => EXPORT_ROLE_LABEL[r] ?? r).join(', ')}
          <span className="hint">{effectiveSourceLabel(view.sources.exportRoles)}. Exports also need the Administrator to allow project exports. {who(view.editable.exportRoles)}</span>
        </dd>
      </dl>
      {view.updatedAt && <p className="meta">Last changed {formatWhen(view.updatedAt)}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {anyEditable && !editing && <button type="button" onClick={() => { reset(view); setEditing(true); setNotice(null); }}>Change output settings</button>}
      {editing && (
        <form className="panel stack" aria-label="Change output settings" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}>
          {view.editable.destination && (
            <label>
              Output destination
              <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                <option value="">None</option>
                {view.availableDestinations.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </label>
          )}
          {view.editable.formats && (
            <>
              <fieldset>
                <legend>Formats it accepts</legend>
                <label className="check"><input type="radio" name={`${uid}-in`} checked={inputMode === 'all'} onChange={() => setInputMode('all')} /> All the organisation approves</label>
                <label className="check"><input type="radio" name={`${uid}-in`} checked={inputMode === 'own'} onChange={() => setInputMode('own')} /> Only these:</label>
                {inputMode === 'own' && view.approvedFormats.input.map((f) => (
                  <label key={f} className="check"><input type="checkbox" checked={inputFormats.includes(f)} onChange={() => setInputFormats((l) => toggle(l, f))} /> {formatLabel(f)}</label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Formats it makes</legend>
                <label className="check"><input type="radio" name={`${uid}-out`} checked={outputMode === 'all'} onChange={() => setOutputMode('all')} /> All the organisation approves</label>
                <label className="check"><input type="radio" name={`${uid}-out`} checked={outputMode === 'own'} onChange={() => setOutputMode('own')} /> Only these:</label>
                {outputMode === 'own' && view.approvedFormats.output.map((f) => (
                  <label key={f} className="check"><input type="checkbox" checked={outputFormats.includes(f)} onChange={() => setOutputFormats((l) => toggle(l, f))} /> {formatLabel(f)}</label>
                ))}
              </fieldset>
              <p className="hint">Removing a format affects new imports and new outputs only.</p>
            </>
          )}
          {view.editable.exportRoles && (
            <fieldset>
              <legend>Who may export</legend>
              {EXPORT_ROLES.map((r) => (
                <label key={r} className="check"><input type="checkbox" checked={roles.includes(r)} onChange={() => setRoles((l) => toggle(l, r))} /> {EXPORT_ROLE_LABEL[r]}</label>
              ))}
            </fieldset>
          )}
          <label>Reason <input required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="actions">
            <button className="primary">Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
