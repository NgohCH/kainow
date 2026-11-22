import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, isProtectiveRefusal } from '../api.ts';
import { formatWhen, plural } from '../format.ts';
import { reasonProblem } from '../leadership.ts';
import {
  type BackupRun,
  type Drill,
  type GrowthRow,
  KIND_WORDS,
  type OperationsView,
  type OpsSettingsValues,
  PROTECTIVE_TEXT,
  type Protective,
  type ResumeChecks,
  SETTING_ROWS,
  type SettingsData,
  type StorageLevel,
  type StorageLocation,
  type StorageRow,
  backupStatusWords,
  checkNameWords,
  checkResultWords,
  drillFailureLines,
  drillOutcomeWords,
  durationWords,
  formatBytes,
  growthTable,
  levelWords,
  locationWords,
  resumeCheckWords,
  runOutcomeWords,
} from '../operations.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** The mark shown beside a status word, so colour is never the only signal. */
const MARK = { good: '✓', warn: '!', bad: '✗', none: '–' } as const;
type Tone = keyof typeof MARK;
const levelTone = (l: StorageLevel): Tone => (l === 'normal' ? 'good' : l === 'warning' ? 'warn' : l === 'critical' ? 'bad' : 'none');
const backupTone = (s: OperationsView['backups']['status']): Tone => (s === 'healthy' ? 'good' : s === 'last_failed' ? 'warn' : 'bad');

function Word({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span className={`ops-word ops-${tone}`}>
      <span aria-hidden="true" className="ops-mark">{MARK[tone]}</span> {children}
    </span>
  );
}

const when = (iso: string | null) => (iso ? formatWhen(iso) : 'Never');

/** Backups, last drill, the disks and protective mode: a word and a time each. Shared with the analytics panel. */
export function StatusStrip({ status }: { status: Pick<OperationsView, 'storage' | 'protective'> & { backups: Pick<OperationsView['backups'], 'status' | 'lastSuccess' | 'lastAttempt'>; lastDrill: Drill | null } }) {
  const drill = status.lastDrill;
  const drillTone: Tone = !drill ? 'none' : drill.outcome === 'passed' ? 'good' : drill.outcome === 'failed' ? 'bad' : 'warn';
  const items: Array<{ label: string; tone: Tone; word: string; time: string }> = [
    {
      label: 'Backups',
      tone: backupTone(status.backups.status),
      word: backupStatusWords(status.backups.status),
      time: status.backups.lastSuccess ? `Last success ${when(status.backups.lastSuccess.finishedAt ?? status.backups.lastSuccess.startedAt)}` : 'No successful backup',
    },
    {
      label: 'Last restore drill',
      tone: drillTone,
      word: drill ? drillOutcomeWords(drill.outcome) : 'No drill yet',
      time: drill ? when(drill.finishedAt ?? drill.startedAt) : 'Never',
    },
    ...status.storage.locations.map((l) => ({
      label: locationWords(l.location),
      tone: levelTone(l.level),
      word: levelWords(l.level),
      time: l.at ? `Read ${when(l.at)}` : 'Never read',
    })),
    {
      label: 'Protective mode',
      tone: status.protective.on ? ('bad' as const) : ('good' as const),
      word: status.protective.on ? 'On (read-only)' : 'Off',
      time: status.protective.on && status.protective.since ? `Since ${when(status.protective.since)}` : 'Normal use',
    },
  ];
  return (
    <ul className="plain ops-strip" aria-label="Status summary">
      {items.map((i) => (
        <li key={i.label} className="ops-tile">
          <span className="ops-tile-label">{i.label}</span>
          <Word tone={i.tone}>{i.word}</Word>
          <span className="meta">{i.time}</span>
        </li>
      ))}
    </ul>
  );
}

