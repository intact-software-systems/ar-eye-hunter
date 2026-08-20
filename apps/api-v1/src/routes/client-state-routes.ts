import { type Context, Hono } from 'jsr:@hono/hono@4.11.9';
import type {
  ApiMutationFailureJsonObject,
  ApiMutationFailureJsonValue,
} from '@shared/api/mutation/api-mutation.ts';
import type { StateScope, UpsertClientInstanceRequest } from '@shared/api/state-types.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type { ClientEvent, ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type {
  ClientStateService,
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { authorizationDenied } from '../services/request-auth-service.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxType,
  type ClientInstanceUpsertAppInboxPayload,
  type ClientPrincipalUpsertAppInboxPayload,
  type ClientSessionConnectAppInboxPayload,
  type ClientSessionDisconnectAppInboxPayload,
  type ClientSessionHeartbeatAppInboxPayload,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import type {
  ClientStateWritten,
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';
import {
  toAuthenticatedClientMutationContextId,
} from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import {
  filterStateEventsForList,
  readStateEventListQuery,
  type StateEventListQuery,
} from '@shared-server/rallar-system/state-event-listing.ts';
import {
  type StateSyncCacheHydrationInput,
  type StateSyncCacheHydrationResult,
} from '@shared-server/rallar-system/state-sync-cache-hydration.ts';
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import {
  ClientMutationRejectedError,
  validateClientMutationRequest,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import { readApiMutationRouteRequestId } from './api-mutation-route-ingress.ts';
import {
  toApiMutationFailureResponse,
  toApiMutationRouteFailure,
} from './api-mutation-route-failure.ts';
import {
  type ClientStatePointRead,
  readCurrentClientSnapshot,
  registerClientStatePointReadRoute,
} from './client-state-point-read-route.ts';
import { toClientStateRouteErrorResponse } from './to-client-state-route-error-response.ts';

const CLIENT_PRINCIPAL_PATH =
  '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId';
const CLIENT_INSTANCE_PATH = `${CLIENT_PRINCIPAL_PATH}/instances/:clientInstanceId`;
const CLIENT_SESSION_PATH = `${CLIENT_INSTANCE_PATH}/sessions/:sessionId`;

export type ClientStateRouteService =
  & Pick<
    ClientStateService,
    | 'listSnapshots'
    | 'readSnapshot'
    | 'readPresenceSnapshot'
    | 'listEvents'
    | 'listRecentEvents'
    | 'listEventPage'
  >
  & Readonly<{
    readCurrentSnapshot?(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
  }>;

export type ProcessClientAppInbox = <V>(
  enqueue: AppInboxEnqueueInput<V>,
  authority: IssuedAuthSession,
) => Promise<Either<AppInboxFailure, ClientStateWritten>>;

export type ClientStateRouteDependencies = Readonly<{
  clientStateService: ClientStateRouteService;
  requireApiAuthSession: (
    req: {
      header(name: string): string | undefined;
    },
  ) => Promise<IssuedAuthSession>;
  hydrateStateSyncSnapshotCaches: (
    input: StateSyncCacheHydrationInput,
  ) => Promise<StateSyncCacheHydrationResult>;
  processClientAppInbox: ProcessClientAppInbox;
  readClientSnapshot: ClientStatePointRead;
}>;

export function registerClientStateRoutes(
  app: Hono,
  dependencies: ClientStateRouteDependencies,
): void {
  const deps = dependencies;

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients',
    async (c) => {
      try {
        const scope = toScope(c);
        const authSession = await readStrictReadAuthSession(c.req, deps);
        const snapshots = authSession
          ? [
            await readCurrentClientSnapshot(deps.clientStateService, {
              ...scope,
              principalId: authSession.clientId,
            }),
          ].filter(isDefined)
          : await deps.clientStateService.listSnapshots(scope);
        hydrateClientSnapshots(deps, snapshots);
        return c.json(snapshots);
      } catch (error) {
        return toClientStateRouteErrorResponse(
          c,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  );

  registerClientStatePointReadRoute(app, {
    read: deps.readClientSnapshot,
    requireAuthSession: deps.requireApiAuthSession,
    hydrate: (snapshots) => hydrateClientSnapshots(deps, snapshots),
    toErrorResponse: (response, error) =>
      toClientStateRouteErrorResponse(
        response,
        error instanceof Error ? error : new Error(String(error)),
      ),
  });

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/presence',
    async (c) => {
      try {
        const principalId = c.req.param('principalId');
        await assertCanReadClientState(c.req, deps, principalId);
        const snapshot = await deps.clientStateService.readPresenceSnapshot({
          ...toScope(c),
          principalId,
        });

        return snapshot
          ? c.json(snapshot)
          : c.json({ error: `Client presence not found: ${principalId}` }, 404);
      } catch (error) {
        return toClientStateRouteErrorResponse(
          c,
          error instanceof Error ? error : new Error(String(error)),
        );
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
            deps.clientStateService,
            ref,
            query,
          ),
        );
      } catch (error) {
        return toClientStateRouteErrorResponse(
          c,
          error instanceof Error ? error : new Error(String(error)),
        );
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
          await deps.clientStateService.listEventPage(
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
        return toClientStateRouteErrorResponse(
          c,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  );

  app.put(
    `${CLIENT_PRINCIPAL_PATH}/principal/requests/:requestId`,
    (context) => handleClientPrincipalUpsert(context, deps),
  );

  app.put(
    `${CLIENT_INSTANCE_PATH}/requests/:requestId`,
    (context) => handleClientInstanceUpsert(context, deps),
  );

  app.put(
    `${CLIENT_SESSION_PATH}/requests/:requestId`,
    (context) => handleClientSessionConnect(context, deps),
  );

  app.post(
    `${CLIENT_SESSION_PATH}/heartbeat/requests/:requestId`,
    (context) => handleClientSessionHeartbeat(context, deps),
  );

  app.post(
    `${CLIENT_SESSION_PATH}/disconnect/requests/:requestId`,
    (context) => handleClientSessionDisconnect(context, deps),
  );
}

async function handleClientPrincipalUpsert(
  context: Context,
  dependencies: ClientStateRouteDependencies,
): Promise<Response> {
  try {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const scope = toScope(context);
    const principalId = context.req.param('principalId');
    assertSelfPrincipal(authSession.clientId, principalId);
    const requestBody = await readRequestWithRequestId(context);
    validateClientMutationRequest('upsertPrincipal', requestBody);
    const request = withActor(requestBody, authSession);
    const snapshot = await processClientAppInbox<ClientPrincipalUpsertAppInboxPayload>(
      dependencies,
      {
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        resourceId: request.requestId,
        contextId: toAuthenticatedClientMutationContextId({
          scope,
          principalId,
          callerClientId: authSession.clientId,
          callerSessionId: authSession.sessionId,
        }),
        senderId: authSession.clientId,
        data: { scope, principalId, request },
      },
      authSession,
    );
    return context.json(snapshot);
  } catch (error) {
    return toApiMutationFailureResponse(
      context,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

async function handleClientInstanceUpsert(
  context: Context,
  dependencies: ClientStateRouteDependencies,
): Promise<Response> {
  try {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const scope = toScope(context);
    const principalId = context.req.param('principalId');
    const clientInstanceId = context.req.param('clientInstanceId');
    assertSelfPrincipal(authSession.clientId, principalId);
    const requestBody = await readRequestWithRequestId(context);
    validateClientMutationRequest('upsertInstance', requestBody);
    const request = withActor(
      requestBody as UpsertClientInstanceRequest & { requestId: string },
      authSession,
    );
    const snapshot = await processClientAppInbox<ClientInstanceUpsertAppInboxPayload>(
      dependencies,
      {
        type: AppInboxType.CLIENT_INSTANCE_UPSERT,
        topicId: AppInboxType.CLIENT_INSTANCE_UPSERT,
        resourceId: request.requestId,
        contextId: toAuthenticatedClientMutationContextId({
          scope,
          principalId,
          callerClientId: authSession.clientId,
          callerSessionId: authSession.sessionId,
        }),
        senderId: authSession.clientId,
        data: { scope, principalId, clientInstanceId, request },
      },
      authSession,
    );
    return context.json(snapshot);
  } catch (error) {
    return toApiMutationFailureResponse(
      context,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

async function handleClientSessionConnect(
  context: Context,
  dependencies: ClientStateRouteDependencies,
): Promise<Response> {
  try {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const { scope, principalId, clientInstanceId, sessionId } = readClientSessionRoute(context);
    assertSelfSession(authSession, principalId, sessionId);
    const requestBody = await readRequestWithRequestId(context);
    validateClientMutationRequest('connectSession', requestBody);
    const request = withActor(requestBody, authSession);
    const snapshot = await processClientAppInbox<ClientSessionConnectAppInboxPayload>(
      dependencies,
      {
        type: AppInboxType.CLIENT_SESSION_CONNECT,
        topicId: AppInboxType.CLIENT_SESSION_CONNECT,
        resourceId: request.requestId,
        contextId: toAuthenticatedClientMutationContextId({
          scope,
          principalId,
          callerClientId: authSession.clientId,
          callerSessionId: authSession.sessionId,
        }),
        senderId: authSession.clientId,
        data: { scope, principalId, clientInstanceId, sessionId, request },
      },
      authSession,
    );
    return context.json(snapshot);
  } catch (error) {
    return toApiMutationFailureResponse(
      context,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

async function handleClientSessionHeartbeat(
  context: Context,
  dependencies: ClientStateRouteDependencies,
): Promise<Response> {
  try {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const { scope, principalId, clientInstanceId, sessionId } = readClientSessionRoute(context);
    assertSelfSession(authSession, principalId, sessionId);
    const requestBody = await readRequestWithRequestId(context);
    validateClientMutationRequest('heartbeatSession', requestBody);
    const request = withActor(requestBody, authSession);
    const snapshot = await processClientAppInbox<ClientSessionHeartbeatAppInboxPayload>(
      dependencies,
      {
        type: AppInboxType.CLIENT_SESSION_HEARTBEAT,
        topicId: AppInboxType.CLIENT_SESSION_HEARTBEAT,
        resourceId: request.requestId,
        contextId: toAuthenticatedClientMutationContextId({
          scope,
          principalId,
          callerClientId: authSession.clientId,
          callerSessionId: authSession.sessionId,
        }),
        senderId: authSession.clientId,
        data: { scope, principalId, clientInstanceId, sessionId, request },
      },
      authSession,
    );
    return context.json(snapshot);
  } catch (error) {
    return toApiMutationFailureResponse(
      context,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

async function handleClientSessionDisconnect(
  context: Context,
  dependencies: ClientStateRouteDependencies,
): Promise<Response> {
  try {
    const authSession = await dependencies.requireApiAuthSession(context.req);
    const { scope, principalId, clientInstanceId, sessionId } = readClientSessionRoute(context);
    assertSelfSession(authSession, principalId, sessionId);
    const requestBody = await readRequestWithRequestId(context);
    validateClientMutationRequest('disconnectSession', requestBody);
    const request = withActor(requestBody, authSession);
    const snapshot = await processClientAppInbox<ClientSessionDisconnectAppInboxPayload>(
      dependencies,
      {
        type: AppInboxType.CLIENT_SESSION_DISCONNECT,
        topicId: AppInboxType.CLIENT_SESSION_DISCONNECT,
        resourceId: request.requestId,
        contextId: toAuthenticatedClientMutationContextId({
          scope,
          principalId,
          callerClientId: authSession.clientId,
          callerSessionId: authSession.sessionId,
        }),
        senderId: authSession.clientId,
        data: { scope, principalId, clientInstanceId, sessionId, request },
      },
      authSession,
    );
    return context.json(snapshot);
  } catch (error) {
    return toApiMutationFailureResponse(
      context,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

function readClientSessionRoute(context: Context): Readonly<{
  scope: StateScope;
  principalId: string;
  clientInstanceId: string;
  sessionId: string;
}> {
  return {
    scope: toScope(context),
    principalId: context.req.param('principalId'),
    clientInstanceId: context.req.param('clientInstanceId'),
    sessionId: context.req.param('sessionId'),
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
  deps: ClientStateRouteDependencies,
  principalId: string,
): Promise<void> {
  const authSession = await readStrictReadAuthSession(req, deps);
  if (!authSession) {
    return;
  }

  if (authSession.clientId !== principalId) {
    throw authorizationDenied(
      'Forbidden: state read principal id does not match authenticated client',
    );
  }
}

async function readStrictReadAuthSession(
  req: {
    header(name: string): string | undefined;
  },
  deps: ClientStateRouteDependencies,
): Promise<IssuedAuthSession | undefined> {
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
  deps: ClientStateRouteDependencies,
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
  deps: ClientStateRouteDependencies,
  enqueue: AppInboxEnqueueInput<V>,
  authority: IssuedAuthSession,
): Promise<ClientSnapshot> {
  const result = await deps.processClientAppInbox(enqueue, authority);
  if (result.left !== undefined) {
    throw toApiMutationRouteFailure(result.left);
  }
  const written = result.right;
  if (written === undefined) {
    throw new Error('Client AppInbox mutation result is unavailable');
  }
  const snapshot = requireClientStateWrittenSnapshot(written);
  await hydrateClientMutationSnapshot(deps, snapshot);
  return snapshot;
}

async function hydrateClientMutationSnapshot(
  deps: ClientStateRouteDependencies,
  snapshot: ClientSnapshot,
): Promise<void> {
  try {
    await deps.hydrateStateSyncSnapshotCaches({ clients: [snapshot] });
  } catch (error) {
    console.warn('Failed to hydrate client mutation snapshot cache', error);
  }
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
    param(name: string): string;
  };
}): Promise<Record<string, unknown> & { requestId: string }> {
  const requestBody = await c.req.json();
  if (
    typeof requestBody !== 'object' || requestBody === null ||
    Array.isArray(requestBody)
  ) {
    throw new ClientMutationRejectedError('Client request must be a plain object');
  }
  const body = requestBody as Record<string, unknown> & ApiMutationFailureJsonObject;
  const requestId = readApiMutationRouteRequestId({
    requestId: c.req.param('requestId'),
    idempotencyKey: c.req.header('idempotency-key'),
    mutationBody: body as ApiMutationFailureJsonValue,
  });

  return {
    ...body,
    requestId: String(requestId),
  };
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
    throw authorizationDenied(
      'Forbidden: principal id does not match authenticated client',
    );
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
    throw authorizationDenied(
      'Forbidden: session id does not match authenticated session',
    );
  }
}
