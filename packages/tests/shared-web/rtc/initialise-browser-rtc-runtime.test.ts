import '../../setup-browser-indexeddb.ts';

import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { configureBrowserRtcPeerCreationPolicies } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toResilienceDto } from '@shared-web/browser/resilience-config.ts';
import {
    initialiseRtcConnectionService,
    initialiseRtcOverlayMulticastManager
} from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
import {
    newALMulticastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import {
    createDefaultWsQueueBoxClientService,
    default as WsQueueBoxClientService
} from '@shared/services/ws-queue-box-client-service.ts';
import type { QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime
} from '../../shared/native-rtc-connection-fixture.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

describe('browser RTC runtime composition', () => {
    afterEach(() => vi.restoreAllMocks());
    beforeEach(() => {
        configureTestCacheRepositories();
        configureBrowserALRuntimeStores('self');
    });

    it('rejects a queued offer while signaling starts, then admits the selected accepted peer', async () => {
        const nativeRuntime = installNativeRtcRuntime();
        const networkConnectStarted = Promise.withResolvers<void>();
        const networkConnect = Promise.withResolvers<void>();
        const socket = new JsonWebSocketClient('ws://rtc-fixture.invalid');
        vi.spyOn(socket, 'connect').mockImplementation(() => {
            networkConnectStarted.resolve();
            return networkConnect.promise;
        });
        const queueBox = createDefaultWsQueueBoxClientService({
            inbox: new InMemoryQueueBox(),
            outbox: new InMemoryQueueBox(),
            socket,
            sessionId: 'self'
        });
        const initializing = initialiseRtcConnectionService({
            webSocketQueueBox: queueBox,
            qboxEngine: new InboxOutboxEngine(),
            clientData: { clientId: 'self', sessionId: 'self', isOnline: true },
            iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
            dataChannelName: 'test',
            rtcSignalingTopicId: 'rtc'
        });

        try {
            await networkConnectStarted.promise;
            await dequeueOffer(queueBox, 'startup-peer');
            networkConnect.resolve();
            const service = await initializing;

            expect(service.knownPeerIds()).toEqual([]);
            expect(nativeRuntime.createdConnections).toHaveLength(0);
            expect(service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(0);
            expect(service.ensurePeerConnectionStarted('direct-startup-peer').left).toMatchObject({
                kind: 'dial-denied',
                reason: 'browser-runtime-initializing'
            });
            expect(service.readPeerConnectionAttemptBudgetDiagnostics().consumedCount).toBe(0);

            const group = acceptedGroup(['self', 'startup-peer']);
            groupStateSnapshotsRepository.setGroupStateSnapshot(group);
            overlaysRepository.setAcceptedOverlayById(
                toScopedOverlayId(group.group),
                overlay(group, 1, ['startup-peer'])
            );
            const manager = new WebRtcGroupManager(service, {
                groupCache: groupStateSnapshotsRepository.readableGroupStateSnapshotCache(),
                clientCache: clientStateSnapshotsRepository.readableClientStateSnapshotCache(),
                plannedOverlayCache: overlaysRepository.readablePlannedOverlayCache(),
                acceptedOverlayCache: overlaysRepository.readableAcceptedOverlayCache()
            });
            await manager.getOrCreate(group.group).acceptGroupUpdate(group);
            configureBrowserRtcPeerCreationPolicies(service, manager);

            await dequeueOffer(queueBox, 'startup-peer');

            expect(service.knownPeerIds()).toEqual(['startup-peer']);
            expect(nativeRuntime.createdConnections).toHaveLength(1);
            expect(nativeRuntime.createdConnections[0].receivedDescriptions).toEqual([
                { type: 'offer', sdp: 'startup-peer-offer' }
            ]);
        }
        finally {
            networkConnect.resolve();
            try {
                const service = await initializing;
                for (const peerId of service.knownPeerIds()) {
                    service.disconnectPeer(peerId);
                }
            }
            finally {
                try {
                    queueBox.close();
                }
                finally {
                    nativeRuntime.dispose();
                }
            }
        }
    });

    it('routes multicast traffic through accepted rather than conflicting planned next hops', async () => {
        const group = acceptedGroup(['self', 'accepted-peer', 'planned-peer']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const overlayId = toScopedOverlayId(group.group);
        overlaysRepository.setPlannedOverlayById(overlayId, overlay(group, 2, ['planned-peer']));
        overlaysRepository.setAcceptedOverlayById(overlayId, overlay(group, 1, ['accepted-peer']));
        const nativeRuntime = installNativeRtcRuntime();
        const fixture = createNativeRtcConnectionFixture({
            sessionId: 'self',
            token: 'fixture-token',
            iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
            dataChannelName: 'test',
            rtcSignalingTopicId: 'rtc'
        }, nativeRuntime);
        onTestFinished(() => {
            try {
                fixture.dispose();
            }
            finally {
                nativeRuntime.dispose();
            }
        });
        for (const peerId of ['accepted-peer', 'planned-peer']) {
            const connected = fixture.service.ensurePeerConnectionStarted(peerId, true);
            expect(connected.right?.peer.peerId).toBe(peerId);
            const nativePeer = fixture.nativePeer(peerId);
            nativePeer.setConnected();
            for (const channel of nativePeer.channels) {
                channel.open();
            }
        }
        expect(fixture.service.readyPeerIdsForLane()).toEqual(['accepted-peer', 'planned-peer']);
        const manager = initialiseRtcOverlayMulticastManager({
            webRtcConnectionService: fixture.service,
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
                { qos: { durability: { algo: 'volatile' } } }
            )
        );

        expect(result).toMatchObject({ status: 'sent-immediate', entries: [] });
        const acceptedMessages = fixture.nativePeer('accepted-peer').channels.flatMap((channel) => channel.sent);
        const plannedMessages = fixture.nativePeer('planned-peer').channels.flatMap((channel) => channel.sent);
        expect(acceptedMessages).toHaveLength(1);
        expect(plannedMessages).toEqual([]);
        const sent = acceptedMessages[0];
        if (typeof sent !== 'string') {
            throw new Error('Expected serialized AL multicast traffic');
        }
        const message = decodePersistedALMessage(sent);
        expect(message.forwarding?.overlayId).toBe(overlayId);
        expect(message.forwarding?.nextHopPeerIds).toEqual(['accepted-peer']);
    });
});

async function dequeueOffer(queueBox: WsQueueBoxClientService, peerId: string): Promise<void> {
    const signal: QRtcSignalingMessage = {
        channel: 'RtcSignal',
        type: 'Signal',
        fromId: peerId,
        toId: 'self',
        sessionId: peerId,
        token: 'fixture-token',
        signalType: 'Offer',
        payload: { description: { type: 'offer', sdp: `${peerId}-offer` }, candidate: null }
    };
    const message: ALMessage = newALUnicastMessage(
        peerId,
        { topicId: 'rtc', resourceId: `offer-${peerId}`, contextId: 'group-1' },
        'self',
        'rtc',
        signal
    );
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, WsQueueBoxClientService.INBOX_ENQUEUE_TYPE);
    await queueBox.inbox.enqueue(entry);
    await queueBox.dequeueInbox(WsQueueBoxClientService.INBOX_DEQUEUE_TYPES, toResilienceDto());
    expect((await queueBox.inbox.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
}

function acceptedGroup(sessionIds: readonly string[]): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        sessionIds
    });
    return {
        ...snapshot,
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

function overlay(group: GroupSnapshot, version: number, nextHopSessionIds: readonly string[]): OverlayInfo {
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
