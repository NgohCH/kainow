/** Injection tokens and small shared types for sign-in. */
export const CODE_SENDER = Symbol('CODE_SENDER');
export const CLOCK = Symbol('CLOCK');

export type Clock = () => Date;

/** Delivers a one-time sign-in code. The code is plain text here and must never be logged by callers. */
export interface CodeSender {
  send(email: string, code: string, validForMinutes: number): Promise<void>;
  /** A project invitation: the link opens the invitation page, which asks the person to sign in first. */
  sendInvitation(email: string, link: string, projectName: string, role: string, expiresAt: Date): Promise<void>;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

/** Set on the request by the guard once a valid session is found. */
export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

export const SESSION_COOKIE = 'kainow_session';
