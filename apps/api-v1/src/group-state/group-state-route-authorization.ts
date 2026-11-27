import { availableGuestSnapshot } from '@shared-server/http/available-guest-snapshot.ts';
import { authorizationDenied } from '@shared-server/http/request-auth-service.ts';
import { readRoomGuestSession } from '@shared-server/http/room-guest-request.ts';
import { canUpdateGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-governance-policy.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import {
    canReadGroupSnapshot,
    isGroupDirectoryVisible
} from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { UpdateGroupRequest, UpsertGroupMemberRequest } from '@shared/api/state-types.ts';

import type {
    GroupStateRouteAuthSession,
    GroupStateRouteDependencies,
    GroupStateRouteRequest,
    GroupStateRouteService
} from './group-state-route-contracts.ts';

interface RequireRoomParticipantSessionInput {
    readonly request: GroupStateRouteRequest;
    readonly roomRef: GroupRef;
    readonly dependencies: GroupStateRouteDependencies;
    readonly guestScope?: 'temporary-room';
}

export async function requireRoomParticipantSession(
    { request, roomRef, dependencies, guestScope }: RequireRoomParticipantSessionInput
): Promise<GroupStateRouteAuthSession> {
    const guest = await readRoomGuestSession({
        request,
        readSnapshot: async (room) => {
            const result = await dependencies.readGroupSnapshot(room, { strictMode: true });
            return result.status === 'found' ? await availableGuestSnapshot(result.snapshot, dependencies.nowEpochMs(), dependencies.isTemporaryGroupAvailable) : undefined;
        },
        nowEpochMs: dependencies.nowEpochMs,
        temporaryRoomOnly: guestScope === 'temporary-room',
        roomRef
    });
    return guest ?? await dependencies.requireApiAuthSession(request);
}

export interface GroupStateRouteAuthorization {
    readStrictAuthSession(
        request: GroupStateRouteRequest
    ): Promise<GroupStateRouteAuthSession | undefined>;
    assertCanReadGroupRef(
        request: GroupStateRouteRequest,
        ref: GroupRef
    ): Promise<void>;
    assertCanReadGroupState(
        request: GroupStateRouteRequest,
        snapshot: GroupSnapshot
    ): Promise<void>;
    assertAuthenticatedCanReadGroupState(
        session: GroupStateRouteAuthSession | undefined,
        snapshot: GroupSnapshot
    ): void;
    assertCanUpdateGroup(principalId: string, ref: GroupRef, request: UpdateGroupRequest): Promise<void>;
    assertSelfPrincipal(clientId: string, principalId: string): void;
    assertSelfSession(
        session: GroupStateRouteAuthSession,
        sessionId: string
    ): void;
    assertSelfServiceMemberStatus(
        status: UpsertGroupMemberRequest['status']
    ): void;
}

interface GroupStateRouteAuthorizationDependencies {
    readonly groupStateService: Pick<GroupStateRouteService, 'readCurrentSnapshot'>;
    readonly requireApiAuthSession: GroupStateRouteDependencies['requireApiAuthSession'];
    readonly strictReadAuthorization: boolean;
}

export function isGroupStateRouteSnapshotReadable(
    snapshot: GroupSnapshot,
    principalId: string
): boolean {
    return canReadGroupSnapshot({
        snapshot,
        actor: { principalId }
    }).allowed;
}

export function isGroupStateRouteSnapshotDirectoryListed(
    snapshot: GroupSnapshot,
    principalId: string | undefined,
    nowEpochMs: number
): boolean {
    return isGroupDirectoryVisible({ snapshot, actor: { principalId }, nowEpochMs });
}

export function createGroupStateRouteAuthorization(
    dependencies: GroupStateRouteAuthorizationDependencies
): GroupStateRouteAuthorization {
    return {
        readStrictAuthSession: (request) => readStrictAuthSession(request, dependencies),
        assertCanReadGroupRef: (request, ref) => assertCanReadGroupRef(request, ref, dependencies),
        assertCanReadGroupState: (request, snapshot) => assertCanReadGroupState(request, snapshot, dependencies),
        assertAuthenticatedCanReadGroupState: (session, snapshot) => {
            if (session) {
                assertCanReadGroupSnapshot(session.clientId, snapshot);
            }
        },
        async assertCanUpdateGroup(principalId, ref, request) {
            // The AppInbox checks seat eligibility and director authority against the revision it writes.
            const lobbyOperation = request.roomLobby?.operation;
            if (
                lobbyOperation !== 'release' && lobbyOperation !== 'wait' && request.roomClock === undefined &&
                request.roomDeadline?.expectedDirectorEpoch === undefined
            ) {
                await assertCanUpdateGroup(principalId, ref, dependencies);
            }
        },
        assertSelfPrincipal,
        assertSelfSession,
        assertSelfServiceMemberStatus
    };
}

async function assertCanReadGroupRef(
    request: GroupStateRouteRequest,
    ref: GroupRef,
    dependencies: GroupStateRouteAuthorizationDependencies
): Promise<void> {
    const authSession = await readStrictAuthSession(request, dependencies);
    if (!authSession) {
        return;
    }

    const snapshot = await dependencies.groupStateService.readCurrentSnapshot(ref);
    if (!snapshot) {
        throw new Error(`Group not found: ${ref.groupId}`);
    }

    assertCanReadGroupSnapshot(authSession.clientId, snapshot);
}

async function assertCanReadGroupState(
    request: GroupStateRouteRequest,
    snapshot: GroupSnapshot,
    dependencies: GroupStateRouteAuthorizationDependencies
): Promise<void> {
    const authSession = await readStrictAuthSession(request, dependencies);
    if (!authSession) {
        return;
    }

    assertCanReadGroupSnapshot(authSession.clientId, snapshot);
}

function assertCanReadGroupSnapshot(principalId: string, snapshot: GroupSnapshot): void {
    const result = canReadGroupSnapshot({
        snapshot,
        actor: { principalId }
    });
    if (!result.allowed) {
        throw new GroupPolicyDeniedError(result);
    }
}

async function assertCanUpdateGroup(
    principalId: string,
    ref: GroupRef,
    dependencies: GroupStateRouteAuthorizationDependencies
): Promise<void> {
    const snapshot = await dependencies.groupStateService.readCurrentSnapshot(ref);
    if (!snapshot) {
        throw new Error(`Group not found: ${ref.groupId}`);
    }

    const result = canUpdateGroupSnapshot({
        snapshot,
        actor: { principalId }
    });
    if (result.allowed) {
        return;
    }

    if (result.code === 'member-not-active') {
        throw authorizationDenied('Forbidden: only active group owners/admins can update groups');
    }

    if (result.code === 'forbidden-role') {
        throw authorizationDenied('Forbidden: only group owners/admins can update groups');
    }

    throw new GroupPolicyDeniedError(result);
}

function assertSelfPrincipal(clientId: string, principalId: string): void {
    if (clientId !== principalId) {
        throw authorizationDenied('Forbidden: principal id does not match authenticated client');
    }
}

function assertSelfSession(
    session: GroupStateRouteAuthSession,
    sessionId: string
): void {
    if (session.sessionId !== sessionId) {
        throw authorizationDenied('Forbidden: session id does not match authenticated session');
    }
}

function assertSelfServiceMemberStatus(
    status: UpsertGroupMemberRequest['status']
): void {
    if (status !== 'active' && status !== 'left') {
        throw authorizationDenied(
            'Forbidden: self-service membership changes only support active/left'
        );
    }
}

async function readStrictAuthSession(
    request: GroupStateRouteRequest,
    dependencies: GroupStateRouteAuthorizationDependencies
): Promise<GroupStateRouteAuthSession | undefined> {
    return dependencies.strictReadAuthorization
        ? await dependencies.requireApiAuthSession(request)
        : undefined;
}
