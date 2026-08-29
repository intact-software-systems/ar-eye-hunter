import type { ClientInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
// dprint-ignore
import type {
    AuditStamp,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
// dprint-ignore
import {
    configureOverlayRepositories,
    readableAcceptedOverlayCache,
    readablePlannedOverlayCache
} from '@shared/repository/overlays-repository.ts';
import { Either } from '@shared/resilience/Either.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';
import { vi } from 'vitest';
import { createTestGroup } from '../create-test-group.ts';

export interface SimulatedClient {
    readonly sessionId: string;
    readonly repositoryManager: RepositoryManager;
    readonly manager: WebRtcGroupManager;
    readonly connectedPeerIds: () => ReadonlySet<string>;
}

export interface CreateSimulatedClientOptions {
    readonly maxPeerConnections: number;
    readonly overlayTransitionGraceMs?: number;
    readonly now?: () => number;
}

export interface RingTopologyIdentity {
    readonly sourceGroupStateCausalRevision: GroupStateCausalRevision;
    readonly version: number;
    readonly degreeLimit: number;
    readonly ringShift?: number;
}

export function createSimulatedClient(
    sessionId: string,
    allSessionIds: readonly string[],
    options: CreateSimulatedClientOptions
): SimulatedClient {
    const repositoryManager = new RepositoryManager();
    configureOverlayRepositories(
        {
            plannedOverlays: { ttlMs: 60_000 },
            acceptedOverlays: { ttlMs: 60_000 }
        },
        repositoryManager
    );

    const groupCache = new LatestRepository<string, GroupSnapshot>();
    const clientCache = new LatestRepository<string, ClientInfo>();
    for (const peerSessionId of allSessionIds) {
        clientCache.set(peerSessionId, {
            clientId: peerSessionId,
            sessionId: peerSessionId,
            isOnline: true
        });
    }

    const knownPeerIds = new Set<string>();
    const rtcQBox = {
        input: { sessionId },
        knownPeerIds: () => Array.from(knownPeerIds),
        peerIdsWithNoReconnectableLanes: () => Array.from(knownPeerIds),
        ensurePeerConnectionStarted: vi.fn((peerId: string) => {
            knownPeerIds.add(peerId);
            return Either.ofRight({ peerId } as never);
        }),
        disconnectPeer: vi.fn((peerId: string) => {
            knownPeerIds.delete(peerId);
        })
    };

    const manager = new WebRtcGroupManager(
        rtcQBox as never,
        {
            groupCache,
            clientCache,
            plannedOverlayCache: readablePlannedOverlayCache(repositoryManager),
            acceptedOverlayCache: readableAcceptedOverlayCache(repositoryManager)
        },
        {
            maxPeerConnections: options.maxPeerConnections,
            ...(options.overlayTransitionGraceMs === undefined
                ? {}
                : { overlayTransitionGraceMs: options.overlayTransitionGraceMs }),
            ...(options.now === undefined ? {} : { now: options.now })
        }
    );

    return {
        sessionId,
        repositoryManager,
        manager,
        connectedPeerIds: () => knownPeerIds
    };
}

export function createRingTopologySnapshot(
    group: GroupSnapshot,
    sessionIds: readonly string[],
    identity: RingTopologyIdentity
): RallarOverlayTopologySnapshot {
    const shift = identity.ringShift ?? 1;
    const nextHopsBySessionId: Record<string, readonly string[]> = {};
    for (let index = 0; index < sessionIds.length; index++) {
        const previous = sessionIds[(index + sessionIds.length - shift) % sessionIds.length];
        const next = sessionIds[(index + shift) % sessionIds.length];
        nextHopsBySessionId[sessionIds[index]] = [...new Set([previous, next])].sort();
    }

    return {
        sourceGroupStateCausalRevision: identity.sourceGroupStateCausalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        name: 'simulated',
        topology: 'tree',
        activeSessionIds: sessionIds,
        nextHopsBySessionId,
        degreeLimit: identity.degreeLimit,
        version: identity.version,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1 + identity.version
    };
}

export function createSimulationGroupSnapshot(
    groupId: string,
    snapshotVersion: number,
    sessionIds: readonly string[]
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const ownerPrincipalId = sessionIds[0];

    return {
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created: simulationAuditStamp(1),
            updated: simulationAuditStamp(snapshotVersion),
            activeMemberCount: sessionIds.length,
            ownerPrincipalId
        }),
        members: sessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: simulationAuditStamp(1),
            updated: simulationAuditStamp(snapshotVersion),
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${snapshotVersion}`,
            generationVersion: snapshotVersion,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length
    };
}

export function simulationAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
