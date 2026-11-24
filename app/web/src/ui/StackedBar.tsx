import { stackedBarLegend, stackedBarText, type BarPart } from './graphics.ts';
import { MEANINGS } from './meanings.ts';
import { meaningVar } from './StatusLabel.tsx';

/** Task status split into one bar with a legend that gives each count in words. */
export function StackedBar({ parts }: { parts: BarPart[] }) {
  const legend = stackedBarLegend(parts);
  const total = legend.reduce((n, p) => n + p.count, 0);
  return (
    <div className="stacked-bar">
      <div className="bar" aria-hidden="true">
        {legend.map((p) => <span key={p.label} className={`m-${meaningVar(p.meaning)}`} style={{ flexGrow: p.count }} />)}
      </div>
      <p className={total > 0 ? "visually-hidden" : "bar-legend"}>{stackedBarText(parts)}</p>
      {total > 0 && (
        <ul className="bar-legend" aria-hidden="true">
          {legend.map((p) => (
            <li key={p.label} className={`m-${meaningVar(p.meaning)}`}>
              <span className="legend-symbol">{MEANINGS[p.meaning].symbol}</span>
              <span>{p.count} {p.label} ({p.percent}%)</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
