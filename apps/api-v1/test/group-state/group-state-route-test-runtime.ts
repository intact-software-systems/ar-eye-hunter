import { type GroupStateWritten } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { AuditStamp, GroupEvent, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import type {
    AuthenticatedGroupMutationEnqueue
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import type {
    GroupStateInboxDurableResult
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import type {
    GroupStateRouteAuthSession,
    GroupStateRouteDependencies,
    GroupStateRouteService,
    ProcessGroupAppInbox
} from '../../src/group-state/group-state-route-contracts.ts';
import { registerGroupStateRoutes } from '../../src/group-state/register-group-state-routes.ts';
import { createGroupAdmissionQuota, type GroupAdmissionQuota } from '../../src/services/group-admission-rate-limit.ts';

export const TEST_GROUP_SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

export interface GroupStateRouteTestRuntimeInput {
    readonly session?: AuthSession & GroupStateRouteAuthSession;
    readonly groupService?: Partial<GroupStateRouteService>;
    readonly requireApiAuthSession?: GroupStateRouteDependencies[
        'requireApiAuthSession'
    ];
    readonly processGroupAppInbox?: GroupStateRouteDependencies[
        'processGroupAppInbox'
    ];
    readonly groupAdmissionQuota?: GroupAdmissionQuota;
    readonly hydrateStateSyncSnapshotCaches?: GroupStateRouteDependencies[
        'hydrateStateSyncSnapshotCaches'
    ];
    readonly readGroupSnapshot?: GroupStateRouteDependencies['readGroupSnapshot'];
    readonly strictReadAuthorization?: boolean;
    readonly installStateAuthentication?: boolean;
}

export interface GroupStateRouteTestRuntime {
    readonly app: Hono;
    readonly session: AuthSession & GroupStateRouteAuthSession;
}

export interface GroupStateRoutePostRequestWithHeaders {
    readonly body: Record<string, unknown>;
    readonly headers: Readonly<Record<string, string>>;
}

export function createGroupStateRouteTestRuntime(
    input: GroupStateRouteTestRuntimeInput = {}
): GroupStateRouteTestRuntime {
    const session = input.session ?? createGroupStateRouteAuthSession('alice');
    const routeDependencies = createGroupStateRouteTestDependencies({ ...input, session });
    const app = new Hono();

    if (input.installStateAuthentication ?? true) {
        app.use('/api/state/*', async (context, next) => {
            await routeDependencies.requireApiAuthSession(context.req);
            await next();
        });
    }

    registerGroupStateRoutes(app, routeDependencies);
    return { app, session };
}

export function createRejectingGroupStateRouteTestRuntime(
    input: GroupStateRouteTestRuntimeInput = {}
): GroupStateRouteTestRuntime {
    const session = input.session ?? createLiveGroupStateRouteAuthSession('alice');
    const processGroupAppInbox = input.processGroupAppInbox ?? rejectUnexpectedGroupMutation;
    return createGroupStateRouteTestRuntime({ ...input, session, processGroupAppInbox });
}

export function createGroupStateRouteTestDependencies(
    input: GroupStateRouteTestRuntimeInput = {}
): GroupStateRouteDependencies {
    const session = input.session ?? createGroupStateRouteAuthSession('alice');
    const requireApiAuthSession = input.requireApiAuthSession ?? (() => Promise.resolve(session));
    return {
        groupStateService: createGroupStateRouteService(input.groupService),
        requireApiAuthSession,
        processGroupAppInbox: input.processGroupAppInbox ?? defaultProcessGroupAppInbox,
        groupAdmissionQuota: input.groupAdmissionQuota ?? createGroupAdmissionQuota({
            windowMs: 60_000,
            joinPrincipal: 60,
            joinGroup: 600,
            presencePrincipal: 120,
            presenceGroup: 1_200
        }),
        strictReadAuthorization: input.strictReadAuthorization ?? false,
        hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
            (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
        readGroupSnapshot: input.readGroupSnapshot ?? (async (ref) => {
            const readSnapshot = input.groupService?.readCurrentSnapshot ??
                input.groupService?.readSnapshot;
            const snapshot = await readSnapshot?.(ref);
            return snapshot
                ? { status: 'found', source: 'durable', snapshot }
                : { status: 'not-found', source: 'durable' };
        })
    };
}

export function createRejectingGroupStateRouteTestDependencies(
    input: GroupStateRouteTestRuntimeInput = {}
): GroupStateRouteDependencies {
    const session = input.session ?? createLiveGroupStateRouteAuthSession('alice');
    const processGroupAppInbox = input.processGroupAppInbox ?? rejectUnexpectedGroupMutation;
    return createGroupStateRouteTestDependencies({ ...input, session, processGroupAppInbox });
}

export function createGroupStateRouteAuthSession(
    clientId: string
): AuthSession & GroupStateRouteAuthSession {
    return {
        clientId,
        accessToken: 'test-token',
        username: clientId,
        sessionId: `${clientId}-session`,
        issuedAtEpochMs: 1,
        expiresAtEpochMs: 60_000
    };
}

export function createLiveGroupStateRouteAuthSession(
    clientId: string
): AuthSession & GroupStateRouteAuthSession {
    return {
        clientId,
        accessToken: 'token',
        username: clientId,
        sessionId: `${clientId}-session`,
        issuedAtEpochMs: Date.now() - 1_000,
        expiresAtEpochMs: Date.now() + 60_000
    };
}

export function createGroupStateRouteSnapshot(
    groupId: string,
    activePrincipalIds: readonly string[] = ['alice']
): GroupSnapshot {
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: createTestGroup({
            ...TEST_GROUP_SCOPE,
            groupId,
            displayName: groupId,
            activeMemberCount: activePrincipalIds.length,
            ownerPrincipalId: activePrincipalIds[0] ?? 'alice',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: testAuditStamp(1),
            updated: testAuditStamp(1)
        }),
        members: activePrincipalIds.map((principalId) => createGroupStateRouteMember(groupId, principalId)),
        activeSessions: [],
        memberCount: activePrincipalIds.length,
        onlineMemberCount: 0
    };
}

export function createOwnerGroupStateRouteSnapshot(
    groupId: string,
    activePrincipalIds: readonly string[] = ['alice']
): GroupSnapshot {
    const snapshot = createGroupStateRouteSnapshot(groupId, activePrincipalIds);
    const ownerPrincipalId = activePrincipalIds[0] ?? 'alice';
    return {
        ...snapshot,
        members: snapshot.members.map((member) => ({
            ...member,
            role: member.principalId === ownerPrincipalId ? 'owner' : 'member'
        }))
    };
}

export function createGroupStateRouteSnapshotWithMember(
    groupId: string,
    principalId: string,
    status: GroupMember['status']
): GroupSnapshot {
    const snapshot = createGroupStateRouteSnapshot(groupId, status === 'active' ? [principalId] : []);
    return {
        ...snapshot,
        members: [createGroupStateRouteMemberWithStatus(groupId, principalId, status)],
        memberCount: status === 'active' ? 1 : 0,
        onlineMemberCount: 0
    };
}

export function createDeletedGroupStateRouteSnapshot(
    groupId: string,
    principalId: string
): GroupSnapshot {
    const snapshot = createGroupStateRouteSnapshot(groupId, [principalId]);
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            status: 'deleted',
            archived: null,
            deleted: testAuditStamp(2)
        }
    };
}

export async function withStrictGroupStateRouteReadAuth(
    enabled: boolean,
    action: () => Promise<void>
): Promise<void> {
    const previous = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
    Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', enabled ? 'true' : 'false');
    try {
        await action();
    }
    finally {
        if (previous === undefined) {
            Deno.env.delete('RALLAR_STATE_STRICT_READ_AUTH');
        }
        else {
            Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', previous);
        }
    }
}

export function createGroupStateRouteEvent(eventId: string): GroupEvent {
    return {
        ...TEST_GROUP_SCOPE,
        groupId: 'room-1',
        eventId,
        eventType: 'group-updated',
        snapshotVersion: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        occurredAtEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

export function toGroupStateWritten(snapshot: GroupSnapshot): GroupStateWritten {
    return {
        status: 'ok',
        result: { snapshot, event: null }
    };
}

export function captureGroupStateRouteWrite(
    enqueued: AuthenticatedGroupMutationEnqueue[],
    snapshot: GroupSnapshot
): ProcessGroupAppInbox {
    return (_authority, entry) => {
        enqueued.push(entry);
        return Promise.resolve(toGroupStateRouteDurableResult(entry, snapshot));
    };
}

export async function postGroupStateMutation(
    app: Hono,
    path: string,
    body: Record<string, unknown>
): Promise<Response> {
    const mutation = toGroupStateRouteMutationRequest(path, body);
    return await app.request(mutation.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mutation.body)
    });
}

export async function putGroupStateMutation(
    app: Hono,
    path: string,
    body: Record<string, unknown>
): Promise<Response> {
    const mutation = toGroupStateRouteMutationRequest(path, body);
    return await app.request(mutation.path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mutation.body)
    });
}

