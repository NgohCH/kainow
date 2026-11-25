import type { ReactNode } from 'react';
import { type DupState, type Offer, type Part, type Problem, askedAbout, confirmText, fieldOf, termParts } from '../duplicate.ts';
import { StatusLabel } from '../ui/StatusLabel.tsx';

/** Changes the review page's state from what it is at that moment. The same function for the page's whole life. */
export type Update = (change: (s: DupState) => DupState) => void;

/** What a part of the review page needs beside its own state. */
export interface PartProps {
  offer: Offer;
  state: DupState;
  terms: readonly string[];
  update: Update;
}

/** Goes to a field named in a list of what is still to be changed. */
export function goToField(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });
}

/** The refusal a part of the page concerns, shown in its box. */
export function PartError({ refusal, part }: { refusal: { message: string; part: Part | null } | null; part: Part }) {
  return refusal?.part === part ? <p className="error">{refusal.message}</p> : null;
}

/**
 * A field holding text carried from the original: marked while it holds an old term or must be looked at once more, with
 * the words around the term and "Still correct". `mustDecide` asks about the text whatever it holds (the purpose as it was).
 */
export function CarriedField({
  id, text, terms, confirmed, server, recheck, offer, update, mustDecide = false, mustChange = false, children,
}: {
  /** The text's key. */
  id: string;
  text: string;
  terms: readonly string[];
  confirmed: string | undefined;
  server: DupState['serverTerms'][string] | undefined;
  recheck: string | undefined;
  offer: Offer;
  update: Update;
  mustDecide?: boolean;
  /** The text cannot stay as it is (the name), so there is nothing to confirm. */
  mustChange?: boolean;
  /** The field itself; it is given the id of the note about it. */
  children: (noteId: string | undefined) => ReactNode;
}) {
  if (mustChange) {
    return (
      <div className="carried asked open">
        {children(`${fieldOf(id)}-note`)}
        <p id={`${fieldOf(id)}-note`} className="carried-note"><StatusLabel meaning="attention" word="Must be changed" /></p>
      </div>
    );
  }
  const asked = askedAbout(text, terms, server, recheck);
  const ask = asked.found.length > 0 || asked.changed || mustDecide;
  if (!ask) return <div className="carried">{children(undefined)}</div>;
  const ok = confirmed === asked.signature;
  const note = `${fieldOf(id)}-note`;
  return (
    <div className={`carried asked ${ok ? 'confirmed' : 'open'}`}>
      {children(note)}
      <div className="carried-note">
        <div id={note}>
          <StatusLabel
            meaning={ok ? 'ok' : 'attention'}
            word={ok ? 'Confirmed as still correct' : asked.found.length > 0 ? `Holds ${asked.found.length === 1 ? 'an old term' : 'old terms'}` : asked.changed ? 'The original has changed since you typed this' : 'As in the original'}
          />
          {asked.found.length > 0 && (
            <p className="carried-text">
              {termParts(text, asked.found).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
            </p>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={ok} aria-describedby={note} onChange={(e) => update((s) => confirmText(s, offer, id, e.target.checked))} />
          Still correct
        </label>
      </div>
    </div>
  );
}

/** The props of a CarriedField for one key of the state. */
export const carriedProps = (id: string, { offer, state, terms, update }: PartProps) => ({
  id, terms, offer, update, confirmed: state.confirmed[id], server: state.serverTerms[id], recheck: state.recheck[id],
});

const SHOWN = 8;

/** What is still to be changed, each a link to its field. A long list opens on request. */
export function ProblemList({ problems, projectId, all, onAll }: { problems: Problem[]; projectId: string; all: boolean; onAll: () => void }) {
  const shown = all ? problems : problems.slice(0, SHOWN);
  return (
    <>
      <ul className="dup-problems">
        {shown.map((p, i) => (
          <li key={`${p.field}-${i}`}>
            <a
              href={`#/projects/${projectId}/duplicate`}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                e.preventDefault();
                goToField(p.field);
              }}
            >
              {p.text}
            </a>
          </li>
        ))}
      </ul>
      {problems.length > SHOWN && (
        <button type="button" className="quiet" aria-expanded={all} onClick={onAll}>
          {all ? 'Show fewer' : `Show all ${problems.length}`}
        </button>
      )}
    </>
  );
}
