import { type ReactNode, useState } from 'react';
import { type BoardBox, type BoardColumn, type BoardTask, inProjects, shownBoxes } from './board.ts';
import { columnChoices, moreText, startColumn } from './boardView.ts';
import { meaningVar, StatusLabel } from './StatusLabel.tsx';

type Props<T extends BoardTask> = {
  /** What the board is, for screen readers ("Tasks by status"). */
  label: string;
  columns: BoardColumn<T>[];
  renderBox: (box: BoardBox<T>) => ReactNode;
  /** Project names as headings inside each column. */
  groupByProject?: boolean;
  /** An id for a box's list item (so a link can land on it). */
  boxId?: (box: BoardBox<T>) => string;
};

function Boxes<T extends BoardTask>({ boxes, renderBox, groupByProject, boxId }: Pick<Props<T>, 'renderBox' | 'groupByProject' | 'boxId'> & { boxes: readonly BoardBox<T>[] }) {
  const item = (b: BoardBox<T>) => <li key={b.task.id} id={boxId?.(b)}>{renderBox(b)}</li>;
  if (!groupByProject) return <ul className="board-boxes">{boxes.map(item)}</ul>;
  return (
    <>
      {inProjects(boxes).map((g) => (
        <div key={g.projectId} className="board-project">
          <h4 className="board-project-name">{g.projectName}</h4>
          <ul className="board-boxes">{g.boxes.map(item)}</ul>
        </div>
      ))}
    </>
  );
}

function Column<T extends BoardTask>({ column, current, ...rest }: Pick<Props<T>, 'renderBox' | 'groupByProject' | 'boxId'> & { column: BoardColumn<T>; current: boolean }) {
  const [open, setOpen] = useState(!column.folded);
  const [all, setAll] = useState(false);
  const count = column.boxes.length;
  const more = moreText(count, all);
  const bodyId = `board-col-${column.key}`;
  const headingId = `${bodyId}-heading`;
  const label = column.meaning ? <StatusLabel meaning={column.meaning} word={column.heading} /> : <span className="board-name">{column.heading}</span>;
  return (
    <section className={`board-col edge-top${column.meaning ? ` m-${meaningVar(column.meaning)}` : ' board-plain'}${current ? ' is-current' : ''}`} aria-labelledby={headingId}>
      <h3 className="board-heading" id={headingId}>
        {column.folded ? (
          <button type="button" className="board-fold" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
          </button>
        ) : (
          label
        )}
        <span className="board-count">{count}</span>
      </h3>
      {open && (
        <div id={bodyId} className="board-body">
          {count === 0 ? (
            <p className="board-none">None</p>
          ) : (
            <Boxes boxes={shownBoxes(column.boxes, all)} {...rest} />
          )}
          {more && <button type="button" className="link-button board-more" onClick={() => setAll(!all)}>{more}</button>}
        </div>
      )}
    </section>
  );
}

/** Columns of boxes. Wide: side by side, wrapping. Narrow (below 700 px): one column, chosen with the "Column" select. */
export function Board<T extends BoardTask>({ label, columns, renderBox, groupByProject, boxId }: Props<T>) {
  const [picked, setPicked] = useState<string | null>(null);
  const first = startColumn(columns);
  const selected = columns.some((c) => c.key === picked) ? picked : first;
  if (columns.length === 0) return <p className="board-none">None</p>;
  return (
    <div className="board" role="group" aria-label={label}>
      <label className="board-picker">
        <span>Column</span>
        <select value={selected ?? ''} onChange={(e) => setPicked(e.target.value)}>
          {columnChoices(columns).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </label>
      <div className="board-cols">
        {columns.map((c) => (
          <Column key={c.key} column={c} current={c.key === selected} renderBox={renderBox} groupByProject={groupByProject} boxId={boxId} />
        ))}
      </div>
    </div>
  );
}
