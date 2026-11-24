import type { MenuGroup } from './menu.ts';

/**
 * The side menu (spec 6.1): Kainow's name, then the groups of links. The current page's item carries aria-current. Below
 * 900 px it is hidden until the top bar's Menu button opens it (the `open` class).
 */
export function SideMenu({ id, groups, current, open }: { id: string; groups: MenuGroup[]; current: string; open: boolean }) {
  return (
    <nav id={id} className={open ? 'side-menu open' : 'side-menu'} aria-label="Main">
      <p className="side-menu-name">Kainow</p>
      {groups.map((g) => (
        <div key={g.heading} className="side-menu-group">
          <p className="side-menu-heading" id={`${id}-${g.heading.toLowerCase()}`}>{g.heading}</p>
          <ul aria-labelledby={`${id}-${g.heading.toLowerCase()}`}>
            {g.items.map((i) => (
              <li key={i.href}>
                <a href={i.href} aria-current={i.href === current ? 'page' : undefined}>
                  <span>{i.text}</span>
                  {i.badge !== undefined && (
                    <span className="menu-badge">
                      {i.badge}<span className="visually-hidden"> waiting</span>
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
