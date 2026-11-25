import { MEANINGS } from './meanings.ts';
import { STOPPED_LABEL, stageFlowText, type Stage } from './graphics.ts';

/** The project's stages as a row of steps; the text equivalent is what assistive technology reads. */
export function StageFlow({ stages }: { stages: Stage[] }) {
  return (
    <div className="stage-flow">
      <p className="visually-hidden">{stageFlowText(stages)}</p>
      <ol aria-hidden="true">
        {stages.map((s) => (
          <li key={s.name} className={`stage ${s.state}`}>
            <span className="stage-mark">{s.state === 'done' ? '✓' : s.state === 'current' ? '●' : s.stopped ? MEANINGS[s.stopped].symbol : '○'}</span>
            <span className="stage-name">{s.name}</span>
            {s.stopped && <span className="stage-stopped">{STOPPED_LABEL[s.stopped]}</span>}
            {s.days !== undefined && <span className="stage-days">{s.stopped ? 'after ' : ''}{s.days} {s.days === 1 ? 'day' : 'days'}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
