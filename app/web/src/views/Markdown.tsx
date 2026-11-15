import { Fragment } from 'react';
import { type Block, type Inline, parseMarkdown } from '../assist.ts';

/**
 * Markdown read into plain React nodes (text only, never HTML). `[Pn]` markers and `[^Pn]` footnote references become
 * buttons that move focus to the matching source, when `known` says that source exists. Links stay inside the app.
 */
export function Markdown({
  markdown,
  idPrefix,
  known,
  onMarker,
}: {
  markdown: string;
  idPrefix: string;
  /** Markers that have a source to jump to; others print as plain text. */
  known: (marker: string) => boolean;
  onMarker: (marker: string) => void;
}) {
  const blocks: Block[] = parseMarkdown(markdown);
  const inline = (parts: Inline[]) =>
    parts.map((p, i) => {
      if (p.t === 'bold') return <strong key={i}>{p.text}</strong>;
      if (p.t === 'code') return <code key={i}>{p.text}</code>;
      if (p.t === 'link') return <a key={i} href={p.href}>{p.text}</a>;
      if (p.t === 'marker' || p.t === 'fnref')
        return known(p.text) ? (
          <button key={i} type="button" className="quiet marker" aria-label={`Source ${p.text}`} onClick={() => onMarker(p.text)}>
            {p.t === 'fnref' ? `[${p.text}]` : p.text}
          </button>
        ) : (
          <Fragment key={i}>{p.t === 'fnref' ? `[${p.text}]` : p.text}</Fragment>
        );
      return <Fragment key={i}>{p.text}</Fragment>;
    });

  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === 'p') return <p key={i}>{inline(b.inlines)}</p>;
        if (b.t === 'h') return <p key={i}><strong>{inline(b.inlines)}</strong></p>;
        if (b.t === 'table')
          return (
            <div key={i} className="md-table" role="region" aria-label="Table" tabIndex={0}>
              <table className="table">
                <thead>
                  <tr>{b.head.map((c, j) => <th key={j} scope="col">{inline(c)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        if (b.t === 'defs')
          return (
            <ul key={i} className="footnotes">
              {b.items.map((d) => (
                <li key={d.marker} id={`${idPrefix}-fn-${d.marker}`} tabIndex={-1}>
                  <strong>{d.marker}</strong> {d.href ? <a href={d.href}>{d.label}</a> : d.label}
                </li>
              ))}
            </ul>
          );
        const Tag = b.t;
        return (
          <Tag key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </Tag>
        );
      })}
    </>
  );
}
