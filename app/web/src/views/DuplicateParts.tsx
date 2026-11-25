import type { ReactNode } from 'react';
import { type HolidayDraft, type NotificationDraft, type OwnSetting, type StageDraft, type Offer, fieldOf, newUid } from '../duplicate.ts';
import { EXPORT_ROLES, EXPORT_ROLE_LABEL, formatLabel } from '../outputs.ts';
import { UNITS } from '../resources.ts';
import { WEEKDAY_NAMES } from '../settings.ts';
import { TEMPLATE_LIMITS } from '../ui/stages.ts';
import { CarriedField, type PartProps, carriedProps } from './DuplicateFields.tsx';

const swap = <T,>(list: T[], i: number, j: number): T[] => {
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

/** The new project's stages and substages, in order: renamed, moved, removed or added. It starts in the first. */
export function DuplicateStages(props: PartProps) {
  const { state, update } = props;
  const stages = (change: (list: StageDraft[]) => StageDraft[]) => update((s) => ({ ...s, stages: change(s.stages) }));
  const stage = (uid: string, change: (st: StageDraft) => StageDraft) => stages((list) => list.map((x) => (x.uid === uid ? change(x) : x)));
  return (
    <>
      <p className="meta">The new project starts in the first stage.</p>
      <ol id="dup-stages" tabIndex={-1} className="stage-editor">
        {state.stages.map((st, i) => {
          const key = `stage:${st.uid}`;
          const name = st.name || 'this stage';
          return (
            <li key={st.uid} className="stage-editor-item">
              <CarriedField {...carriedProps(key, props)} text={st.name} keyless={!st.id}>
                {(note) => (
                  <label>
                    Stage {i + 1}
                    <input id={fieldOf(key)} maxLength={TEMPLATE_LIMITS.nameChars} value={st.name} aria-describedby={note} onChange={(e) => stage(st.uid, (x) => ({ ...x, name: e.target.value }))} />
                  </label>
                )}
              </CarriedField>
              <div className="dup-tools">
                <button type="button" className="quiet" disabled={i === 0} aria-label={`Move ${name} up`} onClick={() => stages((l) => swap(l, i, i - 1))}>Move up</button>
                <button type="button" className="quiet" disabled={i === state.stages.length - 1} aria-label={`Move ${name} down`} onClick={() => stages((l) => swap(l, i, i + 1))}>Move down</button>
                <button type="button" className="quiet" aria-label={`Remove ${name}`} onClick={() => stages((l) => l.filter((x) => x.uid !== st.uid))}>Remove stage</button>
                <button type="button" className="quiet" aria-label={`Add a substage to ${name}`} disabled={st.substages.length >= TEMPLATE_LIMITS.substagesPerStage} onClick={() => stage(st.uid, (x) => ({ ...x, substages: [...x.substages, { uid: newUid(), name: '' }] }))}>Add a substage</button>
              </div>
              {st.substages.length > 0 && (
                <ol className="substage-editor">
                  {st.substages.map((sub, n) => {
                    const subKey = sub.key ?? sub.uid;
                    return (
                      <li key={sub.uid}>
                        <CarriedField {...carriedProps(subKey, props)} text={sub.name} keyless={!st.id}>
                          {(note) => (
                            <label>
                              Substage {n + 1} of {name}
                              <span className="dup-inline">
                                <input id={fieldOf(subKey)} maxLength={TEMPLATE_LIMITS.nameChars} value={sub.name} aria-describedby={note} onChange={(e) => stage(st.uid, (x) => ({ ...x, substages: x.substages.map((y) => (y.uid === sub.uid ? { ...y, name: e.target.value } : y)) }))} />
                                <button type="button" className="quiet" aria-label={`Remove substage ${sub.name || n + 1}`} onClick={() => stage(st.uid, (x) => ({ ...x, substages: x.substages.filter((y) => y.uid !== sub.uid) }))}>Remove</button>
                              </span>
                            </label>
                          )}
                        </CarriedField>
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
      <button type="button" disabled={state.stages.length >= TEMPLATE_LIMITS.stages} onClick={() => stages((l) => [...l, { uid: newUid(), name: '', substages: [] }])}>Add a stage</button>
    </>
  );
}

const FROM_ORGANISATION = 'From the organisation. The Administrator has not allowed projects to change this.';
/** Why something the original has is not carried into the new project, in the server's words. */
const reasonFor = (offer: Offer, setting: string): string | undefined => offer.settings.notCarried?.find((n) => n.setting === setting)?.reason;

/** The project's own holidays, where projects may have them. */
export function DuplicateHolidays(props: PartProps) {
  const { offer, state, update } = props;
  const may = offer.mayChange.calendar;
  if (!may) return <p className="meta">{reasonFor(offer, 'holidays') ?? FROM_ORGANISATION}</p>;
  const set = (change: (list: HolidayDraft[]) => HolidayDraft[]) => update((s) => ({ ...s, holidays: change(s.holidays) }));
  const edit = (uid: string, change: Partial<HolidayDraft>) => set((l) => l.map((h) => (h.uid === uid ? { ...h, ...change } : h)));
  return (
    <>
      <p className="meta">A holiday is not a working day. Dates are as in the original: change them for the new project.</p>
      {state.holidays.length === 0 && <p className="meta">No project holidays.</p>}
      <ul className="plain">
        {state.holidays.map((h) => {
          const key = `holiday:${h.uid}`;
          return (
            <li key={h.uid} className="dup-row">
              <CarriedField {...carriedProps(key, props)} text={h.name} keyless={!h.id}>
                {(note) => (
                  <div className="dup-holiday">
                    <label>
                      Date
                      <input id={`dup-holiday-date:${h.uid}`} type="date" value={h.date} onChange={(e) => edit(h.uid, { date: e.target.value })} />
                    </label>
                    <label>
                      Name
                      <input id={fieldOf(key)} maxLength={200} value={h.name} aria-describedby={note} onChange={(e) => edit(h.uid, { name: e.target.value })} />
                    </label>
                    <button type="button" className="quiet" aria-label={`Remove the holiday ${h.name || h.date}`} onClick={() => set((l) => l.filter((x) => x.uid !== h.uid))}>Remove</button>
                  </div>
                )}
              </CarriedField>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={() => set((l) => [...l, { uid: newUid(), date: '', name: '' }])}>Add a holiday</button>
    </>
  );
}

/** The organisation's value or the project's own; where projects may not choose, the organisation's and why. */
function OwnChoice({ label, may, reason, own, onOwn, children }: { label: string; may: boolean; reason: string | undefined; own: boolean; onOwn: (own: boolean) => void; children: ReactNode }) {
  if (!may) {
    return (
      <div>
        <p className="dup-setting-name">{label}</p>
        <p className="meta">{reason ?? FROM_ORGANISATION}</p>
      </div>
    );
  }
  return (
    <div className="stack">
      <label>
        {label}
        <select value={own ? 'own' : 'organisation'} onChange={(e) => onOwn(e.target.value === 'own')}>
          <option value="organisation">As the organisation</option>
          <option value="own">Set for this project</option>
        </select>
      </label>
      {own && children}
    </div>
  );
}

/** Approvals, reminders, the action-item email and outputs, as the original has them. */
export function DuplicateSettings({ offer, state, update, approved }: PartProps & { approved: { input: string[]; output: string[] } | null }) {
  const { mayChange, settings } = offer;
  const n = state.notifications;
  const notify = (change: Partial<NotificationDraft>) => update((s) => ({ ...s, notifications: { ...s.notifications, ...change } }));
  const outputs = (change: Partial<typeof state.outputs>) => update((s) => ({ ...s, outputs: { ...s.outputs, ...change } }));
  const digest = (change: Partial<NotificationDraft['digest']>) => notify({ digest: { ...n.digest, ...change } });
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  const formats = (label: string, id: string, setting: OwnSetting<string[]>, kept: string[] | null, offered: string[] | undefined, set: (v: OwnSetting<string[]>) => void) => (
    <OwnChoice label={label} may={mayChange.formats} reason={reasonFor(offer, 'formats')} own={setting.own} onOwn={(own) => set({ own, value: own && setting.value.length === 0 ? (kept ?? offered ?? []) : setting.value })}>
      <fieldset id={id} tabIndex={-1}>
        <legend>{label}: only these</legend>
        {[...new Set([...(offered ?? []), ...(kept ?? []), ...setting.value])].map((f) => (
          <label key={f} className="check">
            <input type="checkbox" checked={setting.value.includes(f)} onChange={(e) => set({ own: true, value: toggle(setting.value, f, e.target.checked) })} /> {formatLabel(f)}
          </label>
        ))}
      </fieldset>
    </OwnChoice>
  );

  return (
    <div className="stack">
      <fieldset className="settings-group stack">
        <legend>Approvals</legend>
        {settings.requiredApprovals === null ? (
          <p className="meta">{reasonFor(offer, 'requiredApprovals') ?? 'As many approvals as the organisation requires.'} The new project's Owner or a Sponsor can change it later.</p>
        ) : (
          <label>
            Required approvals
            <select value={state.requiredApprovals === null ? '' : 'kept'} onChange={(e) => update((s) => ({ ...s, requiredApprovals: e.target.value === '' ? null : settings.requiredApprovals }))}>
              <option value="kept">{settings.requiredApprovals}, as in the original</option>
              <option value="">As the organisation requires</option>
            </select>
            <span className="hint">The new project's Owner or a Sponsor can change it later.</span>
          </label>
        )}
      </fieldset>
      <fieldset className="settings-group stack">
        <legend>Calendar and reminders</legend>
        <OwnChoice label="Day counting" may={mayChange.calendar} reason={reasonFor(offer, 'calendar')} own={n.dayCounting.own} onOwn={(own) => notify({ dayCounting: { ...n.dayCounting, own } })}>
          <label>
            Count in
            <select value={n.dayCounting.value} onChange={(e) => notify({ dayCounting: { own: true, value: e.target.value as 'working' | 'calendar' } })}>
              <option value="working">Working Days</option>
              <option value="calendar">Calendar Days</option>
            </select>
          </label>
        </OwnChoice>
        <OwnChoice label="Working weekdays" may={mayChange.calendar} reason={reasonFor(offer, 'calendar')} own={n.weekdays.own} onOwn={(own) => notify({ weekdays: { ...n.weekdays, own } })}>
          <fieldset id="dup-weekdays" tabIndex={-1}>
            <legend>Working weekdays of this project</legend>
            <div className="weekdays">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <label key={d} className="check">
                  <input type="checkbox" checked={n.weekdays.value.includes(d)} onChange={(e) => notify({ weekdays: { own: true, value: toggle(n.weekdays.value, d, e.target.checked) } })} /> {WEEKDAY_NAMES[d]}
                </label>
              ))}
            </div>
          </fieldset>
        </OwnChoice>
        <OwnChoice label="Reminder days before the due date" may={mayChange.timings} reason={reasonFor(offer, 'timings')} own={n.leadDays.own} onOwn={(own) => notify({ leadDays: { ...n.leadDays, own } })}>
          <label>
            Days before
            <input id="dup-lead-days" value={n.leadDays.value} onChange={(e) => notify({ leadDays: { own: true, value: e.target.value } })} />
            <span className="hint">One to three whole numbers, 1–30, separated by commas. For example: 7, 1</span>
          </label>
        </OwnChoice>
        <OwnChoice label="Escalation delay after the due date" may={mayChange.timings} reason={reasonFor(offer, 'timings')} own={n.escalationDays.own} onOwn={(own) => notify({ escalationDays: { ...n.escalationDays, own } })}>
          <label>
            Days after
            <input id="dup-escalation" type="number" min={1} max={10} value={n.escalationDays.value} onChange={(e) => notify({ escalationDays: { own: true, value: e.target.value } })} />
          </label>
        </OwnChoice>
      </fieldset>
      <fieldset className="settings-group stack">
        <legend>Action-item email schedule</legend>
        {!mayChange.digest ? (
          <p className="meta">{reasonFor(offer, 'digest') ?? 'No schedule. The Administrator has not allowed projects to change this.'}</p>
        ) : (
          <label className="check">
            <input type="checkbox" checked={n.digest.enabled} onChange={(e) => digest({ enabled: e.target.checked })} /> Send the action-item email on a schedule
          </label>
        )}
        {mayChange.digest && n.digest.enabled && (
          <fieldset className="plain-fieldset grid-2">
            <legend className="visually-hidden">When the action-item email is sent</legend>
            <label>
              How often
              <select value={n.digest.frequency} onChange={(e) => digest({ frequency: e.target.value as 'daily' | 'weekly' })}>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
              </select>
            </label>
            {n.digest.frequency === 'weekly' && (
              <label>
                Weekday
                <select value={n.digest.weekday} onChange={(e) => digest({ weekday: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>)}
                </select>
              </label>
            )}
            <label>
              Time (UTC+8)
              <input id="dup-digest-time" type="time" value={n.digest.time} onChange={(e) => digest({ time: e.target.value })} />
            </label>
          </fieldset>
        )}
      </fieldset>
      <fieldset className="settings-group stack">
        <legend>Outputs</legend>
        <p className="meta">The output destination is not copied: choose it in the new project's settings.</p>
        {formats('Formats it accepts', 'dup-input-formats', state.outputs.inputFormats, settings.outputs.inputFormats, approved?.input, (inputFormats) => outputs({ inputFormats }))}
        {formats('Formats it makes', 'dup-output-formats', state.outputs.outputFormats, settings.outputs.outputFormats, approved?.output, (outputFormats) => outputs({ outputFormats }))}
        {mayChange.exportRoles ? (
          <fieldset id="dup-export-roles" tabIndex={-1}>
            <legend>Who may export</legend>
            {EXPORT_ROLES.map((r) => (
              <label key={r} className="check">
                <input type="checkbox" checked={state.outputs.exportRoles.includes(r)} onChange={(e) => outputs({ exportRoles: toggle(state.outputs.exportRoles, r as string, e.target.checked) })} /> {EXPORT_ROLE_LABEL[r]}
              </label>
            ))}
          </fieldset>
        ) : (
          <div>
            <p className="dup-setting-name">Who may export</p>
            <p className="meta">{reasonFor(offer, 'exportRoles') ?? FROM_ORGANISATION} {state.outputs.exportRoles.map((r) => (EXPORT_ROLE_LABEL as Record<string, string>)[r] ?? r).join(', ')}.</p>
          </div>
        )}
      </fieldset>
    </div>
  );
}

/** The original's risks: none ticked; a ticked one becomes a proposal with its wording only. */
export function DuplicateRisks(props: PartProps) {
  const { offer, state, update } = props;
  if (offer.risks.length === 0) return <p className="meta">The original has no risk that can be copied.</p>;
  const all = (on: boolean) => update((s) => ({ ...s, risks: Object.fromEntries(Object.entries(s.risks).map(([id, r]) => [id, { ...r, on }])) }));
  return (
    <>
      <p className="meta">Tick the risks to carry over. Each becomes a proposal with its wording only; severity and the person responsible are given when it is authorised.</p>
      <div className="dup-tools">
        <button type="button" onClick={() => all(true)}>Select all</button>
        <button type="button" onClick={() => all(false)}>Select none</button>
        <span role="status">{offer.risks.filter((r) => state.risks[r.id].on).length} of {offer.risks.length} risks chosen</span>
      </div>
      <ul className="plain">
        {offer.risks.map((r) => {
          const d = state.risks[r.id];
          const edit = (change: Partial<typeof d>) => update((s) => ({ ...s, risks: { ...s.risks, [r.id]: { ...s.risks[r.id], ...change } } }));
          return (
            <li key={r.id} className="dup-row">
              <label className="check dup-choose">
                <input type="checkbox" checked={d.on} onChange={(e) => edit({ on: e.target.checked })} />
                <span><span className="visually-hidden">Copy risk: </span>{d.on ? <span className="dup-kind">Risk</span> : d.text}</span>
              </label>
              {d.on && (
                <CarriedField {...carriedProps(r.key, props)} text={d.text}>
                  {(note) => (
                    <label>
                      Wording
                      <textarea id={fieldOf(r.key)} rows={2} maxLength={2000} value={d.text} aria-describedby={note} onChange={(e) => edit({ text: e.target.value })} />
                    </label>
                  )}
                </CarriedField>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const ONE_OFF: Record<string, string> = { equipment: 'Equipment', facility: 'Facility', other: 'Other' };

/** Planned resource lines: item and quantity, without dates, people or money. */
export function DuplicateResources(props: PartProps) {
  const { offer, state, update } = props;
  if (offer.resources.length === 0) return <p className="meta">The original has no planned resource that can be copied.</p>;
  const all = (on: boolean) => update((s) => ({ ...s, resources: Object.fromEntries(Object.entries(s.resources).map(([id, r]) => [id, { ...r, on }])) }));
  return (
    <>
      <p className="meta">Each ticked line is copied as Needed, with its quantity only. Dates, people, notes and money are not copied.</p>
      <div className="dup-tools">
        <button type="button" onClick={() => all(true)}>Select all</button>
        <button type="button" onClick={() => all(false)}>Select none</button>
        <span role="status">{offer.resources.filter((r) => state.resources[r.id].on).length} of {offer.resources.length} lines chosen</span>
      </div>
      <ul className="plain">
        {offer.resources.map((l) => {
          const d = state.resources[l.id];
          const edit = (change: Partial<typeof d>) => update((s) => ({ ...s, resources: { ...s.resources, [l.id]: { ...s.resources[l.id], ...change } } }));
          const name = l.item ? `${l.item.reference} ${l.item.name}` : d.description;
          const field = `dup-resource:${l.id}:quantity`;
          const key = `resource:${l.id}`;
          return (
            <li key={l.id} className="dup-row">
              <label className="check dup-choose">
                <input type="checkbox" checked={d.on} onChange={(e) => edit({ on: e.target.checked })} />
                <span><span className="visually-hidden">Copy resource: </span>{l.item || !d.on ? name : <span className="dup-kind">One-off resource: {ONE_OFF[l.oneOffKind ?? ''] ?? 'Other'}</span>}</span>
              </label>
              {d.on && !l.item && (
                <CarriedField {...carriedProps(key, props)} text={d.description}>
                  {(note) => (
                    <label>
                      Description
                      <input id={fieldOf(key)} maxLength={200} value={d.description} aria-describedby={note} onChange={(e) => edit({ description: e.target.value })} />
                    </label>
                  )}
                </CarriedField>
              )}
              {d.on && (
                <div className="grid-2">
                  <label>
                    Quantity (optional)
                    <input id={field} inputMode="decimal" value={d.quantity} onChange={(e) => edit({ quantity: e.target.value })} />
                  </label>
                  <label>
                    Unit
                    <select value={d.unit} onChange={(e) => edit({ unit: e.target.value })}>
                      <option value="">None</option>
                      {Object.entries(UNITS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
