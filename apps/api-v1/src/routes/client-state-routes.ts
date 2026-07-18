import { Hono } from 'jsr:@hono/hono@4.11.9';
import type {
  StateScope,
  UpsertClientInstanceRequest,
} from '@shared/api/state-types.ts';
import type { ClientEvent, ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import {
  type ClientStateService,
  getClientStateService,
} from '../services/client-state-service.ts';
import { requireApiAuthSession as defaultRequireApiAuthSession } from '../services/request-auth-service.ts';
import { getMiddleware } from '../middleware.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxType,
  type ClientInstanceUpsertAppInboxPayload,
  type ClientPrincipalUpsertAppInboxPayload,
  type ClientSessionConnectAppInboxPayload,
  type ClientSessionDisconnectAppInboxPayload,
  type ClientSessionHeartbeatAppInboxPayload,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/services/client-state-service.ts';
import {
  filterStateEventsForList,
  readStateEventListQuery,
  type StateEventListQuery,
} from '@shared-server/rallar-system/state-event-listing.ts';
import {
  hydrateStateSyncSnapshotCaches as defaultHydrateStateSyncSnapshotCaches,
  type StateSyncCacheHydrationInput,
  type StateSyncCacheHydrationResult,
} from '@shared-server/rallar-system/state-sync-cache-hydration.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
  ClientMutationRejectedError,
  validateClientMutationRequest,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';

export type ClientStateRouteService = Pick<
  ClientStateService,
  | 'listSnapshots'
  | 'readSnapshot'
  | 'readPresenceSnapshot'
  | 'listEvents'
  | 'listRecentEvents'
  | 'listEventPage'
>;

export type ClientStateRouteAuthSession = Pick<
  AuthSession,
  'clientId' | 'sessionId'
>;

export type ClientStateRouteDependencies = Readonly<{
  getClientStateService?: () => ClientStateRouteService;
  requireApiAuthSession?: (
    req: {
      header(name: string): string | undefined;
    },
  ) => Promise<ClientStateRouteAuthSession>;
  hydrateStateSyncSnapshotCaches?: (
    input: StateSyncCacheHydrationInput,
  ) => Promise<StateSyncCacheHydrationResult>;
  processClientAppInbox?: <V>(
    enqueue: AppInboxEnqueueInput<V>,
  ) => Promise<ClientSnapshot>;
}>;

export function init(
  app: Hono,
  dependencies: ClientStateRouteDependencies = {},
): void {
  const deps = toClientStateRouteDependencies(dependencies);

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients',
    async (c) => {
      try {
        const scope = toScope(c);
        const authSession = await readStrictReadAuthSession(c.req, deps);
        const snapshots = authSession
          ? [
            await deps.getClientStateService().readSnapshot({
              ...scope,
              principalId: authSession.clientId,
            }),
          ].filter(isDefined)
          : await deps.getClientStateService().listSnapshots(scope);
        hydrateClientSnapshots(deps, snapshots);
        return c.json(snapshots);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId',
    async (c) => {
      try {
        const principalId = c.req.param('principalId');
        await assertCanReadClientState(c.req, deps, principalId);
        const snapshot = await deps.getClientStateService().readSnapshot({
          ...toScope(c),
          principalId,
        });

        if (!snapshot) {
          return c.json({ error: `Client not found: ${principalId}` }, 404);
        }

        hydrateClientSnapshots(deps, [snapshot]);
        return c.json(snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/presence',
    async (c) => {
      try {
        const principalId = c.req.param('principalId');
        await assertCanReadClientState(c.req, deps, principalId);
        const snapshot = await deps.getClientStateService().readPresenceSnapshot({
          ...toScope(c),
          principalId,
        });

        return snapshot
          ? c.json(snapshot)
          : c.json({ error: `Client presence not found: ${principalId}` }, 404);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/events',
    async (c) => {
      try {
        const principalId = c.req.param('principalId');
        await assertCanReadClientState(c.req, deps, principalId);
        const ref = {
          ...toScope(c),
          principalId,
        };
        const query = readStateEventListQuery(
          new URL(c.req.raw.url).searchParams,
        );

        return c.json(
          await listRecentClientEventsForArrayRoute(
            deps.getClientStateService(),
            ref,
            query,
          ),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/events/page',
    async (c) => {
      try {
        const principalId = c.req.param('principalId');
        await assertCanReadClientState(c.req, deps, principalId);

        return c.json(
          await deps.getClientStateService().listEventPage(
            {
              ...toScope(c),
              principalId,
            },
            readStateEventListQuery(
              new URL(c.req.raw.url).searchParams,
            ),
          ),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/principal',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const principalId = c.req.param('principalId');
        assertSelfPrincipal(authSession.clientId, principalId);
        const requestBody = await readRequestWithRequestId(c);
        validateClientMutationRequest('upsertPrincipal', requestBody);
        const request = withActor(requestBody, authSession);
        const snapshot = await deps.processClientAppInbox<ClientPrincipalUpsertAppInboxPayload>({
          type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
          resourceId: request.requestId,
          contextId: toClientAppInboxContextId(scope, principalId),
          senderId: authSession.clientId,
          data: {
            scope,
            principalId,
            request,
          },
        });
        return c.json(snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/instances/:clientInstanceId',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const principalId = c.req.param('principalId');
        const clientInstanceId = c.req.param('clientInstanceId');
        assertSelfPrincipal(authSession.clientId, principalId);
        const requestBody = await readRequestWithRequestId(c);
        validateClientMutationRequest('upsertInstance', requestBody);
        const request = withActor(
          requestBody as UpsertClientInstanceRequest & { requestId: string },
          authSession,
        );
        const snapshot = await deps.processClientAppInbox<ClientInstanceUpsertAppInboxPayload>({
          type: AppInboxType.CLIENT_INSTANCE_UPSERT,
          resourceId: request.requestId,
          contextId: toClientAppInboxContextId(scope, principalId),
          senderId: authSession.clientId,
          data: {
            scope,
            principalId,
            clientInstanceId,
            request,
          },
        });
        return c.json(snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/instances/:clientInstanceId/sessions/:sessionId',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const principalId = c.req.param('principalId');
        const clientInstanceId = c.req.param('clientInstanceId');
        const sessionId = c.req.param('sessionId');
        assertSelfSession(
          authSession,
          principalId,
          sessionId,
        );
        const requestBody = await readRequestWithRequestId(c);
        validateClientMutationRequest('connectSession', requestBody);
        const request = withActor(requestBody, authSession);
        const snapshot = await deps.processClientAppInbox<ClientSessionConnectAppInboxPayload>({
          type: AppInboxType.CLIENT_SESSION_CONNECT,
          resourceId: request.requestId,
          contextId: toClientAppInboxContextId(scope, principalId),
          senderId: authSession.clientId,
          data: {
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
          },
        });
        return c.json(snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/instances/:clientInstanceId/sessions/:sessionId/heartbeat',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const principalId = c.req.param('principalId');
        const clientInstanceId = c.req.param('clientInstanceId');
        const sessionId = c.req.param('sessionId');
        assertSelfSession(
          authSession,
          principalId,
          sessionId,
        );
        const requestBody = await readRequestWithRequestId(c);
        validateClientMutationRequest('heartbeatSession', requestBody);
        const request = withActor(requestBody, authSession);
        const snapshot = await deps.processClientAppInbox<ClientSessionHeartbeatAppInboxPayload>({
          type: AppInboxType.CLIENT_SESSION_HEARTBEAT,
          resourceId: request.requestId,
          contextId: toClientAppInboxContextId(scope, principalId),
          senderId: authSession.clientId,
          data: {
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
          },
        });
        return c.json(snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/instances/:clientInstanceId/sessions/:sessionId/disconnect',
    async (c) => {
      try {
        const authSession = await deps.requireApiAuthSession(c.req);
        const scope = toScope(c);
        const principalId = c.req.param('principalId');
        const clientInstanceId = c.req.param('clientInstanceId');
        const sessionId = c.req.param('sessionId');
        assertSelfSession(
          authSession,
          principalId,
          sessionId,
        );
        const requestBody = await readRequestWithRequestId(c);
        validateClientMutationRequest('disconnectSession', requestBody);
        const request = withActor(requestBody, authSession);
        const snapshot = await deps.processClientAppInbox<ClientSessionDisconnectAppInboxPayload>({
          type: AppInboxType.CLIENT_SESSION_DISCONNECT,
          resourceId: request.requestId,
          contextId: toClientAppInboxContextId(scope, principalId),
          senderId: authSession.clientId,
          data: {
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
          },
        });
        return c.json(snapshot);
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );
}

function toClientStateRouteDependencies(
  dependencies: ClientStateRouteDependencies,
): Required<ClientStateRouteDependencies> {
  return {
    getClientStateService: dependencies.getClientStateService ??
      getClientStateService,
    requireApiAuthSession: dependencies.requireApiAuthSession ??
      defaultRequireApiAuthSession,
    hydrateStateSyncSnapshotCaches: dependencies.hydrateStateSyncSnapshotCaches ??
      defaultHydrateStateSyncSnapshotCaches,
    processClientAppInbox: dependencies.processClientAppInbox ??
      processClientAppInbox,
  };
}

async function listRecentClientEventsForArrayRoute(
  service: ClientStateRouteService,
  ref: ClientPrincipalRef,
  query: StateEventListQuery,
): Promise<readonly ClientEvent[]> {
  return service.listRecentEvents
    ? await service.listRecentEvents(ref, query)
    : filterStateEventsForList(await service.listEvents(ref), query);
}

async function assertCanReadClientState(
  req: {
    header(name: string): string | undefined;
  },
  deps: Required<ClientStateRouteDependencies>,
  principalId: string,
): Promise<void> {
  const authSession = await readStrictReadAuthSession(req, deps);
  if (!authSession) {
    return;
  }

  if (authSession.clientId !== principalId) {
    throw new Error(
      'Forbidden: state read principal id does not match authenticated client',
    );
  }
}

async function readStrictReadAuthSession(
  req: {
    header(name: string): string | undefined;
  },
  deps: Required<ClientStateRouteDependencies>,
): Promise<ClientStateRouteAuthSession | undefined> {
  return isStrictReadAuthEnabled() ? await deps.requireApiAuthSession(req) : undefined;
}

function isStrictReadAuthEnabled(): boolean {
  const value = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
  if (value === undefined || value.trim() === '') {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function hydrateClientSnapshots(
  deps: Required<ClientStateRouteDependencies>,
  clients: readonly ClientSnapshot[],
): void {
  if (clients.length === 0) {
    return;
  }

  void deps.hydrateStateSyncSnapshotCaches({ clients })
    .catch((error) => console.warn('Failed to hydrate client state sync snapshot caches', error));
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function processClientAppInbox<V>(
  enqueue: AppInboxEnqueueInput<V>,
): Promise<ClientSnapshot> {
  const result = await getMiddleware().appClientInboxService.processEntryUntilCompletion<
    V,
    ClientStateWritten
  >(
    enqueue,
  );

  return result.fold(
    (error) => {
      throw new Error(error);
    },
    (value) => requireClientStateWrittenSnapshot(value),
  );
}

function requireClientStateWrittenSnapshot(
  written: ClientStateWritten,
): ClientSnapshot {
  const mutation = written.result.right;
  if (!mutation || !mutation.snapshot) {
    throw new Error(written.result.left ?? 'Client mutation failed');
  }

  return mutation.snapshot;
}

async function readRequestWithRequestId(c: {
  req: {
    json(): Promise<unknown>;
    header(name: string): string | undefined;
  };
}): Promise<Record<string, unknown> & { requestId: string }> {
  const requestBody = await c.req.json();
  if (
    typeof requestBody !== 'object' || requestBody === null ||
    Array.isArray(requestBody)
  ) {
    throw new ClientMutationRejectedError('Client request must be a plain object');
  }
  const body = requestBody as Record<string, unknown>;
  if (body.requestId !== undefined &&
    (typeof body.requestId !== 'string' || body.requestId.trim().length === 0)) {
    throw new ClientMutationRejectedError(
      'Client request requestId must be a non-empty string',
    );
  }
  const requestId = body.requestId ??
    c.req.header('Idempotency-Key') ??
    crypto.randomUUID();

  return {
    ...body,
    requestId: String(requestId),
  };
}

function toClientAppInboxContextId(scope: StateScope, principalId: string): string {
  return [scope.applicationId, scope.workspaceId, principalId]
    .map(encodeURIComponent)
    .join(':');
}

function toScope(c: {
  req: {
    param(key: 'applicationId' | 'workspaceId'): string;
  };
}): StateScope {
  return {
    applicationId: c.req.param('applicationId'),
    workspaceId: c.req.param('workspaceId'),
  };
}

function toErrorResponse(
  c: {
    json(value: unknown, status?: number): Response;
  },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  const serialized = readSerializedRouteError(message);
  const explicitStatus = readErrorStatus(error) ?? serialized?.status;
  const responseMessage = serialized?.error ?? serialized?.message ?? message;
  const status = explicitStatus ?? (message.includes('not found')
    ? 404
    : message.startsWith('Unauthorized:')
    ? 401
    : message.startsWith('Forbidden:')
    ? 403
    : message.includes('already exists')
    ? 409
    : 400);

  return c.json({
    error: responseMessage,
    ...(serialized?.code ? { code: serialized.code } : {}),
  }, status);
}

function readErrorStatus(error: unknown): number | undefined {
  if (
    typeof error !== 'object' || error === null || !('status' in error) ||
    !Number.isSafeInteger(error.status) ||
    (error.status as number) < 400 || (error.status as number) > 599
  ) {
    return undefined;
  }
  return error.status as number;
}

function readSerializedRouteError(message: string): Readonly<{
  error?: string;
  message?: string;
  code?: string;
  status?: number;
}> | undefined {
  try {
    const value = JSON.parse(message) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const status = Number.isSafeInteger(record.status) &&
        (record.status as number) >= 400 && (record.status as number) <= 599
      ? record.status as number
      : undefined;
    return {
      ...(typeof record.error === 'string' ? { error: record.error } : {}),
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
      ...(status === undefined ? {} : { status }),
    };
  } catch {
    return undefined;
  }
}

function withActor<
  T extends {
    actorPrincipalId?: string;
    actorSessionId?: string;
  },
>(
  request: T,
  authSession: {
    clientId: string;
    sessionId: string;
  },
): T {
  return {
    ...request,
    actorPrincipalId: authSession.clientId,
    actorSessionId: authSession.sessionId,
  };
}

function assertSelfPrincipal(
  clientId: string,
  principalId: string,
): void {
  if (clientId !== principalId) {
    throw new Error('Forbidden: principal id does not match authenticated client');
  }
}

function assertSelfSession(
  authSession: {
    clientId: string;
    sessionId: string;
  },
  principalId: string,
  sessionId: string,
): void {
  assertSelfPrincipal(authSession.clientId, principalId);

  if (authSession.sessionId !== sessionId) {
    throw new Error('Forbidden: session id does not match authenticated session');
  }
}
