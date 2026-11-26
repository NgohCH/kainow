import type { MenuGroup } from './menu.ts';

/**
 * The side menu (spec 6.1, 11a.2 spec 7): Kainow's name, then the groups of links, among them the person's current
 * projects. The current page's item carries aria-current. Light by default, dark as a personal choice (data-menu on the
 * root). Below 900 px it is hidden until the top bar's Menu button opens it (the `open` class).
 */
export function SideMenu({ id, groups, current, open }: { id: string; groups: MenuGroup[]; current: string; open: boolean }) {
  return (
    <nav id={id} className={open ? 'side-menu open' : 'side-menu'} aria-label="Main">
      <p className="side-menu-name">Kainow</p>
      {groups.map((g) => {
        const headingId = `${id}-${g.heading.toLowerCase().replace(/\s+/g, '-')}`;
        return (
          <div key={g.heading} className="side-menu-group">
            <p className="side-menu-heading" id={headingId}>{g.heading}</p>
            <ul aria-labelledby={headingId}>
              {g.items.map((i, n) => (
                <li key={`${i.href ?? ''}:${i.text}:${n}`}>
                  {i.href ? (
                    <a href={i.href} aria-current={i.href === current && !i.unmarked ? 'page' : undefined}>
                      <span>{i.text}</span>
                      {i.badge !== undefined && (
                        <span className="menu-badge">
                          {i.badge}<span className="visually-hidden"> waiting</span>
                        </span>
                      )}
                    </a>
                  ) : (
                    <span className="side-menu-plain">
                      <span>{i.text}</span>
                      {i.note && <span className="side-menu-note">({i.note})</span>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
