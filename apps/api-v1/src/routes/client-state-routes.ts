import { Hono } from 'jsr:@hono/hono@4.11.9';
import type {
  ConnectClientSessionRequest,
  DisconnectClientSessionRequest,
  HeartbeatClientSessionRequest,
  StateScope,
  UpsertClientInstanceRequest,
  UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
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
} from '@shared-server/rallar-system/state-event-listing.ts';
import {
  hydrateStateSyncSnapshotCaches as defaultHydrateStateSyncSnapshotCaches,
  type StateSyncCacheHydrationInput,
  type StateSyncCacheHydrationResult,
} from '@shared-server/rallar-system/state-sync-cache-hydration.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

export type ClientStateRouteService = Pick<
  ClientStateService,
  | 'listSnapshots'
  | 'readSnapshot'
  | 'readPresenceSnapshot'
  | 'listEvents'
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
        const events = await deps.getClientStateService().listEvents({
          ...toScope(c),
          principalId,
        });

        return c.json(
          filterStateEventsForList(
            events,
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
        const request = withActor(
          await readRequestWithRequestId<UpsertClientPrincipalRequest>(c),
          authSession,
        );
        const snapshot = await processClientAppInbox<ClientPrincipalUpsertAppInboxPayload>({
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
        const request = withActor(
          await readRequestWithRequestId<UpsertClientInstanceRequest>(c),
          authSession,
        );
        const snapshot = await processClientAppInbox<ClientInstanceUpsertAppInboxPayload>({
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
        const request = withActor(
          await readRequestWithRequestId<ConnectClientSessionRequest>(c),
          authSession,
        );
        const snapshot = await processClientAppInbox<ClientSessionConnectAppInboxPayload>({
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
        const request = withActor(
          await readRequestWithRequestId<HeartbeatClientSessionRequest>(c),
          authSession,
        );
        const snapshot = await processClientAppInbox<ClientSessionHeartbeatAppInboxPayload>({
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
        const request = withActor(
          await readRequestWithRequestId<DisconnectClientSessionRequest>(c),
          authSession,
        );
        const snapshot = await processClientAppInbox<ClientSessionDisconnectAppInboxPayload>({
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
  };
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

async function readRequestWithRequestId<T extends { requestId?: string }>(c: {
  req: {
    json(): Promise<unknown>;
    header(name: string): string | undefined;
  };
}): Promise<T & { requestId: string }> {
  const requestBody = (await c.req.json()) as T;
  const requestId = requestBody.requestId ??
    c.req.header('Idempotency-Key') ??
    crypto.randomUUID();

  return {
    ...requestBody,
    requestId,
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
  const status = message.includes('not found')
    ? 404
    : message.startsWith('Unauthorized:')
    ? 401
    : message.startsWith('Forbidden:')
    ? 403
    : message.includes('already exists')
    ? 409
    : 400;

  return c.json({ error: message }, status);
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
