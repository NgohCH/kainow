import { meaningVar, StatusLabel } from './StatusLabel.tsx';
import { settingMeaning, type SettingSummary } from './settings.ts';

/** A hub box: name, purpose, a few current values and the state; the whole box is one link. */
export function SettingBox({ summary, title, purpose, href }: { summary: SettingSummary; title: string; purpose: string; href: string }) {
  const meaning = settingMeaning(summary.state);
  return (
    <a className={`setting-box edge-left m-${meaningVar(meaning)}`} href={href}>
      <span className="setting-box-head">
        <span className="setting-box-title">{title}</span>
        <StatusLabel meaning={meaning} word={summary.stateWord} />
      </span>
      <span className="setting-box-purpose">{purpose}</span>
      {summary.values.length > 0 && (
        <dl className="setting-box-values">
          {summary.values.slice(0, 3).map((v) => (
            <div key={v.label}><dt>{v.label}</dt><dd>{v.value}</dd></div>
          ))}
        </dl>
      )}
      {summary.note && <span className="setting-box-note">{summary.note}</span>}
    </a>
  );
}
