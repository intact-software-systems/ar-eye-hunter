import type { GroupStateRouteRequest } from './group-state-route-contracts.ts';

export interface GroupStateRouteRequestContext {
  readonly req: GroupStateRouteRequest & {
    json(): Promise<unknown>;
  };
}

export async function readGroupStateRouteRequest<T extends { requestId?: string }>(
  context: GroupStateRouteRequestContext,
): Promise<T & { requestId: string }> {
  const requestBody = (await context.req.json()) as T;
  const requestId = requestBody.requestId ??
    context.req.header('Idempotency-Key') ??
    crypto.randomUUID();

  return {
    ...requestBody,
    requestId,
  };
}
