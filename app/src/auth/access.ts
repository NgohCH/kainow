import { SetMetadata } from '@nestjs/common';
import type { Action } from './permissions';

/**
 * Every route must declare how it is protected. A route that declares nothing is refused,
 * so forgetting a decorator fails closed instead of exposing the route.
 */
export type Access = { kind: 'public' } | { kind: 'session' } | { kind: 'action'; action: Action; /** Any one of these also lets the request through. */ alsoAllowed?: readonly Action[] };

export const ACCESS_KEY = 'kainow:access';

/** Anyone, including people who are not signed in. Use sparingly. */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies Access);

/** Any signed-in person. */
export const AnySignedInUser = () => SetMetadata(ACCESS_KEY, { kind: 'session' } satisfies Access);

/** A signed-in person whose role is allowed to do this action. */
export const RequireAction = (action: Action) => SetMetadata(ACCESS_KEY, { kind: 'action', action } satisfies Access);

/** Like RequireAction, but a person who can do any of the other actions is let in too (for a read route shared by two jobs). */
export const RequireAnyAction = (action: Action, ...alsoAllowed: Action[]) =>
  SetMetadata(ACCESS_KEY, { kind: 'action', action, alsoAllowed } satisfies Access);

export const BEFORE_SETUP_KEY = 'kainow:before-setup';

/** The route also answers before the organisation is set up. Every other route answers 409 until then. */
export const BeforeSetup = () => SetMetadata(BEFORE_SETUP_KEY, true);

export const ALLOWED_WHEN_PROTECTIVE_KEY = 'kainow:allowed-when-protective';

/**
 * The route still changes data while Kainow is in protective read-only mode (spec 7.3): sign-in, sign-out and Resume.
 * Every other non-GET route is refused with 503 while the mode is on. On a GET route the marker changes nothing (GETs
 * are never refused); it only records that the handler's side-effect write (an audit record of an export or an
 * opening) was audited and is kept while the mode is on.
 */
export const AllowedWhenProtective = () => SetMetadata(ALLOWED_WHEN_PROTECTIVE_KEY, true);
