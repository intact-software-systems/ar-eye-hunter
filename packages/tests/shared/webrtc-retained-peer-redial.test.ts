import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import {
    DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY,
    DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY
} from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingType,
    type QRtcSignalingMessage
} from '@shared/webrtc/QRtcSignalingContracts.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type NativeRtcConnectionFixture,
    type NativeRtcRuntime,
    type SimulatedNativeRtcPeerConnection
} from './native-rtc-connection-fixture.ts';
import { acceptActiveLayoutGroup, createGroupSnapshot } from './web-rtc-group-manager-test-fixture.ts';

const ESTABLISHMENT_TIMEOUT_MS = DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY.timeoutMs;

let runtime: NativeRtcRuntime;
const groups: RtcGroup[] = [];

interface RtcGroup {
    readonly connection: NativeRtcConnectionFixture;
    readonly manager: WebRtcGroupManager;
    readonly acceptedOverlayCache: LatestRepository<string, OverlayInfo>;
    readonly snapshot: GroupSnapshot;
    readonly remoteSessionId: string;
}

beforeEach(() => {
    vi.useFakeTimers();
    runtime = installNativeRtcRuntime();
});

afterEach(() => {
    for (const group of groups.splice(0)) {
        group.manager.stopReconcileWakes();
        group.connection.dispose();
    }
    runtime.dispose();
    vi.useRealTimers();
});

async function createGroup(sessionId: string, remoteSessionId: string): Promise<RtcGroup> {
    const connection = createNativeRtcConnectionFixture({
        sessionId,
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 600_000 },
        dataChannelName: 'reliable',
        dataChannelLanes: [{ id: 'realtime', label: 'realtime' }],
        faultPort: createPassThroughTransportFaultPort(),
        rtcSignalingTopicId: 'rtc',
        peerEstablishmentTimeout: { ...DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY, enabled: true },
        peerConnectionAttemptBudget: { ...DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY, enabled: true }
    }, runtime);
    await connection.service.connectSignaler();
    const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const manager = new WebRtcGroupManager(connection.service, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        acceptedOverlayCache
    });
    manager.startReconcileWakes();
    const snapshot = createGroupSnapshot({
        groupId: 'room',
        membershipVersion: 1,
        memberSessionIds: [sessionId, remoteSessionId]
    });
    const group = { connection, manager, acceptedOverlayCache, snapshot, remoteSessionId };
    groups.push(group);
    await acceptActiveLayoutGroup(manager, acceptedOverlayCache, snapshot);
    return group;
}

async function createEstablishedGroup(sessionId: string, remoteSessionId: string): Promise<RtcGroup> {
    const group = await createGroup(sessionId, remoteSessionId);
    await establish(group, group.connection.nativePeer(remoteSessionId));
    return group;
}

async function establish(group: RtcGroup, native: SimulatedNativeRtcPeerConnection): Promise<void> {
    native.setConnected();
    if (native.channels.length === 0) {
        await native.receiveDataChannel('reliable');
        await native.receiveDataChannel('realtime');
    }
    await Promise.all(native.channels.map((channel) => channel.open()));
    await group.manager.whenReconciled();
}

/** The browser fires negotiationneeded once the offering side creates its channels; the fixture leaves that to the test. */
async function negotiate(native: SimulatedNativeRtcPeerConnection): Promise<void> {
    await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
}

/** What the local side sees when the remote page reloads: the association ends and both lanes close. */
async function endRemotePage(group: RtcGroup, native: SimulatedNativeRtcPeerConnection): Promise<void> {
    native.endSctpAssociation();
    await Promise.all(native.channels.map((channel) => channel.close()));
    await group.manager.whenReconciled();
}

async function acceptPresence(
    group: RtcGroup,
    version: number,
    activeSessionIds: readonly string[]
): Promise<void> {
    await acceptActiveLayoutGroup(group.manager, group.acceptedOverlayCache, {
        ...group.snapshot,
        causalRevision: { groupRevision: 1, presenceRevision: version },
        group: { ...group.snapshot.group, presenceVersion: version, snapshotVersion: version },
        activeSessions: group.snapshot.activeSessions
            .filter((session) => activeSessionIds.includes(session.sessionId))
            .map((session) =>
                session.sessionId === group.remoteSessionId
                    ? { ...session, generationId: `generation-${version}`, generationVersion: version }
                    : session
            ),
        onlineMemberCount: activeSessionIds.length
    });
}

function signalsTo(group: RtcGroup, signalType: QRtcSignalingType): number {
    return group.connection.sentSignals
        .filter((signal) => signal.toId === group.remoteSessionId && signal.signalType === signalType)
        .length;
}

