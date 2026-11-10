import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { type CalendarSettings, NOT_WORKING_DAY, isWorkingDayClient, modeLabel } from '../calendar.ts';

const Ctx = createContext<CalendarSettings | null>(null);

interface SettingsResponse { dayCounting: 'working' | 'calendar'; weekdays: number[] }
interface HolidaysResponse {
  holidays: Array<{ date: string; removedAt: string | null }>;
  organisationHolidays: Array<{ date: string }>;
}

/** Fetches the project's effective calendar once and shares it with the date fields and deadlines below. */
export function ProjectCalendarProvider({ projectId, children }: { projectId: string | undefined; children: ReactNode }) {
  const [settings, setSettings] = useState<CalendarSettings | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    Promise.all([
      api.get<SettingsResponse>(`/projects/${projectId}/notification-settings`),
      api.get<HolidaysResponse>(`/projects/${projectId}/holidays`),
    ]).then(
      ([s, h]) => {
        if (!live) return;
        const holidays = [...h.holidays.filter((x) => !x.removedAt).map((x) => x.date), ...h.organisationHolidays.map((x) => x.date)];
        setSettings({ dayCounting: s.dayCounting, weekdays: s.weekdays, holidays });
      },
      () => live && setSettings(null), // without the calendar the page simply shows no calendar hints
    );
    return () => {
      live = false;
    };
  }, [projectId]);
  return <Ctx.Provider value={settings}>{children}</Ctx.Provider>;
}

export const useProjectCalendar = (): CalendarSettings | null => useContext(Ctx);

/** The warning under a date field when the chosen date is not a working day. Nothing is changed; the date stays. */
export function NonWorkingDayNote({ date, id }: { date: string; id?: string }) {
  const cal = useProjectCalendar();
  const show = useMemo(() => cal !== null && date !== '' && !isWorkingDayClient(cal, date), [cal, date]);
  return (
    <p id={id} className={show ? 'warn' : 'visually-hidden'} role="status">
      {show ? NOT_WORKING_DAY : ''}
    </p>
  );
}

/** `Working Days, Mon–Fri` beside a deadline. */
export function ModeLabel() {
  const cal = useProjectCalendar();
  return cal ? <span className="meta"> ({modeLabel(cal)})</span> : null;
}
