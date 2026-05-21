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
import { getMiddleware } from '../middleware.ts';
import type {
    GroupMutationWritten,
    GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import {
    type GroupCreateAppInboxPayload,
    type GroupMemberUpsertAppInboxPayload,
    type GroupPresenceConnectAppInboxPayload,
    type GroupPresenceDisconnectAppInboxPayload,
    type GroupPresenceHeartbeatAppInboxPayload,
    type GroupUpdateAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxEnqueueInput, AppInboxType, } from '@shared-server/rallar-system/services/AppInboxService.ts';

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
                const scope = toScope(c);
                const requestBody = await readRequestWithRequestId<CreateGroupRequest>(c);
                const request = withActorAndCreator(requestBody, authSession);
                const written = unwrapGroupStateWritten(
                    await processGroupAppInbox<
                        GroupCreateAppInboxPayload,
                        GroupStateWritten
                    >({
                        type: AppInboxType.GROUP_CREATE,
                        resourceId: request.requestId,
                        contextId: toGroupAppInboxContextId(scope, request.groupId),
                        senderId: authSession.clientId,
                        data: {
                            scope,
                            request,
                        },
                    }),
                );

                return c.json(written.snapshot, 201);
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
                const scope = toScope(c);
                const groupId = c.req.param('groupId');
                await assertCanUpdateGroup(authSession.clientId, scope, groupId);
                const request = withActor(
                    await readRequestWithRequestId<UpdateGroupRequest>(c),
                    authSession,
                );
                const written = unwrapGroupStateWritten(
                    await processGroupAppInbox<
                        GroupUpdateAppInboxPayload,
                        GroupStateWritten
                    >({
                        type: AppInboxType.GROUP_UPDATE,
                        resourceId: request.requestId,
                        contextId: toGroupAppInboxContextId(scope, groupId),
                        senderId: authSession.clientId,
                        data: {
                            scope,
                            groupId,
                            request,
                        },
                    }),
                );
                return c.json(written.snapshot);
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
                const scope = toScope(c);
                const groupId = c.req.param('groupId');
                const principalId = c.req.param('principalId');
                assertSelfPrincipal(authSession.clientId, principalId);
                const request = await readRequestWithRequestId<UpsertGroupMemberRequest>(c);
                assertSelfServiceMemberStatus(request.status);
                const written = unwrapGroupStateWritten(
                    await processGroupAppInbox<
                        GroupMemberUpsertAppInboxPayload,
                        GroupStateWritten
                    >({
                        type: AppInboxType.GROUP_MEMBER_UPSERT,
                        resourceId: request.requestId,
                        contextId: toGroupAppInboxContextId(scope, groupId),
                        senderId: authSession.clientId,
                        data: {
                            scope,
                            groupId,
                            principalId,
                            request: withActor(
                                {
                                    ...request,
                                    role: undefined,
                                },
                                authSession,
                            ),
                        },
                    }),
                );
                return c.json(written.snapshot);
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
                const scope = toScope(c);
                const groupId = c.req.param('groupId');
                const sessionId = c.req.param('sessionId');
                assertSelfSession(authSession, sessionId);
                const request = await readRequestWithRequestId<ConnectGroupPresenceSessionRequest>(c);
                const written = unwrapGroupStateWritten(
                    await processGroupAppInbox<
                        GroupPresenceConnectAppInboxPayload,
                        GroupStateWritten
                    >({
                        type: AppInboxType.GROUP_PRESENCE_CONNECT,
                        resourceId: request.requestId,
                        contextId: toGroupAppInboxContextId(scope, groupId),
                        senderId: authSession.clientId,
                        data: {
                            scope,
                            groupId,
                            sessionId,
                            request: {
                                ...request,
                                principalId: authSession.clientId,
                                actorPrincipalId: authSession.clientId,
                                actorSessionId: authSession.sessionId,
                            },
                        },
                    }),
                );
                return c.json(written.snapshot);
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
                const scope = toScope(c);
                const groupId = c.req.param('groupId');
                const sessionId = c.req.param('sessionId');
                assertSelfSession(authSession, sessionId);
                const request = await readRequestWithRequestId<HeartbeatGroupPresenceSessionRequest>(
                    c,
                );
                const written = unwrapGroupStateWritten(
                    await processGroupAppInbox<
                        GroupPresenceHeartbeatAppInboxPayload,
                        GroupStateWritten
                    >({
                        type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
                        resourceId: request.requestId,
                        contextId: toGroupAppInboxContextId(scope, groupId),
                        senderId: authSession.clientId,
                        data: {
                            scope,
                            groupId,
                            sessionId,
                            request: {
                                ...request,
                                principalId: authSession.clientId,
                                actorPrincipalId: authSession.clientId,
                                actorSessionId: authSession.sessionId,
                            },
                        },
                    }),
                );
                return c.json(written.snapshot);
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
                const scope = toScope(c);
                const groupId = c.req.param('groupId');
                const sessionId = c.req.param('sessionId');
                assertSelfSession(authSession, sessionId);
                const request = await readRequestWithRequestId<DisconnectGroupPresenceSessionRequest>(
                    c,
                );
                const written = unwrapGroupStateWritten(
                    await processGroupAppInbox<
                        GroupPresenceDisconnectAppInboxPayload,
                        GroupStateWritten
                    >({
                        type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
                        resourceId: request.requestId,
                        contextId: toGroupAppInboxContextId(scope, groupId),
                        senderId: authSession.clientId,
                        data: {
                            scope,
                            groupId,
                            sessionId,
                            request: {
                                ...request,
                                principalId: authSession.clientId,
                                actorPrincipalId: authSession.clientId,
                                actorSessionId: authSession.sessionId,
                            },
                        },
                    }),
                );
                return c.json(written.snapshot);
            } catch (error) {
                return toErrorResponse(c, error);
            }
        },
    );
}

