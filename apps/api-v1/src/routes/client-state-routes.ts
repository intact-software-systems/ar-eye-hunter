import { Hono } from 'jsr:@hono/hono';
import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    StateScope,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { getClientStateService } from '../services/client-state-service.ts';
import { requireApiAuthSession } from '../services/request-auth-service.ts';
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
import type { ClientStateWritten, } from '@shared-server/rallar-system/services/client-state-service.ts';
import {
    filterStateEventsForList,
    listStateEventsPage,
    readStateEventListQuery,
} from '@shared-server/rallar-system/state-event-listing.ts';

export function init(app: Hono): void {
    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients',
        async (c) => {
            const scope = toScope(c);
            return c.json(await getClientStateService().listSnapshots(scope));
        },
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId',
        async (c) => {
            const principalId = c.req.param('principalId');
            const snapshot = await getClientStateService().readSnapshot({
                ...toScope(c),
                principalId,
            });

            return snapshot
                ? c.json(snapshot)
                : c.json({ error: `Client not found: ${principalId}` }, 404);
        },
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/presence',
        async (c) => {
            const principalId = c.req.param('principalId');
            const snapshot = await getClientStateService().readPresenceSnapshot({
                ...toScope(c),
                principalId,
            });

            return snapshot
                ? c.json(snapshot)
                : c.json({ error: `Client presence not found: ${principalId}` }, 404);
        },
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/events',
        async (c) => {
            const events = await getClientStateService().listEvents({
                ...toScope(c),
                principalId: c.req.param('principalId'),
            });

            return c.json(
                filterStateEventsForList(
                    events,
                    readStateEventListQuery(
                        new URL(c.req.raw.url).searchParams,
                    ),
                ),
            );
        },
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/events/page',
        async (c) => {
            const events = await getClientStateService().listEvents({
                ...toScope(c),
                principalId: c.req.param('principalId'),
            });

            return c.json(
                listStateEventsPage(
                    events,
                    readStateEventListQuery(
                        new URL(c.req.raw.url).searchParams,
                    ),
                ),
            );
        },
    );

    app.put(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/principal',
        async (c) => {
            try {
                const authSession = await requireApiAuthSession(c.req);
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
                const authSession = await requireApiAuthSession(c.req);
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
                const authSession = await requireApiAuthSession(c.req);
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
                const authSession = await requireApiAuthSession(c.req);
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
                const authSession = await requireApiAuthSession(c.req);
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
    return written.result.fold(
        (error) => {
            throw new Error(error);
        },
        (value) => value.snapshot,
    );
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
