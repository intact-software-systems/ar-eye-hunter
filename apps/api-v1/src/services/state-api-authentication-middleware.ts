import type { Context, Next } from 'jsr:@hono/hono@4.11.9';

import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import {
  isClientStateMutationRoute,
  isRemovedClientStateMutationRoute,
} from '../routes/is-client-state-mutation-route.ts';
import { toApiMutationFailureResponse } from '../routes/api-mutation-route-failure.ts';
import { toAuthErrorResponse } from './request-auth-service.ts';

export type RequireStateApiAuthSession = (
  request: Readonly<{ header(name: string): string | undefined }>,
) => Promise<IssuedAuthSession>;

export function createStateApiAuthenticationMiddleware(
  requireAuthSession: RequireStateApiAuthSession,
): (context: Context, next: Next) => Promise<Response> {
  return async (context, next) => {
    if (isRemovedClientStateMutationRoute(context.req.method, context.req.path)) {
      await next();
      return context.res;
    }
    try {
      await requireAuthSession(context.req);
      await next();
      return context.res;
    } catch (error) {
      if (isClientStateMutationRoute(context.req.method, context.req.path)) {
        return toApiMutationFailureResponse(
          context,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return toAuthErrorResponse(context, error);
    }
  };
}
