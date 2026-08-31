import '../../setup-browser-indexeddb.ts';

import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { WebRtcConnectionService } from '@shared/services/WebRtcConnectionService.ts';

import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toResilienceDto } from '@shared-web/browser/resilience-config.ts';
import { initialiseRtcOverlayMulticastManager } from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { setAcceptedOverlayById, setPlannedOverlayById } from '@shared/repository/overlays-repository.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
// dprint-ignore
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

describe('browser RTC runtime composition', () => {
    afterEach(() => vi.restoreAllMocks());
    beforeEach(() => {
        configureTestCacheRepositories();
        configureBrowserALRuntimeStores('self');
    });

    it('routes multicast traffic through accepted rather than conflicting planned next hops', async () => {
        const group = createGroupSnapshotFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            sessionIds: ['self', 'accepted-peer', 'planned-peer']
        });
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const overlayId = toScopedOverlayId(group.group);
        setPlannedOverlayById(
            overlayId,
            overlay(group, 2, ['planned-peer'])
        );
        setAcceptedOverlayById(
            overlayId,
            overlay(group, 1, ['accepted-peer'])
        );
        const sentByPeerId = new Map<string, ALMessage[]>();
        const connectionService = createRtcConnectionService(sentByPeerId);
        for (const peerId of ['accepted-peer', 'planned-peer']) {
            const connected = connectionService.ensurePeerConnectionStarted(peerId);
            expect(connected.right?.peerId).toBe(peerId);
        }
        const manager = initialiseRtcOverlayMulticastManager({
            webRtcConnectionService: connectionService,
            qboxEngine: new InboxOutboxEngine(),
            resilience: toResilienceDto()
        });

        const result = await manager.enqueueIfAbsent(
            newALMulticastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'message-1',
                    contextId: group.group.groupId
                },
                group.group,
                'chat.message.v1',
                { text: 'accepted traffic only' },
                {
                    qos: {
                        durability: { algo: 'volatile' }
                    }
                }
            )
        );

        expect(result).toMatchObject({ status: 'sent-immediate', entries: [] });
        expect(sentByPeerId.get('accepted-peer')).toHaveLength(1);
        expect(sentByPeerId.get('planned-peer')).toEqual([]);
        const sent = sentByPeerId.get('accepted-peer')?.[0];
        expect(sent?.forwarding?.overlayId).toBe(overlayId);
        expect(sent?.forwarding?.nextHopPeerIds).toEqual(['accepted-peer']);
    });
});

function createRtcConnectionService(sentByPeerId: Map<string, ALMessage[]>): WebRtcConnectionService {
    const service = new WebRtcConnectionService({ send: async () => undefined, connect: async () => undefined }, {
        sessionId: 'self',
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc'
    });
    service.onRtcPeerLifecycleDo('fixture-transport', {
        onCreated: (peer) => {
            const sent: ALMessage[] = [];
            sentByPeerId.set(peer.peerId, sent);
            vi.spyOn(peer.connection, 'connect').mockImplementation(() => undefined);
            vi.spyOn(peer.channel, 'connect').mockImplementation(() => undefined);
            vi.spyOn(peer.channel, 'isOpen').mockReturnValue(true);
            vi.spyOn(peer.channel, 'readHealth').mockReturnValue({ ...peer.channel.readHealth(), readyState: 'open' });
            vi.spyOn(peer.channel, 'send').mockImplementation(async (message) => {
                sent.push(decodePersistedALMessageValue(message));
            });
        },
        onDeleted: () => undefined
    });
    return service;
}

function overlay(
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