function signalFromRemote(
    group: RtcGroup,
    signalType: typeof QRtcSignalingType.Offer | typeof QRtcSignalingType.Answer
): QRtcSignalingMessage {
    const type = signalType === QRtcSignalingType.Offer ? 'offer' : 'answer';
    return {
        channel: QRtcSignalingChannel.RtcSignal,
        type: QRtcSignalingMsgType.Signal,
        fromId: group.remoteSessionId,
        toId: group.connection.service.input.sessionId,
        sessionId: group.remoteSessionId,
        token: 'remote-token',
        signalType,
        payload: { description: { type, sdp: `remote-${type}-sdp` }, candidate: null }
    };
}

describe('WebRtcGroupManager retained peer redial', () => {
    it('redials an unanswered retained dial in the pass that sees its remote side again', async () => {
        const group = await createEstablishedGroup('z-self', 'a-peer');
        const established = group.connection.nativePeer('a-peer');

        await endRemotePage(group, established);
        const lostDial = group.connection.nativePeer('a-peer');
        await negotiate(lostDial);
        const lostDialAt = Date.now();
        expect(lostDial).not.toBe(established);
        expect(signalsTo(group, QRtcSignalingType.Offer)).toBe(1);

        await vi.advanceTimersByTimeAsync(1_500);
        await acceptPresence(group, 2, ['z-self']);
        expect(group.connection.service.inFlightPeerIds()).toEqual(['a-peer']);

        await vi.advanceTimersByTimeAsync(3_500);
        await acceptPresence(group, 3, ['z-self', 'a-peer']);
        const redial = group.connection.nativePeer('a-peer');
        await negotiate(redial);

        expect(redial).not.toBe(lostDial);
        expect(lostDial.connectionState).toBe('closed');
        expect(runtime.createdConnections).toHaveLength(3);
        expect(signalsTo(group, QRtcSignalingType.Offer)).toBe(2);
        expect(group.connection.service.peerConnectionAttemptDiagnostics('a-peer')?.attempts).toBe(2);

        await group.connection.receive(signalFromRemote(group, QRtcSignalingType.Answer));
        await establish(group, redial);
        expect(group.connection.service.readyPeerIdsForLane('reliable')).toEqual(['a-peer']);
        expect(group.connection.service.readyPeerIdsForLane('realtime')).toEqual(['a-peer']);
        expect(Date.now() - lostDialAt).toBeLessThan(ESTABLISHMENT_TIMEOUT_MS);

        await group.manager.notifyClientPresenceChanged();
        expect(runtime.createdConnections).toHaveLength(3);
    });

    it('keeps a dial that is still connecting when no disappearance came first', async () => {
        const group = await createGroup('z-self', 'a-peer');
        const dial = group.connection.nativePeer('a-peer');
        await negotiate(dial);

        await vi.advanceTimersByTimeAsync(5_000);
        await acceptPresence(group, 2, ['z-self', 'a-peer']);
        await group.manager.notifyClientPresenceChanged();

        expect(group.connection.nativePeer('a-peer')).toBe(dial);
        expect(dial.connectionState).toBe('new');
        expect(runtime.createdConnections).toHaveLength(1);
        expect(signalsTo(group, QRtcSignalingType.Offer)).toBe(1);
    });

    it('keeps a retained dial whose offer the remote side already answered', async () => {
        const group = await createGroup('z-self', 'a-peer');
        const dial = group.connection.nativePeer('a-peer');
        await negotiate(dial);
        await group.connection.receive(signalFromRemote(group, QRtcSignalingType.Answer));

        await acceptPresence(group, 2, ['z-self']);
        await vi.advanceTimersByTimeAsync(2_000);
        await acceptPresence(group, 3, ['z-self', 'a-peer']);

        expect(group.connection.nativePeer('a-peer')).toBe(dial);
        expect(runtime.createdConnections).toHaveLength(1);
    });

    it('keeps the answering side retained peer that took the offer of the reloaded page', async () => {
        const group = await createEstablishedGroup('a-self', 'z-peer');
        const established = group.connection.nativePeer('z-peer');

        await endRemotePage(group, established);
        const waiting = group.connection.nativePeer('z-peer');
        expect(waiting).not.toBe(established);
        await acceptPresence(group, 2, ['a-self']);

        await vi.advanceTimersByTimeAsync(3_000);
        await group.connection.receive(signalFromRemote(group, QRtcSignalingType.Offer));
        await acceptPresence(group, 3, ['a-self', 'z-peer']);

        expect(group.connection.nativePeer('z-peer')).toBe(waiting);
        expect(signalsTo(group, QRtcSignalingType.Answer)).toBe(1);
        await establish(group, waiting);
        expect(group.connection.service.readyPeerIdsForLane('reliable')).toEqual(['z-peer']);
        expect(runtime.createdConnections).toHaveLength(2);
    });
});
