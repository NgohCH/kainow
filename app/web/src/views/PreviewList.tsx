import { formatWhen } from '../format.ts';
import { type Preview, type PreviewItem, kindText, previewIsEmpty, previewTitle } from '../settings.ts';

function Group({ title, items, show }: { title: string; items: PreviewItem[]; show: (i: PreviewItem) => string }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h4>{title}</h4>
      <ul className="plain">
        {items.map((i, n) => (
          <li key={`${i.projectId}:${i.recordId}:${i.kind}:${n}`}>
            <strong>{previewTitle(i)}</strong> · {kindText(i.kind)} · {show(i)}
          </li>
        ))}
      </ul>
    </section>
  );
}

const at = (iso: string | null) => (iso ? formatWhen(iso) : 'not scheduled');

/** What a change would do to notices not yet sent, in the next 30 days. Deadlines themselves never move. */
export function PreviewList({ preview }: { preview: Preview }) {
  return (
    <div className="panel" role="region" aria-label="What this change would do">
      <h3>What this change would do</h3>
      <p className="meta">Notices in the next 30 days that have not been sent yet. Deadlines and review dates do not change.</p>
      {previewIsEmpty(preview) && <p>No upcoming notices change.</p>}
      <Group title="Notices that move" items={preview.moved} show={(i) => `from ${at(i.from)} to ${at(i.to)}`} />
      <Group title="New notices" items={preview.added} show={(i) => `on ${at(i.to)}`} />
      <Group title="Notices no longer sent" items={preview.removed} show={(i) => `was ${at(i.from)}`} />
    </div>
  );
}
