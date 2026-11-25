import { Fragment, type CSSProperties } from 'react';
import { dayLabel } from '../dashboard.ts';
import { Box } from './Box.tsx';
import { STOPPED_LABEL } from './graphics.ts';
import { MEANINGS } from './meanings.ts';
import { MARKER_KINDS, type BarsLayout } from './timelineBars.ts';

const at = (pct: number) => ({ '--at': pct / 100 }) as CSSProperties;

/**
 * Timeline bars (D132): one bar per stage period and a row of markers per kind of date, read-only. The drawing is hidden
 * from screen readers; they read the summary instead, and the month-by-month list below gives every date in words.
 * Below its natural width the drawing scrolls sideways inside its own box, never the page.
 */
export function TimelineBars({ layout }: { layout: BarsLayout }) {
  const rows = layout.markerRows.map((r) => ({ ...r, ...MARKER_KINDS.find((k) => k.kind === r.kind)! }));
  return (
    <Box title="Bars" headingLevel={3}>
      <p className="visually-hidden">{layout.summary}</p>
      <div className="tl-scroll" tabIndex={0} role="group" aria-label="Bars drawing, also given as text">
        <div className="tl-plot" aria-hidden="true">
          <div className="tl-overlay">
            {layout.months.map((m, i) => <span key={i} className="tl-grid" style={at(m.atPct)} />)}
            {layout.todayPct !== null && <span className="tl-today-line" style={at(layout.todayPct)} />}
          </div>
          <div className="tl-row tl-axis">
            <span className="tl-label" />
            <div className="tl-track">
              {layout.months.map((m, i) => <span key={i} className="tl-month" style={at(m.atPct)}>{m.label}</span>)}
              {layout.todayPct !== null && <span className="tl-today" style={at(layout.todayPct)}>Today</span>}
            </div>
          </div>
          {layout.bars.length === 0 && (
            <div className="tl-row">
              <span className="tl-label meta">No stages recorded in this window.</span>
              <div className="tl-track" />
            </div>
          )}
          {layout.bars.map((b, i) => (
            <div key={i} className="tl-row">
              <span className="tl-label">
                <span className="tl-stage">{b.stage}</span>
                {b.substage && <span className="meta">{b.substage}</span>}
                {b.current && <span className="tl-current">● Current</span>}
                {b.stopped && <span className="meta">{MEANINGS[b.stopped].symbol} {STOPPED_LABEL[b.stopped]}{b.stoppedLater && `, on ${dayLabel(b.stoppedLater)}`}</span>}
                {b.clippedStart && <span className="meta">continues from {dayLabel(b.clippedStart)}</span>}
              </span>
              <div className="tl-track">
                <span
                  className={`tl-bar${b.current ? ' current' : ''}${b.clippedStart ? ' clipped' : ''}`}
                  style={{ ...at(b.startPct), '--len': (b.endPct - b.startPct) / 100 } as CSSProperties}
                  title={b.text}
                />
              </div>
            </div>
          ))}
          {rows.map((r) => (
            <div key={r.kind} className="tl-row tl-markers">
              <span className="tl-label">
                <span>{r.symbol} {r.label}</span>
              </span>
              <div className="tl-track" style={{ '--lanes': r.lanes } as CSSProperties}>
                {r.items.map((m) => (
                  <Fragment key={m.startPct}>
                    {m.endPct > m.startPct && <span className="tl-run" style={{ ...at(m.startPct), '--len': (m.endPct - m.startPct) / 100, '--lane': m.lane } as CSSProperties} />}
                    <span className="tl-marker" style={{ ...at(m.atPct), '--lane': m.lane } as CSSProperties} title={m.text}>
                      <span className="tl-symbol">{r.symbol}</span>
                      {m.count > 1 && <span className="tl-count">{m.count}</span>}
                    </span>
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Box>
  );
}
