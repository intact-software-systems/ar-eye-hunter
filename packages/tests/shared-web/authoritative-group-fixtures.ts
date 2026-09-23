import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { ClientInstance, ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '../create-test-group.ts';

export function createAuditStampFixture(
    atEpochMs: number,
    principalId: string
): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}

export function createActiveGroupMemberFixture(
    input: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId: string;
        principalId: string;
        role: GroupMember['role'];
        actorPrincipalId: string;
    }>
): GroupMember {
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
        invitationExpiresAtEpochMs: null
    };
}

export function createActiveGroupPresenceSessionFixture(
    input: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId: string;
        principalId: string;
        sessionId: string;
    }>
): GroupPresenceSession {
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
        disconnectReason: null
    };
}

export function createGroupSnapshotFixture(
    input: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId: string;
        sessionIds: readonly string[];
    }>
): GroupSnapshot {
    const ownerPrincipalId = input.sessionIds.length === 0
        ? 'creator'
        : input.sessionIds[0];
    const memberPrincipalIds = input.sessionIds.length === 0
        ? [ownerPrincipalId]
        : input.sessionIds;
    return {
        causalRevision: {
            groupRevision: 1,
            presenceRevision: input.sessionIds.length
        },
        group: createTestGroup({
            applicationId: input.applicationId,
            workspaceId: input.workspaceId,
            groupId: input.groupId,
            displayName: input.groupId,
            activeMemberCount: memberPrincipalIds.length,
            ownerPrincipalId,
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: input.sessionIds.length,
            created: createAuditStampFixture(1, 'creator'),
            updated: createAuditStampFixture(1, 'creator')
        }),
        members: memberPrincipalIds.map((principalId) =>
            createActiveGroupMemberFixture({
                applicationId: input.applicationId,
                workspaceId: input.workspaceId,
                groupId: input.groupId,
                principalId,
                role: principalId === ownerPrincipalId ? 'owner' : 'member',
                actorPrincipalId: 'creator'
            })
        ),
        activeSessions: input.sessionIds.map((sessionId) =>
            createActiveGroupPresenceSessionFixture({
                applicationId: input.applicationId,
                workspaceId: input.workspaceId,
                groupId: input.groupId,
                principalId: sessionId,
                sessionId
            })
        ),
        memberCount: memberPrincipalIds.length,
        onlineMemberCount: input.sessionIds.length
    };
}

/** A group in `group-1` whose sessions are live now and whose layout the server has accepted. */
export function createAcceptedGroupSnapshotFixture(sessionIds: readonly string[]): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        sessionIds
    });
    const nowMs = Date.now();
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({
            ...session,
            lastHeartbeatAtEpochMs: nowMs,
            expiresAtEpochMs: nowMs + 60_000
        })),
        group: {
            ...snapshot.group,
            formationElectorate: snapshot.members.map((member) => member.principalId),
            acceptedLayoutIdentity: {
                groupRevision: snapshot.causalRevision.groupRevision,
                presenceRevision: snapshot.causalRevision.presenceRevision,
                version: 1,
                state: 'active'
            }
        }
    };
}

export function createAcceptedOverlayFixture(
    group: GroupSnapshot,
    version: number,
    nextHopSessionIds: readonly string[]
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: group.causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree',
        name: group.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: [...nextHopSessionIds],
        degreeLimit: 5,
        overlayVersion: version,
        updatedAtEpochMs: version
    };
}

export function createClientSnapshotFixture(
    input: Readonly<{
        applicationId: string;
        workspaceId: string;
        principalId: string;
    }>
): ClientSnapshot {
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
            lastSeenAtEpochMs: 1
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
        lastSeenAtEpochMs: 1
    };
}

export function createActiveClientInstanceFixture(
    input: Readonly<{
        applicationId: string;
        workspaceId: string;
        principalId: string;
        clientInstanceId: string;
    }>
): ClientInstance {
    const audit = createAuditStampFixture(1, input.principalId);
    return {
        applicationId: input.applicationId,
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        clientInstanceId: input.clientInstanceId,
        status: 'active',
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        registered: audit,
        updated: audit,
        revoked: null
    };
}

export function createActiveClientSessionFixture(
    input: Readonly<{
        applicationId: string;
        workspaceId: string;
        principalId: string;
        clientInstanceId: string;
        sessionId: string;
    }>
): ClientSession {
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
        disconnectReason: null
    };
}
