import { MEANINGS, type Meaning } from './meanings.ts';

export const meaningVar = (m: Meaning): string => m.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/** A state or attention label: symbol, word and colour from the one table of meanings. `filled` makes it a solid badge. */
export function StatusLabel({ meaning, word, filled }: { meaning: Meaning; word?: string; filled?: boolean }) {
  const s = MEANINGS[meaning];
  return (
    <span className={`status-label m-${meaningVar(meaning)}${filled ? ' filled' : ''}`}>
      <span aria-hidden="true" className="status-symbol">{s.symbol}</span>
      <span>{word ?? s.word}</span>
    </span>
  );
}
