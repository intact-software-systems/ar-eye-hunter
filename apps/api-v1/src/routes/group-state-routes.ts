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
import {
    getGroupStateService,
    type GroupStateService,
} from '../services/group-state-service.ts';
import { requireApiAuthSession as defaultRequireApiAuthSession } from '../services/request-auth-service.ts';
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
import type { GroupSnapshot } from '@shared/api/group-types.ts';

export type GroupStateRouteService = Pick<
    GroupStateService,
    | 'listSnapshots'
    | 'readSnapshot'
    | 'listEvents'
    | 'listEventPage'
>;

export type GroupStateRouteAuthSession = Pick<
    AuthSession,
    'clientId' | 'sessionId'
>;

export type GroupStateRouteDependencies = Readonly<{
    getGroupStateService?: () => GroupStateRouteService;
    requireApiAuthSession?: (
        req: {
            header(name: string): string | undefined;
        },
    ) => Promise<GroupStateRouteAuthSession>;
    hydrateStateSyncSnapshotCaches?: (
        input: StateSyncCacheHydrationInput,
    ) => Promise<StateSyncCacheHydrationResult>;
}>;

export function init(
    app: Hono,
    dependencies: GroupStateRouteDependencies = {},
): void {
    const deps = toGroupStateRouteDependencies(dependencies);

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups',
        async (c) => {
            try {
                const authSession = await readStrictReadAuthSession(c.req, deps);
                const snapshots = authSession
                    ? (await deps.getGroupStateService().listSnapshots(toScope(c)))
                        .filter((snapshot) =>
                            canReadGroupSnapshot(authSession.clientId, snapshot)
                        )
                    : await deps.getGroupStateService().listSnapshots(toScope(c));
                hydrateGroupSnapshots(deps, snapshots);
                return c.json(snapshots);
            } catch (error) {
                return toErrorResponse(c, error);
            }
        },
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
        async (c) => {
            try {
                const groupId = c.req.param('groupId');
                const snapshot = await deps.getGroupStateService().readSnapshot({
                    ...toScope(c),
                    groupId,
                });
                if (!snapshot) {
                    return c.json({ error: `Group not found: ${groupId}` }, 404);
                }
                await assertCanReadGroupState(c.req, deps, snapshot);
                hydrateGroupSnapshots(deps, [snapshot]);

                return c.json(snapshot);
            } catch (error) {
                return toErrorResponse(c, error);
            }
        },
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events',
        async (c) => {
            try {
                const groupId = c.req.param('groupId');
                await assertCanReadGroupRef(c.req, deps, {
                    ...toScope(c),
                    groupId,
                });
                const events = await deps.getGroupStateService().listEvents({
                    ...toScope(c),
                    groupId,
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
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events/page',
        async (c) => {
            try {
                const groupId = c.req.param('groupId');
                await assertCanReadGroupRef(c.req, deps, {
                    ...toScope(c),
                    groupId,
                });

                return c.json(
                    await deps.getGroupStateService().listEventPage(
                        {
                            ...toScope(c),
                            groupId,
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

    app.post(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups',
        async (c) => {
            try {
                const authSession = await deps.requireApiAuthSession(c.req);
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
                const authSession = await deps.requireApiAuthSession(c.req);
                const scope = toScope(c);
                const groupId = c.req.param('groupId');
                await assertCanUpdateGroup(
                    authSession.clientId,
                    scope,
                    groupId,
                    deps.getGroupStateService(),
                );
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
                const authSession = await deps.requireApiAuthSession(c.req);
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
                const authSession = await deps.requireApiAuthSession(c.req);
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
                const authSession = await deps.requireApiAuthSession(c.req);
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
                const authSession = await deps.requireApiAuthSession(c.req);
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

function toGroupStateRouteDependencies(
    dependencies: GroupStateRouteDependencies,
): Required<GroupStateRouteDependencies> {
    return {
        getGroupStateService: dependencies.getGroupStateService ??
            getGroupStateService,
        requireApiAuthSession: dependencies.requireApiAuthSession ??
            defaultRequireApiAuthSession,
        hydrateStateSyncSnapshotCaches:
            dependencies.hydrateStateSyncSnapshotCaches ??
                defaultHydrateStateSyncSnapshotCaches,
    };
}

async function assertCanReadGroupRef(
    req: {
        header(name: string): string | undefined;
    },
    deps: Required<GroupStateRouteDependencies>,
    ref: StateScope & Readonly<{ groupId: string }>,
): Promise<void> {
    const authSession = await readStrictReadAuthSession(req, deps);
    if (!authSession) {
        return;
    }

    const snapshot = await deps.getGroupStateService().readSnapshot(ref);
    if (!snapshot) {
        throw new Error(`Group not found: ${ref.groupId}`);
    }

    assertCanReadGroupSnapshot(authSession.clientId, snapshot);
}

async function assertCanReadGroupState(
    req: {
        header(name: string): string | undefined;
    },
    deps: Required<GroupStateRouteDependencies>,
    snapshot: GroupSnapshot,
): Promise<void> {
    const authSession = await readStrictReadAuthSession(req, deps);
    if (!authSession) {
        return;
    }

    assertCanReadGroupSnapshot(authSession.clientId, snapshot);
}

function assertCanReadGroupSnapshot(
    principalId: string,
    snapshot: GroupSnapshot,
): void {
    if (!canReadGroupSnapshot(principalId, snapshot)) {
        throw new Error('Forbidden: only active group members can read group state');
    }
}

function canReadGroupSnapshot(
    principalId: string,
    snapshot: GroupSnapshot,
): boolean {
    return snapshot.members.some(
        (member) =>
            member.principalId === principalId &&
            member.status === 'active',
    );
}

async function readStrictReadAuthSession(
    req: {
        header(name: string): string | undefined;
    },
    deps: Required<GroupStateRouteDependencies>,
): Promise<GroupStateRouteAuthSession | undefined> {
    return isStrictReadAuthEnabled()
        ? await deps.requireApiAuthSession(req)
        : undefined;
}

function isStrictReadAuthEnabled(): boolean {
    const value = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
    if (value === undefined || value.trim() === '') {
        return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function hydrateGroupSnapshots(
    deps: Required<GroupStateRouteDependencies>,
    groups: readonly GroupSnapshot[],
): void {
    if (groups.length === 0) {
        return;
    }

    void deps.hydrateStateSyncSnapshotCaches({ groups })
        .catch((error) =>
            console.warn('Failed to hydrate group state sync snapshot caches', error)
        );
}

async function processGroupAppInbox<V, R>(
    enqueue: AppInboxEnqueueInput<V>,
): Promise<R> {
    const result =
        await getMiddleware().appGroupInboxService.processEntryUntilCompletion<V, R>(
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

function unwrapGroupStateWritten(written: GroupStateWritten): GroupMutationWritten {
    const mutation = written.result.right;
    if (!mutation) {
        throw new Error(written.result.left ?? 'Client mutation failed');
    }

    return mutation;
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
    service: GroupStateRouteService,
): Promise<void> {
    const snapshot = await service.readSnapshot({
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
