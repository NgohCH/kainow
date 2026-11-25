import type { NeedsYouItem } from '../dashboard.ts';
import { groupAttention } from './attention.ts';
import { type AttentionBox, attentionByProject, attentionCounts, itemDate } from './byProject.ts';
import type { Meaning } from './meanings.ts';
import { type GroupColumn, ProjectGroups } from './ProjectGroups.tsx';
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

/** The Needs you queue: one box per project, its items by urgency. Inside one project (`inProject`), one box per urgency. */
export function AttentionQueue({ items, empty, inProject }: { items: NeedsYouItem[]; empty: string; inProject?: boolean }) {
  if (items.length === 0) return <p className="attention-empty">{empty}</p>;
  if (!inProject) {
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
