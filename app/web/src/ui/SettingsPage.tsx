import { useEffect, useState, type ReactNode } from 'react';
import { useReturnFocus } from '../views/useReturnFocus.ts';
import { PageHeader, type PageHeaderProps } from './PageHeader.tsx';

export interface SettingsPageItem { key: string; title: string; current: ReactNode; form: (close: () => void) => ReactNode }

/** Template for a setting's own page: header, "At a glance", then "Settings" boxes whose Change button opens the form in place. */
export function SettingsPage({ header, glance, settings }: { header: PageHeaderProps; glance: ReactNode; settings: SettingsPageItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  useReturnFocus(open);
  useEffect(() => {
    if (open !== null) document.getElementById(`setting-form-${open}`)?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }, [open]);
  return (
    <>
      <PageHeader {...header} />
      <section aria-labelledby="at-a-glance" className="settings-area">
        <h2 id="at-a-glance">At a glance</h2>
        {glance}
      </section>
      <section aria-labelledby="settings-area" className="settings-area">
        <h2 id="settings-area">Settings</h2>
        {settings.map((s) => {
          const isOpen = open === s.key;
          const formId = `setting-form-${s.key}`;
          return (
            <section key={s.key} className="box settings-box" aria-labelledby={`setting-${s.key}`}>
              <div className="settings-box-head">
                <h3 id={`setting-${s.key}`} className="box-title">{s.title}</h3>
                <button type="button" data-opener={s.key} aria-expanded={isOpen} aria-controls={formId} onClick={() => setOpen(isOpen ? null : s.key)}>
                  {isOpen ? 'Close' : 'Change'}<span className="visually-hidden"> {s.title}</span>{isOpen ? '' : '…'}
                </button>
              </div>
              <div className="settings-current">{s.current}</div>
              {isOpen && (
                <div id={formId} className="settings-form" role="group" aria-labelledby={`setting-${s.key}`}>
                  {s.form(() => setOpen(null))}
                </div>
              )}
            </section>
          );
        })}
      </section>
    </>
  );
}
