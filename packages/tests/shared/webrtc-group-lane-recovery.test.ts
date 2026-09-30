import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type NativeRtcConnectionFixture,
    type NativeRtcRuntime,
    type SimulatedNativeRtcPeerConnection
} from './native-rtc-connection-fixture.ts';
import { acceptActiveLayoutGroup, createGroupSnapshot } from './web-rtc-group-manager-test-fixture.ts';

let runtime: NativeRtcRuntime;
const fixtures: { connection: NativeRtcConnectionFixture; manager: WebRtcGroupManager; }[] = [];

interface ConnectedGroup {
    readonly connection: NativeRtcConnectionFixture;
    readonly manager: WebRtcGroupManager;
    readonly native: SimulatedNativeRtcPeerConnection;
    readonly snapshot: GroupSnapshot;
}

beforeEach(() => {
    runtime = installNativeRtcRuntime();
});

afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
        fixture.manager.stopReconcileWakes();
        fixture.connection.dispose();
    }
    runtime.dispose();
});

async function createConnectedGroup(): Promise<ConnectedGroup> {
    const connection = createNativeRtcConnectionFixture({
        sessionId: 'z-self',
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        dataChannelName: 'reliable',
        dataChannelLanes: [{ id: 'realtime', label: 'realtime' }],
        rtcSignalingTopicId: 'rtc'
    }, runtime, createPassThroughTransportFaultPort());
    const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const manager = new WebRtcGroupManager(connection.service, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        acceptedOverlayCache
    });
    fixtures.push({ connection, manager });
    manager.startReconcileWakes();
    const snapshot = createGroupSnapshot({
        groupId: 'room',
        membershipVersion: 1,
        memberSessionIds: ['z-self', 'a-peer']
    });
    await acceptActiveLayoutGroup(manager, acceptedOverlayCache, snapshot);
    const native = connection.nativePeer('a-peer');
    native.setConnected();
    await Promise.all(native.channels.map((channel) => channel.open()));
    await manager.whenReconciled();
    return { connection, manager, native, snapshot };
}

describe('desired RTC lane recovery', () => {
    it.each(['close', 'fail'] as const)('recovers both lanes after current native channels %s on a connected peer', async (ending) => {
        const { connection, manager, native, snapshot } = await createConnectedGroup();
        await manager.acceptGroupUpdate({
            ...snapshot,
            causalRevision: { groupRevision: 1, presenceRevision: 2 },
            group: { ...snapshot.group, presenceVersion: 2, snapshotVersion: 2 },
            activeSessions: snapshot.activeSessions.map((session) =>
                session.sessionId === 'a-peer'
                    ? { ...session, generationId: 'reloaded-generation', generationVersion: 2 }
                    : session
            )
        });
        const originalChannels = [...native.channels];
        await Promise.all(originalChannels.map((channel) => channel[ending]()));
        await manager.whenReconciled();

        expect(native.connectionState).toBe('connected');
        expect(runtime.createdConnections).toHaveLength(1);
        expect(native.channels).toHaveLength(4);
        await Promise.all(native.channels.slice(2).map((channel) => channel.open()));
        expect(connection.service.readyPeerIdsForLane('reliable')).toEqual(['a-peer']);
        expect(connection.service.readyPeerIdsForLane('realtime')).toEqual(['a-peer']);
        expect(connection.service.readPeerChannel('a-peer')?.sendJson({ resumed: true }).status).toBe('sent');
        expect(native.channels[2].sent).toEqual(['{"resumed":true}']);
        await manager.whenReconciled();
        expect(native.channels).toHaveLength(4);
    });

    it('preserves the other lane and fences callbacks from the replaced native channel', async () => {
        const { connection, manager, native } = await createConnectedGroup();
        const original = native.channels[0];
        const staleClose = original.onclose;
        const staleError = original.onerror;
        await original.close();
        await manager.whenReconciled();
        expect(native.channels).toHaveLength(3);
        await native.channels[2].open();

        await staleClose?.call(original, new Event('close'));
        const staleErrorEvent = Object.assign(new Event('error'), {
            error: Object.assign(new DOMException('Late native failure'), {
                errorDetail: 'data-channel-failure' as const,
                receivedAlert: null,
                sctpCauseCode: null,
                sdpLineNumber: null,
                sentAlert: null
            })
        });
        await staleError?.call(original, staleErrorEvent);
        await manager.whenReconciled();

        expect(connection.service.readyPeerIdsForLane('reliable')).toEqual(['a-peer']);
        expect(connection.service.readyPeerIdsForLane('realtime')).toEqual(['a-peer']);
        expect(native.channels).toHaveLength(3);
        expect(native.channels[1].readyState).toBe('open');
    });

    it('observes existing peers when recovery wakes restart', async () => {
        const { connection, manager, native } = await createConnectedGroup();
        manager.stopReconcileWakes();
        manager.startReconcileWakes();
        manager.startReconcileWakes();
        await native.channels[0].close();
        await manager.whenReconciled();
        expect(native.channels).toHaveLength(3);
        await native.channels[2].open();
        expect(connection.service.readyPeerIdsForLane()).toEqual(['a-peer']);
    });

    it('does not recreate lanes or peers during explicit shutdown', async () => {
        const { connection, manager, native } = await createConnectedGroup();
        const closing = native.channels[0].close();
        manager.stopReconcileWakes();
        await closing;
        await manager.whenReconciled();
        expect(native.channels).toHaveLength(2);
        connection.dispose();
        await manager.whenReconciled();
        expect(connection.service.knownPeerIds()).toEqual([]);
        expect(runtime.createdConnections).toHaveLength(1);
        expect(native.connectionState).toBe('closed');
    });

    it('does not repair a lane after its peer leaves current group presence', async () => {
        const { connection, manager, native, snapshot } = await createConnectedGroup();
        await manager.acceptGroupUpdate({
            ...snapshot,
            group: { ...snapshot.group, presenceVersion: 2, snapshotVersion: 2 },
            causalRevision: { groupRevision: 1, presenceRevision: 2 },
            activeSessions: snapshot.activeSessions.filter((session) => session.sessionId === 'z-self'),
            onlineMemberCount: 1
        });
        await native.channels[0].close();
        await manager.whenReconciled();
        expect(native.channels).toHaveLength(2);
        expect(connection.service.readyPeerIdsForLane()).toEqual([]);
    });

    it('ignores delayed native callbacks after a peer is replaced', async () => {
        const { connection, manager, native } = await createConnectedGroup();
        const original = native.channels[0];
        const staleClose = original.onclose;
        manager.stopReconcileWakes();
        connection.service.disconnectPeer('a-peer');
        connection.service.ensurePeerConnectionStarted('a-peer');
        manager.startReconcileWakes();
        const replacement = connection.nativePeer('a-peer');
        replacement.setConnected();
        await Promise.all(replacement.channels.map((channel) => channel.open()));
        await staleClose?.call(original, new Event('close'));
        await manager.whenReconciled();
        expect(connection.service.readyPeerIdsForLane()).toEqual(['a-peer']);
        expect(replacement.channels).toHaveLength(2);
        expect(runtime.createdConnections).toHaveLength(2);
    });
});
