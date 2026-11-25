import type { TabStyle } from '../prefs.ts';

/** A small drawing of a tab style: three tabs, the middle one open with a count. For the eye only; its choice is named beside it. */
export function TabPreview({ style }: { style: TabStyle }) {
  return (
    <span className={`tab-preview tabs-${style}`} aria-hidden="true">
      <span className="tab-row">
        <span className="tab-slot"><span className="tab">One</span></span>
        <span className="tab-slot"><span className="tab open">Two <span className="tab-badge m-review">2</span></span></span>
        <span className="tab-slot"><span className="tab">Three</span></span>
      </span>
    </span>
  );
}
