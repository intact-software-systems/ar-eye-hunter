import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { toGroupMemberPolicy } from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import type {
    AuditStamp,
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import { createTestGroup } from '../create-test-group.ts';
import type { SimulatedNativeRtcPeerConnection } from './native-rtc-connection-fixture.ts';
import { createSimulatedRtcConnections } from './simulated-rtc-connection-service.ts';

export interface GroupSnapshotFixture {
    readonly groupId: string;
    readonly membershipVersion: number;
    readonly memberSessionIds: readonly string[];
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly maxConcurrentEdgeSetups?: number;
}

export interface RtcConnectionHarness {
    readonly service: WebRtcConnectionService;
    knownPeerIds(): string[];
    peerIdsWithNoReconnectableLanes(): string[];
    markReconnectable(peerId: string): boolean;
    nativePeer(peerId: string): SimulatedNativeRtcPeerConnection;
}

export async function acceptActiveLayoutGroup(
    manager: WebRtcGroupManager,
    acceptedOverlayCache: LatestRepository<string, OverlayInfo>,
    group: GroupSnapshot
): Promise<void> {
    acceptedOverlayCache.set(
        toScopedOverlayId(group.group),
        createOverlayInfo(
            group,
            group.activeSessions
                .map((session) => session.sessionId)
                .filter((sessionId) => sessionId !== manager.rtcQBox.input.sessionId),
            group.group.snapshotVersion
        )
    );
    await manager.acceptGroupUpdate(group);
}

export function createRtcConnectionHarness(
    sessionId: string,
    initiallyConnectedPeerIds: readonly string[] = [],
    connect?: (peerId: string) => boolean
): RtcConnectionHarness {
    const simulation = createSimulatedRtcConnections(sessionId, connect);
    const { service } = simulation;
    for (const peerId of initiallyConnectedPeerIds) {
        const result = service.ensurePeerConnectionStarted(peerId);
        if (result.left) {
            throw new Error(`Failed to seed simulated peer ${peerId}`);
        }
    }
    return {
        service,
        knownPeerIds: () => [...service.knownPeerIds()],
        peerIdsWithNoReconnectableLanes: () => [...service.peerIdsWithNoReconnectableLanes()],
        markReconnectable: simulation.markReconnectable,
        nativePeer: simulation.nativePeer
    };
}

export function createClientInfo(sessionId: string, isOnline: boolean): ClientInfo {
    return {
        clientId: sessionId,
        sessionId,
        isOnline
    };
}

export function createGroupSnapshot(fixture: GroupSnapshotFixture): GroupSnapshot {
    const applicationId = fixture.applicationId ?? 'app-1';
    const workspaceId = fixture.workspaceId ?? 'workspace-1';
    const ownerPrincipalId = fixture.memberSessionIds[0];
    if (ownerPrincipalId === undefined) {
        throw new Error('Group fixture requires an owner session');
    }

    const group = createTestGroup({
        applicationId,
        workspaceId,
        groupId: fixture.groupId,
        slug: fixture.groupId,
        displayName: fixture.groupId,
        activeMemberCount: fixture.memberSessionIds.length,
        ownerPrincipalId,
        snapshotVersion: fixture.membershipVersion,
        metadataVersion: 0,
        rosterVersion: fixture.membershipVersion,
        presenceVersion: fixture.membershipVersion,
        formationElectorate: [...fixture.memberSessionIds],
        ...(fixture.maxConcurrentEdgeSetups === undefined
            ? {}
            : {
                memberPolicy: {
                    ...toGroupMemberPolicy(createDefaultGroupLifecyclePolicy()),
                    maxConcurrentEdgeSetups: fixture.maxConcurrentEdgeSetups
                }
            }),
        acceptedLayoutIdentity: {
            groupRevision: fixture.membershipVersion,
            presenceRevision: fixture.membershipVersion,
            version: fixture.membershipVersion,
            state: 'active'
        },
        created: createAuditStamp(1, ownerPrincipalId),
        updated: createAuditStamp(fixture.membershipVersion, ownerPrincipalId)
    });
    return {
        causalRevision: {
            groupRevision: fixture.membershipVersion,
            presenceRevision: fixture.membershipVersion
        },
        group,
        members: fixture.memberSessionIds.map((sessionId) => createGroupMember(group, sessionId)),
        activeSessions: fixture.memberSessionIds.map((sessionId) => createGroupPresenceSession(group, sessionId)),
        memberCount: fixture.memberSessionIds.length,
        onlineMemberCount: fixture.memberSessionIds.length
    };
}

export function createOverlayInfo(
    group: GroupSnapshot,
    nextHopSessionIds: readonly string[],
    overlayVersion = 1
): OverlayInfo {
    return {
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree',
        sourceGroupStateCausalRevision: group.causalRevision,
        state: 'active',
        name: group.group.displayName,
        createdByClientId: group.group.ownerPrincipalId,
        createdAtEpochMs: group.group.created.atEpochMs,
        nextHopSessionIds,
        degreeLimit: Math.max(1, nextHopSessionIds.length),
        overlayVersion,
        updatedAtEpochMs: overlayVersion,
        provenance: 'server'
    };
}

function createGroupMember(group: Group, sessionId: string): GroupMember {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        principalId: sessionId,
        role: sessionId === group.ownerPrincipalId ? 'owner' : 'member',
        status: 'active',
        joined: group.created,
        updated: group.updated,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    };
}

function createGroupPresenceSession(group: Group, sessionId: string): GroupPresenceSession {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: group.rosterVersion,
        status: 'active',
        connectedAtEpochMs: group.rosterVersion,
        lastHeartbeatAtEpochMs: group.rosterVersion,
        expiresAtEpochMs: group.rosterVersion + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}
