import { type CopiedFrom, copiedFromText } from '../duplicate.ts';

/** "Copied from <name>", linked, where the reader may open the original; otherwise "Copied from another project" (D140). */
export function CopiedFromLabel({ from }: { from: CopiedFrom | undefined }) {
  const copied = copiedFromText(from);
  if (!copied) return null;
  return copied.href ? <span>{copied.text} <a href={copied.href}>{copied.name}</a></span> : <span>{copied.text}</span>;
}
