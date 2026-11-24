import { barWidth } from '../dashboard.ts';

export type BarItem = { label: string; value: number | null; max: number; text: string };

/**
 * Horizontal CSS bars with the figures in words beside each, and a visually hidden table for screen readers. A missing
 * value is never drawn as an empty bar: it is listed under the bars with its text.
 */
export function Bars({ items, caption }: { items: BarItem[]; caption: string }) {
  const drawn = items.filter((i) => barWidth(i.value, i.max) !== null);
  const missing = items.filter((i) => barWidth(i.value, i.max) === null);
  return (
    <div className="bars">
      <ul className="plain bars-list" aria-hidden="true">
        {drawn.map((i, n) => (
          <li key={`${n}-${i.label}`}>
            <span className="bar-label">{i.label}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${barWidth(i.value, i.max)}%` }} />
            </span>
            <span className="bar-text">{i.text}</span>
          </li>
        ))}
      </ul>
      {/* The wrapper hides the table: a table cannot be narrower than its content, so hiding the table itself widened the page. */}
      <div className="visually-hidden">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">Figure</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i, n) => (
            <tr key={`${n}-${i.label}`}>
              <th scope="row">{i.label}</th>
              <td>{i.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {missing.length > 0 && (
        <ul className="plain bars-missing">
          {missing.map((i, n) => (
            <li key={`${n}-${i.label}`} className="meta">
              {i.label}: {i.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
