import { Hono } from 'jsr:@hono/hono';
import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    StateScope,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import { getClientStateService } from '../services/client-state-service.ts';
import { requireApiAuthSession } from '../services/request-auth-service.ts';

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
            return c.json(
                await getClientStateService().listEvents({
                    ...toScope(c),
                    principalId: c.req.param('principalId'),
                }),
            );
        },
    );

    app.put(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/principal',
        async (c) => {
            try {
                const authSession = await requireApiAuthSession(c.req);
                assertSelfPrincipal(authSession.clientId, c.req.param('principalId'));
                const snapshot = await getClientStateService().upsertPrincipal(
                    toScope(c),
                    c.req.param('principalId'),
                    withActor(
                        await c.req.json() as UpsertClientPrincipalRequest,
                        authSession,
                    ),
                );
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
                assertSelfPrincipal(authSession.clientId, c.req.param('principalId'));
                const snapshot = await getClientStateService().upsertInstance(
                    toScope(c),
                    c.req.param('principalId'),
                    c.req.param('clientInstanceId'),
                    withActor(
                        await c.req.json() as UpsertClientInstanceRequest,
                        authSession,
                    ),
                );
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
                assertSelfSession(
                    authSession,
                    c.req.param('principalId'),
                    c.req.param('sessionId'),
                );
                const snapshot = await getClientStateService().connectSession(
                    toScope(c),
                    c.req.param('principalId'),
                    c.req.param('clientInstanceId'),
                    c.req.param('sessionId'),
                    withActor(
                        await c.req.json() as ConnectClientSessionRequest,
                        authSession,
                    ),
                );
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
                assertSelfSession(
                    authSession,
                    c.req.param('principalId'),
                    c.req.param('sessionId'),
                );
                const snapshot = await getClientStateService().heartbeatSession(
                    toScope(c),
                    c.req.param('principalId'),
                    c.req.param('clientInstanceId'),
                    c.req.param('sessionId'),
                    withActor(
                        await c.req.json() as HeartbeatClientSessionRequest,
                        authSession,
                    ),
                );
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
                assertSelfSession(
                    authSession,
                    c.req.param('principalId'),
                    c.req.param('sessionId'),
                );
                const snapshot = await getClientStateService().disconnectSession(
                    toScope(c),
                    c.req.param('principalId'),
                    c.req.param('clientInstanceId'),
                    c.req.param('sessionId'),
                    withActor(
                        await c.req.json() as DisconnectClientSessionRequest,
                        authSession,
                    ),
                );
                return c.json(snapshot);
            } catch (error) {
                return toErrorResponse(c, error);
            }
        },
    );
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