async function processGroupAppInbox<V, R>(
    enqueue: AppInboxEnqueueInput<V>,
): Promise<R> {
    const result = await getMiddleware().appGroupInboxService.processEntryUntilCompletion<V, R>(
        enqueue,
    );

    return result.fold(
        (error) => {
            throw new Error(error);
        },
        (value) => value,
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

function unwrapGroupStateWritten(
    written: GroupStateWritten,
): GroupMutationWritten {
    const result = written.result as
        | GroupStateWritten['result']
        | {
        left?: string;
        right?: GroupMutationWritten;
    };

    if ('fold' in result && typeof result.fold === 'function') {
        return result.fold(
            (error) => {
                throw new Error(error);
            },
            (value) => value,
        );
    }

    if (result.right) {
        return result.right;
    }

    throw new Error(result.left ?? 'Group mutation failed');
}

function toGroupAppInboxContextId(scope: StateScope, groupId: string): string {
    return [scope.applicationId, scope.workspaceId, groupId]
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

function assertSelfPrincipal(clientId: string, principalId: string): void {
    if (clientId !== principalId) {
        throw new Error(
            'Forbidden: principal id does not match authenticated client',
        );
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
        throw new Error(
            'Forbidden: session id does not match authenticated session',
        );
    }
}

function assertSelfServiceMemberStatus(
    status: UpsertGroupMemberRequest['status'],
): void {
    if (status !== 'active' && status !== 'left') {
        throw new Error(
            'Forbidden: self-service membership changes only support active/left',
        );
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
    const member = snapshot.members.find(
        (entry) => entry.principalId === principalId,
    );
    if (!member || member.status !== 'active') {
        throw new Error(
            'Forbidden: only active group owners/admins can update groups',
        );
    }

    if (member.role !== 'owner' && member.role !== 'admin') {
        throw new Error('Forbidden: only group owners/admins can update groups');
    }
}
