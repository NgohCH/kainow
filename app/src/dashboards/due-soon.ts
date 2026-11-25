import { type Calendar, addWorkingDays } from '../notifications/calendar';

/** "Due soon" reaches this many days ahead, counted by the project's calendar (working days, or plain days if the project counts those). */
export const DUE_SOON_DAYS = 7;

/**
 * The last day of "due soon" in a project: today plus seven days by the project's calendar. A task is due soon when it is
 * not finished and due from `today` up to and including this day. The one rule behind Needs you, My tasks, the project
 * figures, leadership and analytics. (The seven-day reminder email is a separate rule.)
 */
export function dueSoonEnd(today: string, calendar: Calendar): string {
  try {
    return addWorkingDays(calendar, today, DUE_SOON_DAYS);
  } catch {
    // A calendar whose holidays leave no working day for a year ahead: count plain days, so one project cannot break the rest.
    return addWorkingDays({ ...calendar, dayCounting: 'calendar' }, today, DUE_SOON_DAYS);
  }
}
