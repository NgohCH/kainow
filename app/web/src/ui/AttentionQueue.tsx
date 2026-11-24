import type { NeedsYouItem } from '../dashboard.ts';
import { groupAttention } from './attention.ts';
import { meaningVar, StatusLabel } from './StatusLabel.tsx';

/** The Needs you queue: boxes grouped by urgency, each with what, where and a link. */
export function AttentionQueue({ items, empty }: { items: NeedsYouItem[]; empty: string }) {
  const groups = groupAttention(items);
  if (groups.length === 0) return <p className="attention-empty">{empty}</p>;
  return (
    <div className="attention-queue">
      {groups.map((g) => (
        <section key={g.group} className={`attention-group edge-left m-${meaningVar(g.meaning)}`}>
          <h3 className="attention-heading">
            <StatusLabel meaning={g.meaning} word={g.heading} />
            <span className="attention-count">{g.items.length}</span>
          </h3>
          <ul>
            {g.items.map((i, n) => (
              <li key={`${i.kind}-${i.projectId}-${n}`}>
                <a href={i.link} className="attention-what">{i.label}{i.count && i.count > 1 ? ` (${i.count})` : ''}</a>
                <span className="attention-where">{i.projectName}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
