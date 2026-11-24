import type { ReactNode } from 'react';
import { meaningVar } from './StatusLabel.tsx';
import type { Meaning } from './meanings.ts';

/** A titled box. The state shows in its left or top edge; the state word belongs in a StatusLabel inside it. */
export function Box({ title, headingLevel = 2, meaning, edge = 'left', children }: {
  title?: string; headingLevel?: 2 | 3 | 4; meaning?: Meaning; edge?: 'left' | 'top'; children?: ReactNode;
}) {
  const H = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const cls = `box${meaning ? ` edge-${edge} m-${meaningVar(meaning)}` : ''}`;
  return (
    <section className={cls}>
      {title && <H className="box-title">{title}</H>}
      {children}
    </section>
  );
}
