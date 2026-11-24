import { meaningVar, StatusLabel } from './StatusLabel.tsx';
import type { Meaning } from './meanings.ts';

/** A figure with its label, and an optional note or meter. The meter always states its value in text. */
export function StatTile({ label, value, note, meter, meaning, word, href, pressed, onPress }: {
  label: string; value: string; note?: string; meter?: { value: number; max: number; text: string }; meaning?: Meaning; word?: string; href?: string;
  /** With onPress the tile is a toggle button (a filter); `pressed` says whether it is on. */
  pressed?: boolean; onPress?: () => void;
}) {
  const pct = meter && meter.max > 0 ? Math.max(0, Math.min(100, (meter.value / meter.max) * 100)) : 0;
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {meaning && <StatusLabel meaning={meaning} word={word} />}
      {note && <span className="stat-note">{note}</span>}
      {meter && (
        <>
          <span className="meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
          <span className="stat-note">{meter.text}</span>
        </>
      )}
    </>
  );
  const cls = `stat-tile${meaning ? ` edge-top m-${meaningVar(meaning)}` : ''}`;
  if (onPress) return <button type="button" className={`${cls} linked`} aria-pressed={pressed ?? false} onClick={onPress}>{body}</button>;
  return href ? <a className={`${cls} linked`} href={href}>{body}</a> : <div className={cls}>{body}</div>;
}
