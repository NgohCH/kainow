import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { type Branding, type LogoShape, type OrganisationProfile as Profile, SHAPE_HELP, logoUploadError, previewPlaces } from '../branding.ts';
import { OrganisationAnalysisSettings } from './AnalysisSettings.tsx';
import { GrantRequestsSection, ProtectedKeyWarning, QuarantineCasesSection, SecurityReviewersSection } from './SecurityReview.tsx';
import { deriveScheme } from '../ui/colour.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { SettingsPage } from '../ui/SettingsPage.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { CUSTODIAN_HELP, type RecoveryCustodian as Custodian, custodianError } from '../custodian.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** A panel with its heading, or, inside a settings box that already names the setting, just the content. */
function Wrap({ bare, id, title, children }: { bare: boolean; id: string; title: string; children: ReactNode }) {
  if (bare) return <div>{children}</div>;
  return (
    <section className="box" aria-labelledby={id}>
      <h2 id={id} className="box-title">{title}</h2>
      {children}
    </section>
  );
}

/** Loads the organisation's name and logos (Administrators only). */
export function useOrganisationProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<Profile>('/organisation').then(setProfile, (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);
  return { profile, error, reload: load };
}

/** The organisation's name: saved during onboarding, renamed afterwards. */
export function OrganisationName({ current, onSaved, bare = false }: { current: string | null; onSaved: () => void; bare?: boolean }) {
  const [name, setName] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(current ?? ''), [current]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api.post('/organisation/name', { name });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <Wrap bare={bare} id="org-name-heading" title="Organisation name">
      <form className="row" onSubmit={save}>
        <label>
          Name <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Example Organisation" />
        </label>
        <button className="primary">Save name</button>
      </form>
      {saved && <p role="status" className="meta">Name saved.</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </Wrap>
  );
}

