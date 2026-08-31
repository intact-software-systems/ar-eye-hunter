// dprint-ignore
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import { WebRtcConnectionService } from '@shared/services/WebRtcConnectionService.ts';
import { createTestGroup } from '../create-test-group.ts';

describe('WebRtcGroupManager overlay roles', () => {
    afterEach(() => vi.restoreAllMocks());
    it('uses planned topology for RTT evidence and accepted topology for traffic dials', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const plannedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const rtc = createRtcService();
        const group = createGroupSnapshot();
        const overlayId = toScopedOverlayId(group.group);
        const manager = new WebRtcGroupManager(
            rtc,
            {
                groupCache,
                clientCache,
                plannedOverlayCache,
                acceptedOverlayCache
            },
            { maxPeerConnections: 10, overlayTransitionGraceMs: 0 }
        );
        for (const peerId of ['peer-accepted', 'peer-planned']) {
            clientCache.set(peerId, createClientInfo(peerId));
        }
        plannedOverlayCache.set(
            overlayId,
            createOverlayInfo(group, ['peer-planned'], 2)
        );
        acceptedOverlayCache.set(
            overlayId,
            createOverlayInfo(group, ['peer-accepted'], 1)
        );

        await manager.acceptGroupUpdate(group);

        expect(manager.rttReportingPeerIds({ degreeLimit: 1 })).toEqual(['peer-planned']);
        expect(manager.state().desiredPeerIds).toEqual(['peer-accepted']);
        expect(rtc.knownPeerIds()).toEqual(['peer-accepted']);
    });
});

function createRtcService(): WebRtcConnectionService {
    const service = new WebRtcConnectionService({ send: async () => undefined, connect: async () => undefined }, {
        sessionId: 'local',
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc'
    });
    service.onRtcPeerLifecycleDo('fixture-transport', {
        onCreated: (peer) => {
            vi.spyOn(peer.connection, 'connect').mockImplementation(() => undefined);
            vi.spyOn(peer.channel, 'connect').mockImplementation(() => undefined);
        },
        onDeleted: () => undefined
    });
    return service;
}

function createClientInfo(sessionId: string): ClientInfo {
    return {
        clientId: sessionId,
        sessionId,
        isOnline: true
    };
}

function createGroupSnapshot(): GroupSnapshot {
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
            createActiveSession('local'),
            createActiveSession('peer-accepted'),
            createActiveSession('peer-planned')
        ],
        memberCount: 3,
        onlineMemberCount: 3
    };
}

function createActiveSession(sessionId: string): GroupSnapshot['activeSessions'][number] {
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

function createOverlayInfo(
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