/** Daily growth of one location: columns (the largest used per day against the largest total), with a visible table switch. */
export function GrowthChart({ rows, location, id }: { rows: GrowthRow[]; location: StorageLocation; id: string }) {
  const [table, setTable] = useState(false);
  const mine = rows.filter((r) => r.location === location);
  const label = locationWords(location);
  if (mine.length === 0) return <p className="meta">{label}: no daily figures yet.</p>;
  const t = growthTable(mine);
  const max = mine.reduce((m, r) => Math.max(m, r.totalBytes ?? 0, r.maxUsedBytes ?? 0), 0);
  const sorted = [...mine].sort((a, b) => (a.day < b.day ? -1 : 1));
  const w = 300;
  const h = 80;
  const col = w / sorted.length;
  return (
    <section aria-labelledby={id}>
      <div className="row">
        <h4 id={id}>{label}: used space by day</h4>
        <button type="button" className="quiet" aria-pressed={table} aria-label={`${table ? 'Show as chart' : 'Show as table'}: ${label} growth`} onClick={() => setTable((x) => !x)}>
          {table ? 'Show as chart' : 'Show as table'}
        </button>
      </div>
      {!table ? (
        <svg className="ops-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: used space on each of ${plural(sorted.length, 'day')}, from ${formatBytes(sorted[0].maxUsedBytes)} on ${sorted[0].day} to ${formatBytes(sorted[sorted.length - 1].maxUsedBytes)} on ${sorted[sorted.length - 1].day}. Choose Show as table for every figure.`} preserveAspectRatio="none">
          {sorted.map((r, i) => {
            const v = r.maxUsedBytes;
            const bar = v !== null && max > 0 ? Math.max(1, (v / max) * h) : 0;
            return v === null ? <line key={r.day} x1={i * col + col / 2} x2={i * col + col / 2} y1={h - 3} y2={h} className="ops-gap" /> : <rect key={r.day} x={i * col + 0.5} y={h - bar} width={Math.max(1, col - 1)} height={bar} className="ops-bar" />;
          })}
        </svg>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <caption>{label}: largest used and smallest free space, by day</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Used (largest)</th>
                <th scope="col">Free (smallest)</th>
              </tr>
            </thead>
            <tbody>
              {t.map((r) => (
                <tr key={r.day}>
                  <th scope="row">{r.day}</th>
                  <td data-label="Used (largest)">{r.used}</td>
                  <td data-label="Free (smallest)">{r.free}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RunsTable({ runs }: { runs: BackupRun[] }) {
  if (runs.length === 0) return <p className="empty">No backup has run yet.</p>;
  return (
    <div className="table-scroll">
      <table className="table">
        <caption>The last {plural(runs.length, 'backup run')}, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Kind</th>
            <th scope="col">Outcome</th>
            <th scope="col">Backup size (encrypted)</th>
            <th scope="col">Files</th>
            <th scope="col">Duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td data-label="Started">{formatWhen(r.startedAt)}</td>
              <td data-label="Kind">{KIND_WORDS[r.kind]}</td>
              <td data-label="Outcome">
                <Word tone={r.outcome === 'succeeded' ? 'good' : r.outcome === 'failed' ? 'bad' : 'warn'}>{runOutcomeWords(r)}</Word>
                {r.failureText && <span className="meta"> {r.failureText}</span>}
              </td>
              <td data-label="Backup size (encrypted)">{formatBytes(r.databaseEncryptedBytes)}</td>
              <td data-label="Files">
                {r.filesTotal === null ? 'Not recorded' : `${r.filesTotal}${r.filesNew !== null ? `, ${r.filesNew} new` : ''}${r.filesNotCopied ? `, ${r.filesNotCopied} not copied` : ''}`}
              </td>
              <td data-label="Duration">{durationWords(r.durationSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DrillBlock({ d, heading }: { d: Drill; heading: string }) {
  const tone: Tone = d.outcome === 'passed' ? 'good' : d.outcome === 'failed' ? 'bad' : 'warn';
  const lines = drillFailureLines(d);
  return (
    <div className="stack">
      <h3>{heading}</h3>
      <p>
        <Word tone={tone}>{drillOutcomeWords(d.outcome)}</Word>
        <span className="meta"> · started {formatWhen(d.startedAt)}{d.setName ? ` · backup set ${d.setName}` : ''}{d.sampled ? ' · sampled' : ''}</span>
      </p>
      <p>
        Duration {durationWords(d.durationSeconds)} against the 4-hour target.
      </p>
      {lines.length > 0 && (
        <ul className="plain" aria-label="Why the drill failed">
          {lines.map((l) => <li key={l} className="error">{l}</li>)}
        </ul>
      )}
      {d.checks.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <caption>Checks in this drill</caption>
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Result</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {d.checks.map((c) => (
                <tr key={c.name}>
                  <th scope="row">{checkNameWords(c.name)}</th>
                  <td data-label="Result"><Word tone={c.result === 'passed' ? 'good' : c.result === 'failed' ? 'bad' : 'none'}>{checkResultWords(c.result)}</Word></td>
                  <td data-label="Detail">{c.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StorageBlock({ s, growth }: { s: OperationsView['storage']; growth: GrowthRow[] }) {
  return (
    <>
      <div className="table-scroll">
        <table className="table">
          <caption>Disks and storage</caption>
          <thead>
            <tr>
              <th scope="col">Location</th>
              <th scope="col">Used</th>
              <th scope="col">Free</th>
              <th scope="col">Total</th>
              <th scope="col">Used</th>
              <th scope="col">Level</th>
              <th scope="col">Last reading</th>
            </tr>
          </thead>
          <tbody>
            {s.locations.map((l: StorageRow) => (
              <tr key={l.location}>
                <th scope="row">{locationWords(l.location)}</th>
                <td data-label="Used">{formatBytes(l.usedBytes)}</td>
                <td data-label="Free">{formatBytes(l.freeBytes)}</td>
                <td data-label="Total">{formatBytes(l.totalBytes)}</td>
                <td data-label="Percentage used">{l.usedPct === null ? 'Unavailable' : `${l.usedPct.toFixed(1)}%`}</td>
                <td data-label="Level"><Word tone={levelTone(l.level)}>{levelWords(l.level)}</Word></td>
                <td data-label="Last reading">{l.at ? formatWhen(l.at) : 'Never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Safe floor on the database disk: {s.safeFloorGb} GB free. Below it, protective read-only mode turns on.</p>
      {s.locations.map((l) => <GrowthChart key={l.location} rows={growth} location={l.location} id={`growth-${l.location}`} />)}
    </>
  );
}

/** Resume normal use: the reason, then each check as passed or failed, then Confirm. A refusal keeps the typed reason. */
function ResumeForm({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState<ResumeChecks | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failing, setFailing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setChecks(null);
    api.get<ResumeChecks>('/admin/operations/resume-checks').then(setChecks, (e) => setError(errText(e)));
  }, []);

  function show() {
    setOpen(true);
    setError(null);
    setFailing([]);
    load();
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFailing([]);
    const p = reasonProblem(reason);
    if (p) return setError(p);
    setBusy(true);
    try {
      await api.post('/admin/operations/resume', { reason: reason.trim() });
      setOpen(false);
      setReason('');
      window.dispatchEvent(new Event('operations-changed'));
      onDone();
    } catch (err) {
      setError(errText(err));
      const f = err instanceof ApiError ? (err.data as { failing?: unknown } | undefined)?.failing : undefined;
      if (Array.isArray(f)) setFailing(f.filter((x): x is string => typeof x === 'string'));
      if (err instanceof ApiError && err.status === 409) load();
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <button type="button" className="primary" onClick={show}>Resume normal use</button>;
  const allPassed = checks !== null && checks.checks.every((c) => c.passed);
  return (
    <form className="panel stack" onSubmit={confirm} aria-label="Resume normal use">
      <label>
        Reason for resuming
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <h3>Checks before Kainow can resume</h3>
      {!checks && !error && <p className="loading">Checking</p>}
      {checks && (
        <ul className="plain" aria-label="Resume checks">
          {checks.checks.map((c) => (
            <li key={c.name}>
              <Word tone={c.passed ? 'good' : 'bad'}>{c.passed ? 'Passed' : 'Failed'}</Word> {resumeCheckWords(c.name)}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {failing.length > 0 && (
        <ul className="plain" aria-label="Checks that failed">
          {failing.map((f) => <li key={f} className="error">Failed: {resumeCheckWords(f)}</li>)}
        </ul>
      )}
      <div className="inline-form">
        <button type="button" onClick={load}>Check again</button>
        <button className="primary" disabled={busy || !allPassed}>Confirm</button>
        <button type="button" className="quiet" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {checks && !allPassed && <p className="hint">Confirm is available when every check has passed.</p>}
    </form>
  );
}

function ProtectiveBlock({ p, onDone }: { p: Protective; onDone: () => void }) {
  if (!p.on) return <p>Protective mode is off. Kainow is in normal use.</p>;
  return (
    <>
      <p role="status"><strong>{PROTECTIVE_TEXT}</strong></p>
      <ul className="plain">
        <li>Why: {p.reason === 'restored_from_backup' ? 'Kainow was restored from a backup.' : 'Free space on the database disk fell below the safe floor.'}</li>
        <li>Since: {when(p.since)}</li>
      </ul>
      {p.reason === 'restored_from_backup' && (
        <p>
          Kainow was restored from the backup taken at {p.setTime ? formatWhen(p.setTime) : 'a time that was not recorded'}
          {p.setName ? ` (${p.setName})` : ''}. Everything after that time is lost, including access changes: check People, grants and Administrators before resuming. Queued emails and jobs were not sent.
        </p>
      )}
      <ResumeForm onDone={onDone} />
    </>
  );
}

function historyText(c: SettingsData['changes'][number]): string {
  const parts = SETTING_ROWS.filter((r) => c.previous[r.key] !== c.next[r.key]).map((r) => `${r.label}: ${c.previous[r.key]} to ${c.next[r.key]} ${r.unit}`);
  return parts.join('; ') || 'the settings';
}

/** The five settings, with bounds, values in force and history; saved with a reason. A refusal keeps the form as typed. */
function SettingsForm({ onSaved }: { onSaved: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<OpsSettingsValues | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<SettingsData>('/admin/operations/settings').then(
      (r) => {
        setData(r);
        setForm(r.settings);
      },
      (e) => setError(errText(e)),
    );
  }, []);
  useEffect(load, [load]);

  const problem = (() => {
    if (!data || !form) return null;
    for (const r of SETTING_ROWS) {
      const b = data.bounds[r.key];
      const v = form[r.key];
      if (!Number.isInteger(v) || v < b.min || v > b.max) return `${r.label} must be a whole number from ${b.min} to ${b.max}.`;
    }
    if (form.storageCriticalPct <= form.storageWarningPct) return `The critical level must be higher than the warning level (${form.storageWarningPct}).`;
    return null;
  })();
  const unchanged = !!data && !!form && SETTING_ROWS.every((r) => form[r.key] === data.settings[r.key]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    setNotice(null);
    const r = reasonProblem(reason);
    if (r) return setError(r);
    setBusy(true);
    try {
      await api.put('/admin/operations/settings', { ...form, reason: reason.trim() });
      setReason('');
      setNotice('Saved.');
      load();
      onSaved();
    } catch (err) {
      // The form keeps what was typed. A refusal in protective mode shows the server's own words.
      setError(isProtectiveRefusal(err) ? err.message : errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data || !form) return error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>;
  const set = (key: keyof OpsSettingsValues, value: number) => setForm((f) => (f ? { ...f, [key]: value } : f));
  return (
    <>
      <form className="panel stack" onSubmit={save} aria-label="Operations settings">
        {SETTING_ROWS.map((r) => {
          const b = data.bounds[r.key];
          const min = r.key === 'storageCriticalPct' ? data.rules.storageCriticalEffectiveMin : b.min;
          const id = `ops-${r.key}`;
          return (
            <div key={r.key} className="stack">
              <label htmlFor={id}>{r.label}</label>
              <div className="inline-form">
                <input id={id} type="number" inputMode="numeric" step={1} min={min} max={b.max} required value={Number.isNaN(form[r.key]) ? '' : form[r.key]} aria-describedby={`${id}-info`} onChange={(e) => set(r.key, e.target.value === '' ? NaN : Number(e.target.value))} />
                <span>{r.unit}</span>
              </div>
              <p id={`${id}-info`} className="hint">
                In force: {data.settings[r.key]} · Default: {data.defaults[r.key]} · Allowed: {b.min}–{b.max}
                {r.key === 'storageCriticalPct' ? ` (at least ${data.rules.storageCriticalEffectiveMin} with the warning level as it is now)` : ''}. {r.hint}
              </p>
            </div>
          );
        })}
        {problem && <p role="alert" className="error">{problem}</p>}
        <label>
          Reason for the change
          <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        {notice && <p role="status" className="ok">{notice}</p>}
        <button className="primary" disabled={busy || unchanged || problem !== null}>Save</button>
      </form>
      <section aria-labelledby="ops-history">
        <h3 id="ops-history">Change history</h3>
        {data.changes.length === 0 ? (
          <p className="meta">No changes yet.</p>
        ) : (
          <ul className="plain">
            {data.changes.map((c) => (
              <li key={c.id}>{formatWhen(c.at)}: {c.actor} changed {historyText(c)}. Reason: {c.reason}</li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Administration → Operations (spec 10): backups, restore drills, storage, protective mode and settings. */
export function Operations() {
  const [data, setData] = useState<OperationsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<OperationsView>('/admin/operations').then(
      (r) => {
        setData(r);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  }, []);
  useEffect(load, [load]);

  return (
    <main className="page">
      <h1>Operations</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {!data && !error && <p className="loading">Loading</p>}
      {data && (
        <>
          <StatusStrip status={{ backups: data.backups, lastDrill: data.drills.last, storage: data.storage, protective: data.protective }} />

          <section className="panel stack" aria-labelledby="ops-backups">
            <h2 id="ops-backups">Backups</h2>
            <p><Word tone={backupTone(data.backups.status)}>{backupStatusWords(data.backups.status)}</Word></p>
            <ul className="plain">
              <li>Last success: {data.backups.lastSuccess ? `${when(data.backups.lastSuccess.finishedAt ?? data.backups.lastSuccess.startedAt)}, ${KIND_WORDS[data.backups.lastSuccess.kind].toLowerCase()}, backup size (encrypted) ${formatBytes(data.backups.lastSuccess.databaseEncryptedBytes)}, ${data.backups.lastSuccess.filesTotal ?? 0} source files` : 'None yet'}</li>
              <li>Last attempt: {data.backups.lastAttempt ? `${when(data.backups.lastAttempt.startedAt)}, ${runOutcomeWords(data.backups.lastAttempt).toLowerCase()}` : 'None yet'}</li>
              {data.backups.lastAttempt?.failureText && <li className="error">Failure: {data.backups.lastAttempt.failureText}</li>}
              <li>Kept for: {plural(data.backups.retentionDays, 'day')}</li>
              <li>Backup folder: {data.backups.folderLabel ?? 'Not shown'}</li>
              <li>Key id: {data.backups.keyId ?? 'Not recorded'}</li>
            </ul>
            {data.backups.drillAgain && <p role="status">{data.backups.drillAgain}</p>}
            <RunsTable runs={data.backups.runs} />
          </section>

          <section className="panel stack" aria-labelledby="ops-drills">
            <h2 id="ops-drills">Restore drills</h2>
            {data.drills.last ? <DrillBlock d={data.drills.last} heading="Last drill" /> : <p className="empty">No restore drill has run yet.</p>}
            {data.drills.earlier.length > 0 && (
              <div className="table-scroll">
                <table className="table">
                  <caption>Earlier drills, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Started</th>
                      <th scope="col">Result</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Why it failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.drills.earlier.map((d) => (
                      <tr key={d.id}>
                        <td data-label="Started">{formatWhen(d.startedAt)}</td>
                        <td data-label="Result"><Word tone={d.outcome === 'passed' ? 'good' : d.outcome === 'failed' ? 'bad' : 'warn'}>{drillOutcomeWords(d.outcome)}</Word></td>
                        <td data-label="Duration">{durationWords(d.durationSeconds)}</td>
                        <td data-label="Why it failed">{drillFailureLines(d).join(' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.drills.kept.length > 0 && (
              <div>
                <h3>Drill databases kept</h3>
                <ul className="plain">{data.drills.kept.map((k) => <li key={k.name}>{k.name}</li>)}</ul>
              </div>
            )}
            {data.drills.stray.length > 0 && (
              <div>
                <h3>Other drill databases on the server</h3>
                <p className="hint">These are not recorded as kept. A drill that was stopped part-way can leave one.</p>
                <ul className="plain">{data.drills.stray.map((n) => <li key={n}>{n}</li>)}</ul>
              </div>
            )}
          </section>

          <section className="panel stack" aria-labelledby="ops-storage">
            <h2 id="ops-storage">Storage</h2>
            <StorageBlock s={data.storage} growth={data.growth} />
          </section>

          <section className="panel stack" aria-labelledby="ops-protective">
            <h2 id="ops-protective">Protective mode</h2>
            <ProtectiveBlock p={data.protective} onDone={load} />
          </section>

          <section className="panel stack" aria-labelledby="ops-health">
            <h2 id="ops-health">Health</h2>
            <ul className="plain">
              <li>Database: <Word tone="good">Up</Word></li>
              <li>Database structure: <Word tone={data.health.migrationsCurrent ? 'good' : 'bad'}>{data.health.migrationsCurrent ? 'Matches this version of Kainow' : 'Does not match this version of Kainow'}</Word></li>
              <li>Last sweep: {when(data.health.lastSweepAt)}</li>
            </ul>
            {data.health.queues.length > 0 && (
              <div className="table-scroll">
                <table className="table">
                  <caption>Job queues</caption>
                  <thead>
                    <tr>
                      <th scope="col">Queue</th>
                      <th scope="col">Waiting</th>
                      <th scope="col">Running</th>
                      <th scope="col">Failed in 24 hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.health.queues.map((q) => (
                      <tr key={q.name}>
                        <th scope="row">{q.name}</th>
                        <td data-label="Waiting">{q.queued}</td>
                        <td data-label="Running">{q.active}</td>
                        <td data-label="Failed in 24 hours">{q.failed24h}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel stack" aria-labelledby="ops-settings">
            <h2 id="ops-settings">Settings</h2>
            <SettingsForm onSaved={load} />
          </section>

          <section className="panel stack" aria-labelledby="ops-how">
            <h2 id="ops-how">How backups run</h2>
            <p>
              Backups and restore drills run on the server, not in this page: the server&apos;s own schedule starts them, and this page only shows what they did.
              To make a backup by hand, run a drill, or restore from a backup, follow INSTALL.md, section &quot;Backups&quot;.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
