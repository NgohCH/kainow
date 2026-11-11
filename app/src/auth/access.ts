import { SetMetadata } from '@nestjs/common';
import type { Action } from './permissions';

/**
 * Every route must declare how it is protected. A route that declares nothing is refused,
 * so forgetting a decorator fails closed instead of exposing the route.
 */
export type Access = { kind: 'public' } | { kind: 'session' } | { kind: 'action'; action: Action };

export const ACCESS_KEY = 'kainow:access';

/** Anyone, including people who are not signed in. Use sparingly. */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies Access);

/** Any signed-in person. */
export const AnySignedInUser = () => SetMetadata(ACCESS_KEY, { kind: 'session' } satisfies Access);

/** A signed-in person whose role is allowed to do this action. */
export const RequireAction = (action: Action) => SetMetadata(ACCESS_KEY, { kind: 'action', action } satisfies Access);

export const BEFORE_SETUP_KEY = 'kainow:before-setup';

/** The route also answers before the organisation is set up. Every other route answers 409 until then. */
export const BeforeSetup = () => SetMetadata(BEFORE_SETUP_KEY, true);
