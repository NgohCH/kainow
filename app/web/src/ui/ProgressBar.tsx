import type { Completion } from '../dashboard.ts';
import { progressText } from './home.ts';

/** A progress bar that always states its value in words. */
export function ProgressBar({ completion }: { completion: Completion }) {
  const pct = completion.state === 'measurable' ? completion.percent : 0;
  return (
    <span className="progress-cell">
      {completion.state === 'measurable' && <span className="meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>}
      <span className="stat-note">{progressText(completion)}</span>
    </span>
  );
}
