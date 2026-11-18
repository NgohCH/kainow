import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { formatWhen } from '../format.ts';
import {
  CASE_STATE_TEXT,
  DISCLOSURES_HEADING,
  GRANT_STATUS_TEXT,
  type Grant,
  type ItemKind,
  type ProtectedKeyStatus,
  protectedKeyLines,
  REVEAL_CONFIRMATION,
  type Revealed,
  type Reviewer,
  type SecurityCase,
  WAITING_FOR_KEY_LABEL,
  decideGrant,
  designateReviewer,
  extendGrant,
  kindNoun,
  listAdminCases,
  listGrants,
  listReviewers,
  listSecurityCases,
  reasonProblem,
  releaseUnchanged,
  requestGrant,
  revealLines,
  revealOriginal,
  revokeGrant,
  undesignateReviewer,
} from '../quarantine.ts';
import { ReasonDialog } from './DeleteRestore.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** A button that opens a reason box below it and gives focus back to the button when it closes. */
function ReasonButton({
  label,
  ariaLabel,
  title,
  confirm,
  primary = false,
  onConfirm,
  children,
}: {
  label: string;
  ariaLabel?: string;
  title: string;
  confirm: string;
  primary?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !open) button.current?.focus();
    was.current = open;
  }, [open]);
  return (
    <>
      <button type="button" ref={button} className={primary ? 'primary' : 'link-button'} aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <ReasonDialog
          title={title}
          confirm={confirm}
          onClose={() => setOpen(false)}
          onConfirm={async (reason) => {
            await onConfirm(reason);
            setOpen(false);
          }}
        >
          {children}
        </ReasonDialog>
      )}
    </>
  );
}

const caseName = (c: SecurityCase) => `A ${kindNoun(c.kind)} in ${c.project}`;

/** The Known disclosures block of a case: AI requests, emails sent and the audience size. */
function Disclosures({ c }: { c: SecurityCase }) {
  const d = c.disclosures;
  return (
    <div>
      <h4>{DISCLOSURES_HEADING}</h4>
      <ul className="plain">
        <li>
          {d.aiRequests.length === 0
            ? 'No AI requests sent it.'
            : `${d.aiRequests.length} AI ${d.aiRequests.length === 1 ? 'request' : 'requests'}: ${d.aiRequests.map((r) => `${formatWhen(r.at)}, ${r.provider} ${r.model}`).join('; ')}`}
        </li>
        <li>
          {d.emails.length === 0
            ? 'No emails sent containing it.'
            : `${d.emails.length} ${d.emails.length === 1 ? 'email' : 'emails'} sent: ${d.emails.map((e) => `${formatWhen(e.at)}, ${e.recipients} ${e.recipients === 1 ? 'recipient' : 'recipients'}`).join('; ')}`}
        </li>
        <li>{d.audienceSize} {d.audienceSize === 1 ? 'person' : 'people'} could read the item.</li>
      </ul>
    </div>
  );
}

