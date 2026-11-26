import { useMemo } from 'react';
import type { NeedsYouItem } from '../dashboard.ts';
import { groupAttention } from './attention.ts';
import { AttentionBoxView } from './BoardBoxes.tsx';
import { type AttentionBox, attentionByProject, attentionCounts, itemDate } from './byProject.ts';
import type { Meaning } from './meanings.ts';
import { needsYouBoardColumns, needsYouProjectGroups } from './myBoard.ts';
import { type GroupColumn, ProjectGroups } from './ProjectGroups.tsx';
import { Board } from './TaskBoard.tsx';
import { meaningVar, StatusLabel } from './StatusLabel.tsx';

type Row = { item: NeedsYouItem; meaning: Meaning };

function What({ i }: { i: NeedsYouItem }) {
  return <a href={i.link} className="attention-what">{i.label}{i.count && i.count > 1 ? ` (${i.count})` : ''}</a>;
}

const columns: GroupColumn<Row>[] = [
  { header: 'Urgency', kind: 'state', cell: (r) => <StatusLabel meaning={r.meaning} /> },
  { header: 'What', kind: 'head', cell: (r) => <What i={r.item} /> },
  { header: 'Date (UTC+8)', kind: 'date', cell: (r) => itemDate(r.item) },
];

const rows = (p: AttentionBox): Row[] => p.groups.flatMap((g) => g.items.map((item) => ({ item, meaning: g.meaning })));

/** Home's Needs you as a board: a column for each urgency that has items, the items under their project's name. */
function NeedsYouBoard({ items }: { items: NeedsYouItem[] }) {
  const columns = useMemo(() => needsYouBoardColumns(items), [items]);
  const keys = useMemo(() => new Map(items.map((i, n) => [i, String(n)] as const)), [items]);
  return (
    <Board<NeedsYouItem>
      label="Needs you"
      columns={columns}
      itemKey={(i) => keys.get(i) ?? i.link}
      renderItem={(i, level) => <AttentionBoxView item={i} level={level} />}
      noun="item"
      groups={(shown) => needsYouProjectGroups(shown)}
      headingLevel={3}
    />
  );
}

/**
 * The Needs you queue. On Home (11a.2 spec 6): a board (`view` "board", the default) or one box per project (`view` "project").
 * Inside one project (`inProject`), one box per urgency.
 */
export function AttentionQueue({ items, empty, inProject, view = 'board' }: { items: NeedsYouItem[]; empty: string; inProject?: boolean; view?: 'board' | 'project' }) {
  if (items.length === 0) return <p className="attention-empty">{empty}</p>;
  if (!inProject) {
    if (view === 'board') return <NeedsYouBoard items={items} />;
    return <ProjectGroups boxes={attentionByProject(items)} headingLevel={3} label="Needs you" counts={attentionCounts} rows={rows} rowKey={(r, n) => `${r.item.kind}-${r.item.link}-${n}`} columns={columns} />;
  }
  return (
    <div className="attention-queue">
      {groupAttention(items).map((g) => (
        <section key={g.group} className={`attention-group edge-left m-${meaningVar(g.meaning)}`}>
          <h3 className="attention-heading">
            <StatusLabel meaning={g.meaning} word={g.heading} />
            <span className="attention-count">{g.items.length}</span>
          </h3>
          <ul>
            {g.items.map((i, n) => (
              <li key={`${i.kind}-${i.projectId}-${n}`}><What i={i} /></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
