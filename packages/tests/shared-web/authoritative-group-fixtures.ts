import type {
    AuditStamp,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';

export function createAuditStampFixture(
    atEpochMs: number,
    principalId: string,
): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null,
    };
}

export function createActiveGroupMemberFixture(input: Readonly<{
    applicationId: string;
    workspaceId: string;
    groupId: string;
    principalId: string;
    role: GroupMember['role'];
    actorPrincipalId: string;
}>): GroupMember {
    return {
        applicationId: input.applicationId,
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        principalId: input.principalId,
        role: input.role,
        status: 'active',
        joined: createAuditStampFixture(1, input.actorPrincipalId),
        updated: createAuditStampFixture(1, input.actorPrincipalId),
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
    };
}

export function createActiveGroupPresenceSessionFixture(input: Readonly<{
    applicationId: string;
    workspaceId: string;
    groupId: string;
    principalId: string;
    sessionId: string;
}>): GroupPresenceSession {
    return {
        applicationId: input.applicationId,
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        generationId: `generation-${input.sessionId}`,
        generationVersion: 1,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    };
}

export function createGroupSnapshotFixture(input: Readonly<{
    applicationId: string;
    workspaceId: string;
    groupId: string;
    sessionIds: readonly string[];
}>): GroupSnapshot {
    const ownerPrincipalId = input.sessionIds.length === 0
        ? 'creator'
        : input.sessionIds[0];
    const memberPrincipalIds = input.sessionIds.length === 0
        ? [ownerPrincipalId]
        : input.sessionIds;
    return {
        stateRevision: 1 + input.sessionIds.length,
        causalRevision: {
            groupRevision: 1,
            presenceRevision: input.sessionIds.length,
        },
        group: {
            applicationId: input.applicationId,
            workspaceId: input.workspaceId,
            groupId: input.groupId,
            slug: null,
            displayName: input.groupId,
            description: null,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            activeMemberCount: memberPrincipalIds.length,
            ownerPrincipalId,
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: input.sessionIds.length,
            created: createAuditStampFixture(1, 'creator'),
            updated: createAuditStampFixture(1, 'creator'),
            archived: null,
            deleted: null,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
        },
        members: memberPrincipalIds.map((principalId) =>
            createActiveGroupMemberFixture({
                applicationId: input.applicationId,
                workspaceId: input.workspaceId,
                groupId: input.groupId,
                principalId,
                role: principalId === ownerPrincipalId ? 'owner' : 'member',
                actorPrincipalId: 'creator',
            })
        ),
        activeSessions: input.sessionIds.map((sessionId) =>
            createActiveGroupPresenceSessionFixture({
                applicationId: input.applicationId,
                workspaceId: input.workspaceId,
                groupId: input.groupId,
                principalId: sessionId,
                sessionId,
            })
        ),
        memberCount: memberPrincipalIds.length,
        onlineMemberCount: input.sessionIds.length,
    };
}

export function createClientSnapshotFixture(input: Readonly<{
    applicationId: string;
    workspaceId: string;
    principalId: string;
}>): ClientSnapshot {
    return {
        stateRevision: 1,
        principal: {
            applicationId: input.applicationId,
            workspaceId: input.workspaceId,
            principalId: input.principalId,
            username: input.principalId,
            displayName: null,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: createAuditStampFixture(1, input.principalId),
            updated: createAuditStampFixture(1, input.principalId),
            disabled: null,
            deleted: null,
            lastSeenAtEpochMs: 1,
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
        lastSeenAtEpochMs: 1,
    };
}

export function createActiveClientSessionFixture(input: Readonly<{
    applicationId: string;
    workspaceId: string;
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
}>): ClientSession {
    return {
        applicationId: input.applicationId,
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        clientInstanceId: input.clientInstanceId,
        sessionId: input.sessionId,
        generationId: `generation-${input.sessionId}`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    };
}