export async function postGroupStateMutationWithHeaders(
    app: Hono,
    path: string,
    request: GroupStateRoutePostRequestWithHeaders
): Promise<Response> {
    const mutation = toGroupStateRouteMutationRequest(path, request.body);
    return await app.request(mutation.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...request.headers },
        body: JSON.stringify(mutation.body)
    });
}

interface GroupStateRouteMutationRequest<Body extends object> {
    readonly path: string;
    readonly body: Omit<Body, 'requestId'>;
}

function toGroupStateRouteMutationRequest<Body extends object>(
    path: string,
    body: Body
): GroupStateRouteMutationRequest<Body> {
    const candidate = Reflect.get(body, 'requestId');
    const mutationBody = { ...body };
    Reflect.deleteProperty(mutationBody, 'requestId');
    const requestId = typeof candidate === 'string' ? candidate : 'group-route-default-request';
    return {
        path: `${path}/requests/${encodeURIComponent(requestId)}`,
        body: mutationBody as Omit<Body, 'requestId'>
    };
}

function createGroupStateRouteService(
    groupService: Partial<GroupStateRouteService> | undefined
): GroupStateRouteService {
    const readSnapshot = groupService?.readSnapshot ?? (() => Promise.resolve(undefined));
    return {
        listSnapshots: groupService?.listSnapshots ?? (() => Promise.resolve([])),
        readSnapshot,
        readCurrentSnapshot: groupService?.readCurrentSnapshot ?? readSnapshot,
        listEvents: groupService?.listEvents ?? (() => Promise.resolve([])),
        listRecentEvents: groupService?.listRecentEvents ?? (() => Promise.resolve([])),
        listEventPage: groupService?.listEventPage ??
            (() => Promise.resolve({ events: [], hasMore: false }))
    };
}