/** The wide and square logos: each optional, each previewed, replaced or removed on its own. */
export function LogoUploads({ profile, onChanged, bare = false }: { profile: Profile; onChanged: () => void; bare?: boolean }) {
  const [error, setError] = useState<string | null>(null);

  async function upload(shape: LogoShape, file: File | undefined) {
    setError(null);
    if (!file) return;
    const early = logoUploadError(file);
    if (early) return setError(early);
    try {
      await api.upload(`/organisation/logos/${shape}`, file);
      onChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function remove(shape: LogoShape) {
    setError(null);
    try {
      await api.post(`/organisation/logos/${shape}/remove`);
      onChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <Wrap bare={bare} id="logos-heading" title="Logos">
      <p className="meta">Both are optional. Where one is missing, Kainow uses the other, or its own until you add one.</p>
      {(['wide', 'square'] as const).map((shape) => {
        const logo = profile.logos[shape];
        const label = shape === 'wide' ? 'Wide logo' : 'Square logo';
        return (
          <div key={shape} className="logo-upload">
            <p className="meta">{SHAPE_HELP[shape]}</p>
            {logo ? (
              <ul className="logo-previews" aria-label={`${label} as it will appear`}>
                {previewPlaces(shape).map((place) => (
                  <li key={place.label}>
                    <span className="preview-box" style={{ width: place.width, height: place.height }}>
                      <img
                        src={api.url(`/organisation/logos/${shape}/preview?v=${encodeURIComponent(logo.uploadedAt)}`)}
                        width={place.width}
                        height={place.height}
                        alt={`${label} in the ${place.label.toLowerCase()}`}
                      />
                    </span>
                    <span className="meta">{place.label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="meta">No {label.toLowerCase()} yet.</p>
            )}
            <label>
              {logo ? `Replace the ${label.toLowerCase()}` : `Add a ${label.toLowerCase()}`}{' '}
              <input type="file" accept="image/png,image/jpeg" onChange={(e) => void upload(shape, e.target.files?.[0])} />
            </label>
            {logo && (
              <button className="link-button" onClick={() => void remove(shape)}>
                Remove the {label.toLowerCase()}
              </button>
            )}
          </div>
        );
      })}
      {error && <p role="alert" className="error">{error}</p>}
    </Wrap>
  );
}

/** The recovery custodian (O07): shown, and recorded or changed, by an Administrator. */
export function RecoveryCustodian({ bare = false, onSaved }: { bare?: boolean; onSaved?: () => void } = {}) {
  const [current, setCurrent] = useState<Custodian | null>(null);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Custodian>('/organisation/recovery-custodian').then(
      (c) => {
        setCurrent(c);
        setName(c.name ?? '');
        setContact(c.contact ?? '');
      },
      (e) => setError(errText(e)),
    );
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const early = custodianError(name, contact);
    if (early) return setError(early);
    setError(null);
    setBusy(true);
    try {
      const next = await api.put<Custodian>('/organisation/recovery-custodian', { name, contact });
      setCurrent(next);
      setName(next.name ?? '');
      setContact(next.contact ?? '');
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Wrap bare={bare} id="custodian-heading" title="Recovery custodian">
      <p className="meta">{CUSTODIAN_HELP}</p>
      {current && (
        <p>
          {current.name && current.contact ? (
            <>Recorded: <strong>{current.name}</strong>, {current.contact}</>
          ) : (
            'No recovery custodian recorded yet.'
          )}
        </p>
      )}
      <form className="stack" onSubmit={save}>
        <label>
          Name <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          How to reach them <input required maxLength={200} value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>
        <button className="primary" disabled={busy || !current}>Save custodian</button>
      </form>
      {saved && <p role="status" className="meta">Recovery custodian saved.</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </Wrap>
  );
}


const HEX = /^#[0-9a-f]{6}$/i;

/** The organisation colour (C112, spec 8): a colour and its hex text, a live preview of the scheme made from it, a reason, Save and Clear. */
export function OrganisationColour({ current, onSaved }: { current: string | null; onSaved: () => void }) {
  const [text, setText] = useState(current ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typed = text.trim();
  const derived = typed === '' ? null : deriveScheme(typed);
  const problem = derived && !derived.ok ? derived.reason : null;

  async function send(colour: string | null) {
    setError(null);
    if (reason.trim() === '') return setError('Give a reason for the change.');
    setBusy(true);
    try {
      await api.put('/organisation/colour', { colour, reason: reason.trim() });
      setReason('');
      if (colour === null) setText('');
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const shown = error ?? problem;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(typed.toLowerCase()); }} aria-label="Organisation colour">
      <p className="meta">One colour. Kainow makes the menu, active item and highlights from it, and refuses a colour that cannot carry white text.</p>
      <div className="colour-row">
        <label>
          Pick a colour
          <input type="color" value={HEX.test(typed) ? typed : '#b0182e'} onChange={(e) => setText(e.target.value)} />
        </label>
        <label>
          Colour code
          <input value={text} maxLength={7} placeholder="#b0182e" onChange={(e) => setText(e.target.value)} aria-invalid={shown ? true : undefined} aria-describedby={shown ? 'colour-problem' : undefined} />
        </label>
      </div>
      {shown && <p id="colour-problem" role="alert" className="error">{shown}</p>}
      {derived && derived.ok && (
        <div className="colour-preview" role="img" aria-label="Preview of the scheme this colour makes">
          <span className="colour-swatch" style={{ background: derived.scheme.menu, color: derived.scheme.menuInk }}>Menu</span>
          <span className="colour-swatch" style={{ background: derived.scheme.accent, color: derived.scheme.accentContrast }}>Buttons</span>
          <span className="colour-swatch" style={{ background: derived.scheme.accentWash, color: derived.scheme.accentDeep }}>Highlights</span>
        </div>
      )}
      <label>
        Reason
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="actions">
        <button className="primary" disabled={busy || typed === '' || !!problem}>Save colour</button>
        <button type="button" disabled={busy || current === null} onClick={() => void send(null)}>Clear colour</button>
      </div>
    </form>
  );
}

const LOGO_WORD = { both: 'Wide and square', wide: 'Wide only', square: 'Square only', none: 'None yet' } as const;

/** Administrator screen after setup: the organisation's name, logos, colour and recovery custodian, with the security sections that belong to it. */
export function OrganisationScreen({ onBrandingChanged, meId }: { onBrandingChanged: () => void; meId: string }) {
  const { profile, error, reload } = useOrganisationProfile();
  const [colour, setColour] = useState<string | null>(null);
  const [custodian, setCustodian] = useState<Custodian | null>(null);
  const loadExtras = useCallback(() => {
    api.get<Branding>('/organisation/branding').then((b) => setColour(b.colour), () => setColour(null));
    api.get<Custodian>('/organisation/recovery-custodian').then(setCustodian, () => setCustodian(null));
  }, []);
  useEffect(loadExtras, [loadExtras]);
  const changed = () => {
    reload();
    loadExtras();
    onBrandingChanged();
  };

  if (!profile) {
    return (
      <main className="page">
        <PageHeader crumbs={[{ text: 'Settings', href: '#/settings' }]} title="Organisation" />
        {error ? <p role="alert" className="error">{error}</p> : <p className="loading">Loading</p>}
      </main>
    );
  }
  const logos = profile.logos.wide && profile.logos.square ? 'both' : profile.logos.wide ? 'wide' : profile.logos.square ? 'square' : 'none';
  const recorded = custodian?.name && custodian.contact ? { name: custodian.name, contact: custodian.contact } : null;
  const glance = (
    <>
      <ProtectedKeyWarning status={profile.protectedKey} />
      <div className="stat-grid">
        <StatTile label="Name" value={profile.name ?? 'Not set'} />
        <StatTile label="Logos" value={LOGO_WORD[logos]} />
        <StatTile label="Colour" value={colour ?? 'Not set'} note={colour ? undefined : 'Kainow uses its own red'} />
        <StatTile
          label="Recovery custodian"
          value={recorded ? recorded.name : 'Not recorded'}
          meaning={custodian ? (recorded ? 'ok' : 'attention') : undefined}
          word={recorded ? 'Recorded' : 'Needs attention'}
          note={recorded?.contact}
        />
      </div>
    </>
  );
  return (
    <main className="page">
      <SettingsPage
        header={{ crumbs: [{ text: 'Settings', href: '#/settings' }], title: 'Organisation', intro: 'The name and logos appear in the page header, on the sign-in page, in emails and on reports.' }}
        glance={glance}
        settings={[
          { key: 'name', title: 'Organisation name', current: <p>{profile.name ?? 'Not set'}</p>, form: (close) => <OrganisationName bare current={profile.name} onSaved={() => { changed(); close(); }} /> },
          { key: 'logos', title: 'Logos', current: <p>{LOGO_WORD[logos]}</p>, form: () => <LogoUploads bare profile={profile} onChanged={changed} /> },
          { key: 'colour', title: 'Organisation colour', current: <p>{colour ?? 'Not set'}</p>, form: (close) => <OrganisationColour current={colour} onSaved={() => { changed(); close(); }} /> },
          { key: 'custodian', title: 'Recovery custodian', current: <p>{recorded ? `${recorded.name}, ${recorded.contact}` : 'Not recorded yet.'}</p>, form: (close) => <RecoveryCustodian bare onSaved={() => { loadExtras(); close(); }} /> },
        ]}
      />
      <OrganisationAnalysisSettings />
      <SecurityReviewersSection meId={meId} />
      <QuarantineCasesSection />
      <GrantRequestsSection meId={meId} />
    </main>
  );
}
