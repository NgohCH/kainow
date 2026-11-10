/** Words for the bell: the count is in the accessible name, since the visible badge is hidden from screen readers. */
export function bellLabel(count: number): string {
  if (count <= 0) return 'Notifications';
  return `Notifications, ${count > 99 ? '99+' : count} unread`;
}

export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

export interface NotificationItem {
  id: string;
  projectId: string | null;
  projectName: string | null;
  kind: string;
  urgent: boolean;
  summary: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
  noAccess: boolean;
}

export interface NotificationPage {
  items: NotificationItem[];
  more: boolean;
  next: string | null;
}

export const EMAIL_CHOICES = [
  { value: 'daily_urgent_immediate', label: 'Daily, urgent immediately' },
  { value: 'immediate', label: 'Every notice immediately' },
  { value: 'daily', label: 'Daily only' },
  { value: 'off', label: 'Off' },
] as const;

export type EmailChoice = (typeof EMAIL_CHOICES)[number]['value'];

export interface EmailPreferences {
  projects: Array<{ projectId: string; name: string; choice: EmailChoice }>;
  away: Array<{ id: string; startsOn: string; endsOn: string; note: string | null }>;
}

export const NO_ACCESS_TEXT = 'You no longer have access to this project';