const defaultProcessGroupAppInbox: ProcessGroupAppInbox = (_authority, entry) =>
    Promise.resolve(
        toGroupStateRouteDurableResult(entry, createGroupStateRouteSnapshot('room-1'))
    );

const rejectUnexpectedGroupMutation: ProcessGroupAppInbox = () =>
    Promise.reject(new Error('Unexpected group mutation'));

function toGroupStateRouteDurableResult(
    entry: AuthenticatedGroupMutationEnqueue,
    snapshot: GroupSnapshot
): GroupStateInboxDurableResult {
    if (entry.type === AppInboxType.GROUP_JOIN_CODE_ROTATE) {
        return {
            status: 'ok',
            result: {
                joinCode: entry.data.request.joinCode ?? 'test-join-code',
                expiresAtEpochMs: entry.data.request.expiresAtEpochMs ?? 1,
                snapshot,
                event: null
            }
        };
    }
    if (
        entry.type === AppInboxType.GROUP_PRESENCE_CONNECT ||
        entry.type === AppInboxType.GROUP_PRESENCE_HEARTBEAT ||
        entry.type === AppInboxType.GROUP_PRESENCE_DISCONNECT
    ) {
        const commandId = entry.resourceId ?? 'test-presence-command';
        return {
            commandId,
            requestId: commandId,
            commandHash: 'test-command-hash',
            aggregateRef: {
                ...entry.data.scope,
                groupId: entry.data.groupId
            },
            outcome: 'applied',
            attemptCount: 1,
            acceptedStorageRevision: 1,
            snapshotVersion: snapshot.group.snapshotVersion,
            causalRevision: snapshot.causalRevision,
            eventId: null,
            outboxIds: [],
            joinCode: null,
            joinCodeExpiresAtEpochMs: null,
            rejection: null
        };
    }
    return toGroupStateWritten(snapshot);
}

function createGroupStateRouteMember(groupId: string, principalId: string): GroupMember {
    return {
        ...TEST_GROUP_SCOPE,
        groupId,
        principalId,
        role: principalId === 'alice' ? 'owner' : 'member',
        status: 'active',
        joined: testAuditStamp(1),
        updated: testAuditStamp(1),
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
}

function createGroupStateRouteMemberWithStatus(
    groupId: string,
    principalId: string,
    status: GroupMember['status']
): GroupMember {
    const auditStamp = testAuditStamp(1);
    const base = {
        ...TEST_GROUP_SCOPE,
        groupId,
        principalId,
        role: 'member',
        updated: auditStamp,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    } as const;
    switch (status) {
        case 'invited':
        case 'pending':
            return {
                ...base,
                status,
                joined: null,
                left: null,
                removed: null,
                banned: null
            };
        case 'active':
            return {
                ...base,
                status,
                joined: auditStamp,
                left: null,
                removed: null,
                banned: null
            };
        case 'left':
            return {
                ...base,
                status,
                joined: auditStamp,
                left: auditStamp,
                removed: null,
                banned: null
            };
        case 'removed':
            return {
                ...base,
                status,
                joined: auditStamp,
                left: null,
                removed: auditStamp,
                banned: null
            };
        case 'banned':
            return {
                ...base,
                status,
                joined: auditStamp,
                left: null,
                removed: null,
                banned: auditStamp
            };
    }
}

function testAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
