import { type ReactNode, useEffect, useId, useState } from 'react';
import { type BoardBox, type BoardColumn, type BoardTask, inProjects, shownBoxes } from './board.ts';
import { columnChoices, moreText } from './boardView.ts';
import { plural } from '../format.ts';
import { meaningVar, StatusLabel } from './StatusLabel.tsx';
import type { Meaning } from './meanings.ts';

/** A column of any kind of item: tasks, or Needs you items. */
export type ItemColumn<I> = { key: string; heading: string; meaning?: Meaning; folded?: boolean; items: readonly I[] };
export type ItemGroup<I> = { id: string; name: string; items: readonly I[] };

type Props<I> = {
  /** What the board is, for screen readers ("Tasks by status"). */
  label: string;
  columns: ItemColumn<I>[];
  itemKey: (item: I) => string;
  /** Draws one item; `level` is the heading level its title should use. */
  renderItem: (item: I, level: number) => ReactNode;
  /** One word for what the columns count ("task"), read out with each count. */
  noun: string;
  /** Splits a column's shown items under project headings. */
  groups?: (items: readonly I[]) => ItemGroup<I>[];
  /** The id of an item's list entry, so a link can land on it (it is focusable). */
  itemId?: (item: I) => string | undefined;
  /** The key of an item to make reachable: its column is selected, unfolded and shows all. */
  reveal?: string;
  /** The level of the column headings (default 3); project headings and titles go below it. */
  headingLevel?: number;
};

const Heading = ({ level, ...rest }: { level: number; className?: string; id?: string; children: ReactNode }) => {
  const H = `h${Math.min(Math.max(level, 1), 6)}` as 'h3';
  return <H {...rest} />;
};

type ColumnProps<I> = Omit<Props<I>, 'label' | 'columns' | 'reveal'> & { column: ItemColumn<I>; current: boolean; prefix: string; revealed: boolean };

function Column<I>({ column, current, prefix, revealed, itemKey, renderItem, noun, groups, itemId, headingLevel = 3 }: ColumnProps<I>) {
  const folded = column.folded ?? false;
  const [open, setOpen] = useState(!folded || revealed);
  const [all, setAll] = useState(revealed);
  useEffect(() => {
    if (revealed) {
      setOpen(true);
      setAll(true);
    }
  }, [revealed]);
  const count = column.items.length;
  const more = moreText(count, all);
  const bodyId = `${prefix}-body`;
  const headingId = `${prefix}-heading`;
  const label = column.meaning ? <StatusLabel meaning={column.meaning} word={column.heading} /> : <span className="board-name">{column.heading}</span>;
  const shown = shownBoxes(column.items, all);
  const entry = (i: I, level: number) => (
    <li key={itemKey(i)} id={itemId?.(i)} tabIndex={-1}>{renderItem(i, level)}</li>
  );
  return (
    <section className={`board-col edge-top${column.meaning ? ` m-${meaningVar(column.meaning)}` : ' board-plain'}${current ? ' is-current' : ''}`} aria-labelledby={headingId}>
      <Heading level={headingLevel} className="board-heading" id={headingId}>
        {folded ? (
          <button type="button" className="board-fold" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
          </button>
        ) : (
          label
        )}
        <span className="board-count" aria-hidden="true">{count}</span>
        <span className="visually-hidden">{plural(count, noun)}</span>
      </Heading>
      <div id={bodyId} className="board-body" hidden={!open}>
        {count === 0 ? (
          <p className="board-none">None</p>
        ) : groups ? (
          groups(shown).map((g) => (
            <div key={g.id} className="board-project">
              <Heading level={headingLevel + 1} className="board-project-name">{g.name}</Heading>
              <ul className="board-boxes">{g.items.map((i) => entry(i, headingLevel + 2))}</ul>
            </div>
          ))
        ) : (
          <ul className="board-boxes">{shown.map((i) => entry(i, headingLevel + 1))}</ul>
        )}
        {more && <button type="button" className="link-button board-more" onClick={() => setAll(!all)}>{more}</button>}
      </div>
    </section>
  );
}

/** Columns of items. Wide: side by side, wrapping. Narrow (below 700 px): one column, chosen with the "Column" select. */
export function Board<I>({ label, columns, reveal, ...rest }: Props<I>) {
  const id = useId();
  const holds = (c: ItemColumn<I>) => reveal !== undefined && c.items.some((i) => rest.itemKey(i) === reveal);
  const first = (columns.find((c) => c.items.length > 0) ?? columns[0])?.key ?? null;
  const [picked, setPicked] = useState<string | null>(() => columns.find(holds)?.key ?? null);
  useEffect(() => {
    const c = columns.find(holds);
    if (c) setPicked(c.key);
    // Only a new target selects its column; later choices in the select stand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
  const selected = columns.some((c) => c.key === picked) ? picked : first;
  if (columns.length === 0) return <p className="board-none">None</p>;
  return (
    <div className="board" role="group" aria-label={label}>
      <label className="board-picker">
        <span>Column</span>
        <select value={selected ?? ''} onChange={(e) => setPicked(e.target.value)}>
          {columnChoices(columns.map((c) => ({ key: c.key, heading: c.heading, boxes: c.items }))).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </label>
      <div className="board-cols">
        {columns.map((c, n) => (
          <Column key={c.key} column={c} current={c.key === selected} prefix={`${id}-${n}`} revealed={holds(c)} {...rest} />
        ))}
      </div>
    </div>
  );
}

type TaskBoardProps<T extends BoardTask> = {
  label: string;
  columns: BoardColumn<T>[];
  renderBox: (box: BoardBox<T>, level: number) => ReactNode;
  groupByProject?: boolean;
  boxId?: (box: BoardBox<T>) => string;
  reveal?: string;
  headingLevel?: number;
};

/** The task board: boxes in columns, optionally under project names. `reveal` is a task id. */
export function TaskBoard<T extends BoardTask>({ columns, renderBox, groupByProject, boxId, ...rest }: TaskBoardProps<T>) {
  return (
    <Board<BoardBox<T>>
      {...rest}
      columns={columns.map((c) => ({ key: c.key, heading: c.heading, meaning: c.meaning, folded: c.folded, items: c.boxes }))}
      itemKey={(b) => b.task.id}
      renderItem={renderBox}
      noun="task"
      groups={groupByProject ? (boxes) => inProjects(boxes).map((g) => ({ id: g.projectId, name: g.projectName, items: g.boxes })) : undefined}
      itemId={boxId}
    />
  );
}
