import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { badgeText, bellLabel } from '../notifications.ts';

/** The bell in the header: a link to the notifications page. The unread count is in its name; the badge is for sighted users. */
export function Bell({ hash }: { hash: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      api.get<{ count: number }>('/notifications/unread-count').then(
        (r) => {
          if (live) setCount(r.count);
        },
        () => undefined,
      );
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('notifications-changed', refresh);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('notifications-changed', refresh);
    };
    // A new page (hash) refreshes the count, e.g. after marking notices read.
  }, [hash]);

  const badge = badgeText(count);
  return (
    <a className="bell" href="#/notifications" aria-label={bellLabel(count)} aria-current={hash === '#/notifications' ? 'page' : undefined}>
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7.5 2 7.5H4S6 15 6 9z" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {badge && <span className="bell-badge" aria-hidden="true">{badge}</span>}
    </a>
  );
}
