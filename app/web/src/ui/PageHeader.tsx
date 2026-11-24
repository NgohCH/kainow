import type { ReactNode } from 'react';

export interface PageHeaderProps { crumbs?: { text: string; href: string }[]; title: string; intro?: string; action?: ReactNode }

/** Breadcrumb, the page's one h1, a one-line explanation and the primary action. */
export function PageHeader({ crumbs, title, intro, action }: PageHeaderProps) {
  return (
    <header className="page-header">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="crumbs">
          <ol>{crumbs.map((c) => <li key={c.href}><a href={c.href}>{c.text}</a></li>)}</ol>
        </nav>
      )}
      <div className="page-header-row">
        <div>
          <h1>{title}</h1>
          {intro && <p className="page-intro">{intro}</p>}
        </div>
        {action && <div className="page-action">{action}</div>}
      </div>
    </header>
  );
}
