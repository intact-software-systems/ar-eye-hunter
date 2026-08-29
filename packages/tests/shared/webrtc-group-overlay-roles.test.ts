import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { Either } from '@shared/resilience/Either.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';
import { describe, expect, it, vi } from 'vitest';

import { createTestGroup } from '../create-test-group.ts';

describe('WebRtcGroupManager overlay roles', () => {
    it('uses planned topology for RTT evidence and accepted topology for traffic dials', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const plannedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const rtc = createRtcHarness();
        const group = groupSnapshot();
        const overlayId = toScopedOverlayId(group.group);
        const manager = new WebRtcGroupManager(
            rtc.service as never,
            {
                groupCache,
                clientCache,
                plannedOverlayCache,
                acceptedOverlayCache
            },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        for (const peerId of ['peer-accepted', 'peer-planned']) {
            clientCache.set(peerId, client(peerId));
        }
        plannedOverlayCache.set(
            overlayId,
            overlay(group, ['peer-planned'], 2)
        );
        acceptedOverlayCache.set(
            overlayId,
            overlay(group, ['peer-accepted'], 1)
        );

        await manager.acceptGroupUpdate(group);

        expect(manager.rttReportingPeerIds({ degreeLimit: 1 })).toEqual(['peer-planned']);
        expect(manager.state().desiredPeerIds).toEqual(['peer-accepted']);
        expect(rtc.ensurePeerConnectionStarted).toHaveBeenCalledWith('peer-accepted');
        expect(rtc.ensurePeerConnectionStarted).not.toHaveBeenCalledWith('peer-planned');
    });
});

function createRtcHarness() {
    const peers = new Set<string>();
    const ensurePeerConnectionStarted = vi.fn((peerId: string) => {
        peers.add(peerId);
        return Either.ofRight({ peerId } as never);
    });
    return {
        ensurePeerConnectionStarted,
        service: {
            input: { sessionId: 'self' },
            ensurePeerConnectionStarted,
            knownPeerIds: () => [...peers],
            peerIdsWithNoReconnectableLanes: () => [] as string[],
            disconnectPeer: vi.fn((peerId: string) => {
                peers.delete(peerId);
            })
        }
    };
}

function client(sessionId: string): ClientInfo {
    return {
        clientId: sessionId,
        sessionId,
        isOnline: true
    };
}

function groupSnapshot(): GroupSnapshot {
    const group = createTestGroup({
        groupId: 'group-1',
        snapshotVersion: 1,
        rosterVersion: 1,
        presenceVersion: 1
    });
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group,
        members: [],
        activeSessions: [
            activeSession('self'),
            activeSession('peer-accepted'),
            activeSession('peer-planned')
        ],
        memberCount: 3,
        onlineMemberCount: 3
    };
}

function activeSession(sessionId: string): GroupSnapshot['activeSessions'][number] {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        principalId: sessionId,
        sessionId,
        generationId: 'generation-1',
        generationVersion: 1,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function overlay(
    group: GroupSnapshot,
    nextHopSessionIds: readonly string[],
    overlayVersion: number
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: overlayVersion,
            presenceRevision: overlayVersion
        },
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree',
        name: group.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: [...nextHopSessionIds],
        degreeLimit: 1,
        overlayVersion,
        updatedAtEpochMs: overlayVersion
    };
}
