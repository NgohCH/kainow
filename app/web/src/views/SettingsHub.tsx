import { useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { SettingBox } from '../ui/SettingBox.tsx';
import { SETTINGS_CATALOGUE, filterSettings, summaryCounts, type SettingGroup, type SettingSummary } from '../ui/settings.ts';

const GROUPS: SettingGroup[] = ['Organisation and people', 'Work rules', 'Connections', 'Running Kainow'];
const groupId = (g: string) => `settings-${g.replace(/\W+/g, '-').toLowerCase()}`;

/** #/settings (spec 7.8): every organisation-wide setting as a box with its state and values, in four groups. */
export function SettingsHub({ reviewer }: { reviewer: boolean }) {
  const [summaries, setSummaries] = useState<SettingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchId = useId();

  useEffect(() => {
    let stale = false;
    api.get<{ settings: SettingSummary[] }>('/admin/settings/summary').then(
      (r) => !stale && setSummaries(r.settings),
      (e) => !stale && setError(e instanceof ApiError ? e.message : 'The state of the settings could not be loaded.'),
    );
    return () => {
      stale = true;
    };
  }, []);

  const visible = SETTINGS_CATALOGUE.filter((s) => reviewer || !s.reviewerOnly);
  const shown = filterSettings(visible, query);
  const byKey = new Map((summaries ?? []).map((s) => [s.key, s]));
  const counts = summaries ? summaryCounts(visible.flatMap((s) => (byKey.has(s.key) ? [byKey.get(s.key)!] : []))) : null;

  return (
    <main className="page">
      <PageHeader title="Settings" intro="Organisation-wide settings. Project settings live inside each project." />
      {error && <p role="alert" className="error">{error} The settings are listed below without their state.</p>}
      {counts && (
        <p className="settings-counts" role="status">
          {counts.ok} set up · {counts.attention} {counts.attention === 1 ? 'needs' : 'need'} attention · {counts.failing} failing · {counts.off} not in use
        </p>
      )}
      <div className="settings-search">
        <label htmlFor={searchId}>Search settings</label>
        <input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="For example reminders" />
      </div>
      {shown.length === 0 && <p className="empty">No setting matches “{query.trim()}”.</p>}
      {GROUPS.map((g) => {
        const entries = shown.filter((s) => s.group === g);
        if (entries.length === 0) return null;
        return (
          <section key={g} className="settings-area" aria-labelledby={groupId(g)}>
            <h2 id={groupId(g)}>{g}</h2>
            <div className="setting-grid">
              {entries.map((s) => {
                const summary = byKey.get(s.key);
                return summary ? (
                  <SettingBox key={s.key} summary={summary} title={s.title} purpose={s.purpose} href={s.href} />
                ) : (
                  <a key={s.key} className="setting-box" href={s.href}>
                    <span className="setting-box-head"><span className="setting-box-title">{s.title}</span></span>
                    <span className="setting-box-purpose">{s.purpose}</span>
                  </a>
                );
              })}
            </div>
          </section>
        );
      })}
    </main>
  );
}
