import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { toGroupMemberPolicy } from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import type {
    AuditStamp,
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot
} from '@shared/api/group-types.ts';

export interface CreateRtcGroupCoordinationSnapshotInput {
    readonly groupId: string;
    readonly membershipVersion: number;
    readonly memberSessionIds: readonly string[];
    readonly presenceVersion: number;
    readonly formationElectorate: readonly string[];
    readonly acceptedLayoutIdentity: GroupLayoutIdentity | null;
    readonly ownerSessionId: string | undefined;
    readonly connectedAtEpochMs: number;
}

export function createRtcGroupCoordinationSnapshot(
    input: CreateRtcGroupCoordinationSnapshotInput
): GroupSnapshot {
    return {
        causalRevision: {
            groupRevision: input.membershipVersion,
            presenceRevision: input.membershipVersion
        },
        group: createGroup(input),
        members: createMembers(input),
        activeSessions: createSessions(input),
        memberCount: input.memberSessionIds.length,
        onlineMemberCount: input.memberSessionIds.length
    };
}

function createGroup(input: CreateRtcGroupCoordinationSnapshotInput): Group {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: input.groupId,
        slug: input.groupId,
        displayName: input.groupId,
        description: null,
        kind: 'room',
        status: 'active',
        archived: null,
        deleted: null,
        joinMode: 'open',
        maxMembers: null,
        maxSessionsPerMember: null,
        metadata: {},
        activeMemberCount: input.memberSessionIds.length,
        ownerPrincipalId: input.memberSessionIds[0] ?? 'creator',
        snapshotVersion: input.membershipVersion,
        metadataVersion: 0,
        rosterVersion: input.membershipVersion,
        presenceVersion: input.presenceVersion,
        created: createCreatorAuditStamp(1),
        updated: createCreatorAuditStamp(input.membershipVersion),
        expiresAtEpochMs: null,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: null,
        lifecycleState: 'active',
        formationEpoch: 0,
        formationAttemptCount: 0,
        lastFormationOutcome: null,
        establishmentStartedAtEpochMs: null,
        formationElectorate: [...input.formationElectorate],
        acceptedLayoutIdentity: input.acceptedLayoutIdentity === null ? null : { ...input.acceptedLayoutIdentity },
        transportState: 'flowing',
        memberPolicy: toGroupMemberPolicy(createDefaultGroupLifecyclePolicy()),
        activationStatus: null
    };
}

function createMembers(input: CreateRtcGroupCoordinationSnapshotInput): readonly GroupMember[] {
    return input.memberSessionIds.map((sessionId): GroupMember => ({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: input.groupId,
        principalId: sessionId,
        role: sessionId === input.ownerSessionId ? 'owner' : 'member',
        status: 'active',
        joined: createCreatorAuditStamp(1),
        updated: createCreatorAuditStamp(input.membershipVersion),
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    }));
}

function createSessions(input: CreateRtcGroupCoordinationSnapshotInput): readonly GroupPresenceSession[] {
    return input.memberSessionIds.map((sessionId): GroupPresenceSession => ({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: input.groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: input.membershipVersion,
        status: 'active',
        connectedAtEpochMs: input.connectedAtEpochMs,
        lastHeartbeatAtEpochMs: input.membershipVersion,
        expiresAtEpochMs: input.membershipVersion + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
}

function createCreatorAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId: 'creator' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