function CaseLine({ c }: { c: SecurityCase }) {
  return (
    <>
      <strong>{caseName(c)}</strong>
      <span className="meta">
        {' '}
        Reported by {c.reporter ?? 'Kainow'}, {formatWhen(c.reportedAt)} · {CASE_STATE_TEXT[c.state] ?? c.state}
        {c.closedAt ? `, closed ${formatWhen(c.closedAt)}` : ''}
      </span>
      {c.waitingForKey && <span className="warn">{c.label ?? WAITING_FOR_KEY_LABEL}</span>}
      {c.changedSinceCleaning.length > 0 && (
        <ul className="plain">
          {c.changedSinceCleaning.map((x, i) => (
            <li key={i}>{x.table}: {x.label}</li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Reveal original
// ---------------------------------------------------------------------------------------------------------------

/**
 * Reveal original: the holder of a current grant confirms, then sees the item's original text with the secret marked.
 * No copy, download, export, email or AI action is offered. The original lives only in this component's state: it is not
 * written to any storage, and it is dropped when it is hidden, when the page is hidden and when the screen is left.
 */
function RevealOriginal({ c, item }: { c: SecurityCase; item: { kind: ItemKind; id: string; role: string } }) {
  const what = `${item.role === 'reported' ? 'the reported' : 'a confirmed copy,'} ${kindNoun(item.kind)}`;
  const uid = useId();
  const [asking, setAsking] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [shown, setShown] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const tick = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const was = useRef(false);

  const hide = useCallback(() => {
    setShown(null);
    setAsking(false);
    setTicked(false);
    setError(null);
  }, []);
  useEffect(() => {
    const away = () => document.visibilityState === 'hidden' && hide();
    document.addEventListener('visibilitychange', away);
    window.addEventListener('hashchange', hide);
    return () => {
      document.removeEventListener('visibilitychange', away);
      window.removeEventListener('hashchange', hide);
    };
  }, [hide]);
  useEffect(() => {
    if (asking) tick.current?.focus();
    else if (was.current && !shown) button.current?.focus();
    was.current = asking || shown !== null;
  }, [asking, shown]);
  useEffect(() => {
    if (shown) heading.current?.focus();
  }, [shown]);

  async function show(e: FormEvent) {
    e.preventDefault();
    if (!ticked || busy) return;
    setBusy(true);
    setError(null);
    try {
      setShown(await revealOriginal(c.caseId, item.kind, item.id));
      setAsking(false);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const lines = shown ? revealLines(shown.kind, shown.values) : [];
  return (
    <div>
      {!shown && (
        <button type="button" ref={button} aria-expanded={asking} aria-label={`Reveal original of ${what} in ${c.project}`} onClick={() => (asking ? hide() : setAsking(true))}>
          Reveal original{(c.items?.length ?? 0) > 1 ? ` (${what})` : ''}
        </button>
      )}
      {asking && !shown && (
        <form
          className="panel stack delete-dialog"
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${uid}-t`}
          onSubmit={show}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              hide();
            }
          }}
        >
          <h4 id={`${uid}-t`}>Reveal the original</h4>
          <p className="meta">This opens the real credential on screen. Every reveal is recorded with your name. No copy, download, email or AI action is offered.</p>
          <label className="check">
            <input ref={tick} type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} /> {REVEAL_CONFIRMATION}
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="decision">
            <button className="primary" disabled={!ticked || busy} aria-disabled={!ticked || busy}>Show the original</button>
            <button type="button" onClick={hide}>Cancel</button>
          </div>
        </form>
      )}
      {shown && (
        <section className="panel stack" aria-labelledby={`${uid}-r`}>
          <h4 id={`${uid}-r`} tabIndex={-1} ref={heading}>Original — {what} in {c.project}</h4>
          <p className="warn" role="note">{shown.notice}</p>
          {lines.length === 0 && <p className="meta">No original text is stored for this item.</p>}
          {lines.map((l, i) => (
            <div key={i}>
              <p className="meta">{l.heading}</p>
              <p className="cleaned-text">
                {l.segments.map((s, j) =>
                  s.removed ? (
                    <mark key={j} className="credential-removed" title="the removed credential">
                      <span className="visually-hidden">credential: </span>
                      {s.text}
                    </mark>
                  ) : (
                    <span key={j}>{s.text}</span>
                  ),
                )}
              </p>
            </div>
          ))}
          <div className="decision">
            <button type="button" onClick={hide}>Hide the original</button>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The security reviewer's view
// ---------------------------------------------------------------------------------------------------------------

function GrantLine({ g }: { g: Grant }) {
  return (
    <>
      <strong>{g.purpose}</strong>
      <span className="meta">
        {' '}
        {GRANT_STATUS_TEXT[g.status]} · {g.caseIds.length} {g.caseIds.length === 1 ? 'case' : 'cases'} · asked {formatWhen(g.requestedAt)} for {g.hours} {g.hours === 1 ? 'hour' : 'hours'}
        {g.expiresAt && g.status === 'current' ? ` · ends ${formatWhen(g.expiresAt)}` : ''}
        {g.decisionReason ? ` · ${g.decisionReason}` : ''}
        {g.revokeReason ? ` · revoked: ${g.revokeReason}` : ''}
      </span>
    </>
  );
}

/** Request form: pick cases (by reference, never content), a purpose and a duration (default 24 hours). */
function RequestForm({ cases, onSent }: { cases: SecurityCase[]; onSent: () => void }) {
  const uid = useId();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [purpose, setPurpose] = useState('');
  const [hours, setHours] = useState('24');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setSent(false);
    const h = Number(hours);
    if (picked.size === 0) return setError('Pick at least one case.');
    const p = reasonProblem(purpose);
    if (p) return setError(p.replace('reason', 'purpose'));
    if (!Number.isFinite(h) || h < 1) return setError('Ask for at least 1 hour.');
    setBusy(true);
    try {
      await requestGrant([...picked], purpose.trim(), Math.floor(h));
      setPicked(new Set());
      setPurpose('');
      setSent(true);
      onSent();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel stack" onSubmit={submit} noValidate aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`}>Ask to open originals</h3>
      <p className="meta">Another Administrator must approve. Until then nothing opens. Cases are listed by reference only.</p>
      <fieldset className="stack">
        <legend>Cases</legend>
        {cases.length === 0 && <p className="meta">There are no cases.</p>}
        {cases.map((c) => (
          <label key={c.caseId} className="check">
            <input
              type="checkbox"
              checked={picked.has(c.caseId)}
              onChange={() =>
                setPicked((s) => {
                  const n = new Set(s);
                  if (!n.delete(c.caseId)) n.add(c.caseId);
                  return n;
                })
              }
            />{' '}
            {caseName(c)}, reported {formatWhen(c.reportedAt)} ({CASE_STATE_TEXT[c.state] ?? c.state})
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${uid}-p`}>Purpose (1 to 1,000 characters)</label>
      <textarea id={`${uid}-p`} rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      <label htmlFor={`${uid}-d`}>Hours of access</label>
      <input id={`${uid}-d`} type="number" min={1} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
      {error && <p role="alert" className="error">{error}</p>}
      {sent && <p role="status" className="meta">Asked. The Administrators have been told; you will be told when it is decided.</p>}
      <div className="decision"><button className="primary" disabled={busy} aria-disabled={busy}>Send the request</button></div>
    </form>
  );
}

/** The security reviewer's page: my grants, the request form, and the case list with Reveal original and Release unchanged. */
export function SecurityReviewPage() {
  const [cases, setCases] = useState<SecurityCase[] | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([listSecurityCases(), listGrants()]).then(
      ([c, g]) => {
        setCases(c);
        setGrants(g);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  }, []);
  useEffect(load, [load]);
  return (
    <main className="page narrow">
      <h1>Security review</h1>
      <p className="meta">For designated security reviewers. Originals open only under a current grant naming the case, and every opening is recorded.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="meta">{notice}</p>}
      {grants && (
        <section aria-labelledby="my-grants-heading">
          <h2 id="my-grants-heading">My grants</h2>
          {grants.length === 0 && <p className="meta">You have not asked for any.</p>}
          <ul className="list">
            {grants.map((g) => (
              <li key={g.id}><GrantLine g={g} /></li>
            ))}
          </ul>
        </section>
      )}
      {cases && <RequestForm cases={cases} onSent={load} />}
      {cases && (
        <section aria-labelledby="security-cases-heading">
          <h2 id="security-cases-heading">Cases</h2>
          {cases.length === 0 && <p className="meta">There are no quarantine cases.</p>}
          <ul className="list">
            {cases.map((c) => {
              const open = c.state === 'held' || c.state === 'cleaned';
              return (
                <li key={c.caseId} className="stack">
                  <CaseLine c={c} />
                  <Disclosures c={c} />
                  {c.currentGrant ? (
                    <div className="decision">
                      {(c.items && c.items.length > 0 ? c.items : [{ kind: c.kind, id: c.itemId, role: 'reported' }]).map((it) => (
                        <RevealOriginal key={`${it.kind}:${it.id}`} c={c} item={it} />
                      ))}
                      {open && (
                        <ReasonButton
                          label="Release unchanged"
                          ariaLabel={`Release unchanged ${caseName(c)}`}
                          title="Release unchanged (false alarm)"
                          confirm="Release unchanged"
                          onConfirm={async (reason) => {
                            const r = await releaseUnchanged(c.caseId, reason);
                            setNotice(
                              `Released unchanged. ${r.restored} stored ${r.restored === 1 ? 'value' : 'values'} restored${r.changed.length > 0 ? `; ${r.changed.length} changed since cleaning and ${r.changed.length === 1 ? 'was' : 'were'} not restored` : ''}. The Administrators are told.`,
                            );
                            load();
                          }}
                        >
                          <p className="meta">Use this when the text was not a secret. Every original goes back where it was, except anything changed since it was cleaned, which is kept and listed.</p>
                        </ReasonButton>
                      )}
                    </div>
                  ) : (
                    <p className="meta">You do not hold a current grant for this case.</p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The Organisation page's sections (Administrators)
// ---------------------------------------------------------------------------------------------------------------

/** The persistent warning while the protected key is missing or cases are waiting for it. */
export function ProtectedKeyWarning({ status }: { status: ProtectedKeyStatus | undefined }) {
  if (!status || !status.warning) return null;
  return (
    <section className="panel" aria-labelledby="key-warning-heading">
      <h2 id="key-warning-heading">{status.warning}</h2>
      {protectedKeyLines(status).map((l) => (
        <p key={l} className="warn" role="status">{l}</p>
      ))}
      <p className="meta">Put the key file back at the configured path; waiting cases are cleaned in the order they were reported.</p>
    </section>
  );
}

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  status: string;
}

/** Security reviewers: designate and undesignate, each with a reason; nobody designates themselves. */
export function SecurityReviewersSection({ meId }: { meId: string }) {
  const uid = useId();
  const [reviewers, setReviewers] = useState<Reviewer[] | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !adding) addButton.current?.focus();
    was.current = adding;
  }, [adding]);
  const load = useCallback(() => {
    listReviewers().then(
      (r) => {
        setReviewers(r);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
    api.get<{ users: UserRow[] }>('/users').then((r) => setUsers(r.users), () => setUsers([]));
  }, []);
  useEffect(load, [load]);
  const taken = new Set((reviewers ?? []).map((r) => r.id));
  const options = users.filter((u) => u.status === 'active' && u.id !== meId && !taken.has(u.id));
  return (
    <section className="panel" aria-labelledby="reviewers-heading">
      <h2 id="reviewers-heading">Security reviewers</h2>
      <p className="meta">A security reviewer can ask to open quarantined originals; another Administrator must approve each request. Nobody can designate themselves.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {reviewers && reviewers.length === 0 && <p className="meta">No one is designated.</p>}
      {reviewers && reviewers.length > 0 && (
        <ul className="list">
          {reviewers.map((r) => (
            <li key={r.id} className="row">
              <span>
                {r.name} <span className="meta">{r.email}{r.designatedAt ? ` · designated ${formatWhen(r.designatedAt)}${r.designatedBy ? ` by ${r.designatedBy}` : ''}` : ''}</span>
              </span>
              {r.id !== meId && (
                <ReasonButton
                  label="Remove"
                  ariaLabel={`Remove ${r.name} as a security reviewer`}
                  title={`Remove ${r.name} as a security reviewer`}
                  confirm="Remove"
                  onConfirm={async (reason) => {
                    await undesignateReviewer(r.id, reason);
                    load();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <label htmlFor={`${uid}-who`}>Person</label>
        <select id={`${uid}-who`} value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Choose a person</option>
          {options.map((u) => (
            <option key={u.id} value={u.id}>{u.displayName} ({u.email})</option>
          ))}
        </select>
        <button type="button" ref={addButton} aria-expanded={adding} disabled={pick === ''} aria-disabled={pick === ''} onClick={() => setAdding((a) => !a)}>
          Designate
        </button>
      </div>
      {adding && pick !== '' && (
        <ReasonDialog
          title="Designate a security reviewer"
          confirm="Designate"
          onClose={() => setAdding(false)}
          onConfirm={async (reason) => {
            await designateReviewer(pick, reason);
            setAdding(false);
            setPick('');
            load();
          }}
        />
      )}
    </section>
  );
}

/** Quarantine cases (no content): project, item kind, reporter, state, waiting for the key, and the known disclosures. */
export function QuarantineCasesSection() {
  const [cases, setCases] = useState<SecurityCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listAdminCases().then(setCases, (e) => setError(errText(e)));
  }, []);
  return (
    <section className="panel" aria-labelledby="cases-heading">
      <h2 id="cases-heading">Quarantine cases</h2>
      <p className="meta">Cases are shown by reference only: no item text, and never the secret.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {cases && cases.length === 0 && <p className="meta">No cases have been reported.</p>}
      {cases && cases.length > 0 && (
        <ul className="list">
          {cases.map((c) => (
            <li key={c.caseId} className="stack">
              <CaseLine c={c} />
              <Disclosures c={c} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Extend: the Administrator chooses the hours (default 24); it is a fresh approval, from now. */
function ExtendButton({ g, onDone }: { g: Grant; onDone: () => void }) {
  const id = useId();
  const [hours, setHours] = useState('24');
  const n = Number(hours);
  return (
    <ReasonButton
      label="Extend"
      ariaLabel={`Extend the access of ${g.requester}`}
      title="Extend this access (a fresh approval)"
      confirm="Extend"
      onConfirm={async (r) => {
        if (!Number.isFinite(n) || n < 1) throw new ApiError('Give at least 1 hour.', 0);
        await extendGrant(g.id, Math.floor(n), r);
        onDone();
      }}
    >
      <label htmlFor={`${id}-h`}>Hours from now</label>
      <input id={`${id}-h`} type="number" min={1} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
      <p className="meta">Another Administrator must approve an extension.</p>
    </ReasonButton>
  );
}

/** Requests to open quarantined originals: approve or decline (not your own), extend or revoke. */
export function GrantRequestsSection({ meId }: { meId: string }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    listGrants().then(
      (g) => {
        setGrants(g);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  }, []);
  useEffect(load, [load]);
  return (
    <section className="panel" aria-labelledby="grants-heading">
      <h2 id="grants-heading">Quarantined-original grant requests</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {grants && grants.length === 0 && <p className="meta">No one has asked.</p>}
      {grants && grants.length > 0 && (
        <ul className="list">
          {grants.map((g) => (
            <li key={g.id} className="stack">
              <GrantLine g={g} />
              <span className="meta">Asked by {g.requester}</span>
              <div className="decision">
                {g.status === 'waiting' && g.requesterId !== meId && (
                  <>
                    <ReasonButton label="Approve" ariaLabel={`Approve the request by ${g.requester}`} title="Approve this request" confirm="Approve" onConfirm={async (r) => { await decideGrant(g.id, 'approved', r); load(); }} />
                    <ReasonButton label="Decline" ariaLabel={`Decline the request by ${g.requester}`} title="Decline this request" confirm="Decline" onConfirm={async (r) => { await decideGrant(g.id, 'declined', r); load(); }} />
                  </>
                )}
                {g.status === 'waiting' && g.requesterId === meId && <span className="meta">Another Administrator must decide your own request.</span>}
                {(g.status === 'current' || g.status === 'expired') && g.requesterId !== meId && (
                  <ExtendButton g={g} onDone={load} />
                )}
                {g.status === 'current' && (
                  <ReasonButton label="Revoke" ariaLabel={`Revoke the access of ${g.requester}`} title="Revoke this access" confirm="Revoke" onConfirm={async (r) => { await revokeGrant(g.id, r); load(); }} />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
