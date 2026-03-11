import { Hono } from 'jsr:@hono/hono';
import type {
    ConnectGroupPresenceSessionRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    StateScope,
    UpdateGroupRequest,
    UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import { getGroupStateService } from '../services/group-state-service.ts';
import { requireApiAuthSession } from '../services/request-auth-service.ts';

export function init(app: Hono): void {
    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups',
        async (c) => {
            return c.json(await getGroupStateService().listSnapshots(toScope(c)));
        },
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
        async (c) => {
            const groupId = c.req.param('groupId');
            const snapshot = await getGroupStateService().readSnapshot({
                ...toScope(c),
                groupId,
            });

            return snapshot ? c.json(snapshot) : c.json({ error: `Group not found: ${groupId}` }, 404);
        },
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events',
        async (c) => {
            return c.json(
                await getGroupStateService().listEvents({
                    ...toScope(c),
                    groupId: c.req.param('groupId'),
                }),
            );
        },
    );

    app.post(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups',
        async (c) => {
            try {
                const authSession = await requireApiAuthSession(c.req);
                const snapshot = await getGroupStateService().createGroup(
                    toScope(c),
                    withActorAndCreator(
                        await c.req.json() as CreateGroupRequest,
                        authSession,
                    ),
                );
                return c.json(snapshot, 201);
            } catch (error) {
                return toErrorResponse(c, error);
            }
        },
    );

    app.put(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
        async (c) => {
            try {
                const authSession = await requireApiAuthSession(c.req);
                await assertCanUpdateGroup(authSession.clientId, toScope(c), c.req.param('groupId'));
                const snapshot = await getGroupStateService().updateGroup(
                    toScope(c),
                    c.req.param('groupId'),
                    withActor(
                        await c.req.json() as UpdateGroupRequest,
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
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId',
        async (c) => {
            try {
                const authSession = await requireApiAuthSession(c.req);
                const principalId = c.req.param('principalId');
                assertSelfPrincipal(authSession.clientId, principalId);
                const request = await c.req.json() as UpsertGroupMemberRequest;
                assertSelfServiceMemberStatus(request.status);
                const snapshot = await getGroupStateService().upsertMember(
                    toScope(c),
                    c.req.param('groupId'),
                    principalId,
                    withActor(
                        {
                            ...request,
                            role: undefined,
                        },
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
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId',
        async (c) => {
            try {
                const authSession = await requireApiAuthSession(c.req);
                assertSelfSession(authSession, c.req.param('sessionId'));
                const snapshot = await getGroupStateService().connectPresenceSession(
                    toScope(c),
                    c.req.param('groupId'),
                    c.req.param('sessionId'),
                    {
                        ...(await c.req.json() as ConnectGroupPresenceSessionRequest),
                        principalId: authSession.clientId,
                        actorPrincipalId: authSession.clientId,
                        actorSessionId: authSession.sessionId,
                    },
                );
                return c.json(snapshot);
            } catch (error) {
                return toErrorResponse(c, error);
            }
        },
    );

    app.post(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId/heartbeat',
        async (c) => {
            try {
                const authSession = await requireApiAuthSession(c.req);
                assertSelfSession(authSession, c.req.param('sessionId'));
                const snapshot = await getGroupStateService().heartbeatPresenceSession(
                    toScope(c),
                    c.req.param('groupId'),
                    c.req.param('sessionId'),
                    {
                        ...(await c.req.json() as HeartbeatGroupPresenceSessionRequest),
                        principalId: authSession.clientId,
                        actorPrincipalId: authSession.clientId,
                        actorSessionId: authSession.sessionId,
                    },
                );
                return c.json(snapshot);
            } catch (error) {
                return toErrorResponse(c, error);
            }
        },
    );

    app.post(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId/disconnect',
        async (c) => {
            try {
                const authSession = await requireApiAuthSession(c.req);
                assertSelfSession(authSession, c.req.param('sessionId'));
                const snapshot = await getGroupStateService().disconnectPresenceSession(
                    toScope(c),
                    c.req.param('groupId'),
                    c.req.param('sessionId'),
                    {
                        ...(await c.req.json() as DisconnectGroupPresenceSessionRequest),
                        principalId: authSession.clientId,
                        actorPrincipalId: authSession.clientId,
                        actorSessionId: authSession.sessionId,
                    },
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

function withActorAndCreator(
    request: CreateGroupRequest,
    authSession: {
        clientId: string;
        sessionId: string;
    },
): CreateGroupRequest {
    return {
        ...request,
        createdByPrincipalId: authSession.clientId,
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
    sessionId: string,
): void {
    if (authSession.sessionId !== sessionId) {
        throw new Error('Forbidden: session id does not match authenticated session');
    }
}

function assertSelfServiceMemberStatus(status: UpsertGroupMemberRequest['status']): void {
    if (status !== 'active' && status !== 'left') {
        throw new Error('Forbidden: self-service membership changes only support active/left');
    }
}

async function assertCanUpdateGroup(
    principalId: string,
    scope: StateScope,
    groupId: string,
): Promise<void> {
    const snapshot = await getGroupStateService().readSnapshot({
        ...scope,
        groupId,
    });
    if (!snapshot) {
        throw new Error(`Group not found: ${groupId}`);
    }
    const member = snapshot.members.find((entry) => entry.principalId === principalId);
    if (!member || member.status !== 'active') {
        throw new Error('Forbidden: only active group owners/admins can update groups');
    }

    if (member.role !== 'owner' && member.role !== 'admin') {
        throw new Error('Forbidden: only group owners/admins can update groups');
    }
}
