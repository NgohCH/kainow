/**
 * Every protected action in the MVP. Default deny: an action or role that is not listed here
 * is refused. Add an action here, give it a grant below, and the permission tests cover it
 * automatically (each action is checked for an allowed and a denied case).
 */
export const ACTIONS = [
  'user.manage',
  'note.import',
  'note.view',
  'extraction.run',
  'proposal.review',
  'ai.settings.manage',
  'spend.view',
  'audit.view',
  'organisation.manage',
] as const;

export type Action = (typeof ACTIONS)[number];
export type Role = 'enterprise_administrator';

/** MVP: the Enterprise Administrator has full control of the application (decision R03). */
const GRANTS: Readonly<Record<Role, readonly Action[]>> = {
  enterprise_administrator: ACTIONS,
};

export function can(role: string | undefined | null, action: string): boolean {
  if (!role || !Object.prototype.hasOwnProperty.call(GRANTS, role)) {
    return false;
  }
  return (GRANTS[role as Role] as readonly string[]).includes(action);
}
