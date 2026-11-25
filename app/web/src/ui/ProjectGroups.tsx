import { useId, useState, type ReactNode } from 'react';
import { type HeaderCount, type ProjectBox, distinctNames, shownRows, startsOpen } from './byProject.ts';
import { StatusLabel } from './StatusLabel.tsx';

/** Each kind keeps one width in every box, so the columns line up down the page. The `head` column names its row. */
export interface GroupColumn<R> { header: string; kind: 'state' | 'head' | 'status' | 'date'; cell: (row: R) => ReactNode }

/**
 * One box per project (11a.1 spec 15): its name, its counts by urgency and its rows in aligned columns. A button opens
 * and closes each box; the first three start open. A box shows its first five rows until "Show all".
 */
export function ProjectGroups<P extends ProjectBox, R>({ boxes, headingLevel, label, counts, rows, rowKey, columns }: {
  boxes: P[];
  headingLevel: 2 | 3;
  /** What the rows are, for the names of the buttons and tables: "Needs you", "Tasks". */
  label: string;
  counts: (box: P) => HeaderCount[];
  rows: (box: P) => readonly R[];
  rowKey: (row: R, index: number) => string;
  columns: GroupColumn<R>[];
}) {
  const uid = useId();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState<Record<string, boolean>>({});
  const names = distinctNames(boxes);
  const H = `h${headingLevel}` as 'h2' | 'h3';
  return (
    <div className="project-groups">
      {boxes.map((p, index) => {
        const list = rows(p);
        const isOpen = open[p.projectId] ?? startsOpen(index);
        const isAll = all[p.projectId] ?? false;
        const body = `${uid}-${p.projectId}`;
        return (
          <div key={p.projectId} className="project-group">
            <div className="project-group-head">
              <button type="button" className="project-group-toggle" aria-expanded={isOpen} aria-controls={isOpen ? body : undefined} aria-label={`${label} in ${names[index]}`} onClick={() => setOpen((o) => ({ ...o, [p.projectId]: !isOpen }))}>
                <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
              </button>
              <H className="project-group-name"><a href={`#/projects/${p.projectId}`}>{p.projectName}</a></H>
              <ul className="project-group-counts">
                {counts(p).map((c) => (
                  <li key={c.key}>{c.meaning ? <StatusLabel meaning={c.meaning} word={c.word} /> : <span className="project-group-plain">{c.word}</span>}</li>
                ))}
              </ul>
            </div>
            {isOpen && (
              <div id={body}>
                {/* The roles keep it a table for screen readers where narrow screens lay it out as blocks. */}
                <table className="group-table" role="table">
                  <caption className="visually-hidden">{label} in {names[index]}</caption>
                  <thead role="rowgroup">
                    <tr role="row">{columns.map((c) => <th key={c.kind} scope="col" role="columnheader" className={`group-${c.kind}`}>{c.header}</th>)}</tr>
                  </thead>
                  <tbody role="rowgroup">
                    {shownRows(list, isAll).map((r, n) => (
                      <tr key={rowKey(r, n)} role="row">
                        {columns.map((c) =>
                          c.kind === 'head'
                            ? <th key={c.kind} scope="row" role="rowheader" className="group-head">{c.cell(r)}</th>
                            : <td key={c.kind} role="cell" className={`group-${c.kind}`}>{c.cell(r)}</td>,
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {list.length > shownRows(list, false).length && (
                  <button type="button" className="quiet" aria-expanded={isAll} onClick={() => setAll((a) => ({ ...a, [p.projectId]: !isAll }))}>
                    {isAll ? 'Show fewer' : `Show all ${list.length}`}<span className="visually-hidden"> in {names[index]}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
