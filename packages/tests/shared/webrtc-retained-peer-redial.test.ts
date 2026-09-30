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
    QRtcSignalingType,
    type QRtcSignalingMessage
} from '@shared/webrtc/qrtc-signaling-contracts.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type NativeRtcConnectionFixture,
    type NativeRtcRuntime,
    type SimulatedNativeRtcPeerConnection
} from './native-rtc-connection-fixture.ts';
import {
    acceptActiveLayoutGroup,
    createGroupSnapshot
} from './web-rtc-group-manager-test-fixture.ts';

const ESTABLISHMENT_TIMEOUT_MS = DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY.timeoutMs;

let runtime: NativeRtcRuntime;
const managers: WebRtcGroupManager[] = [];
const connections: NativeRtcConnectionFixture[] = [];

interface ManagedSide {
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
    // Wakes stop before teardown, so removing the peers cannot dial them back.
    for (const manager of managers.splice(0)) {
        manager.stopReconcileWakes();
    }
    for (const connection of connections.splice(0)) {
        connection.dispose();
    }
    runtime.dispose();
    vi.useRealTimers();
});

async function createConnection(sessionId: string): Promise<NativeRtcConnectionFixture> {
    const connection = createNativeRtcConnectionFixture(
        {
            sessionId,
            token: `${sessionId}-token`,
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 600_000 },
            dataChannelName: 'reliable',
            dataChannelLanes: [{ id: 'realtime', label: 'realtime' }],
            rtcSignalingTopicId: 'rtc',
            peerEstablishmentTimeout: {
                ...DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY,
                enabled: true
            },
            peerConnectionAttemptBudget: {
                ...DEFAULT_WEB_RTC_PEER_CONNECTION_ATTEMPT_BUDGET_POLICY,
                enabled: true
            }
        },
        runtime,
        createPassThroughTransportFaultPort()
    );
    connections.push(connection);
    await connection.service.connectSignaler();
    return connection;
}

async function createManagedSide(sessionId: string, remoteSessionId: string): Promise<ManagedSide> {
    const connection = await createConnection(sessionId);
    const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const manager = new WebRtcGroupManager(connection.service, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        acceptedOverlayCache
    });
    managers.push(manager);
    manager.startReconcileWakes();
    const snapshot = createGroupSnapshot({
        groupId: 'room',
        membershipVersion: 1,
        memberSessionIds: [sessionId, remoteSessionId]
    });
    await acceptActiveLayoutGroup(manager, acceptedOverlayCache, snapshot);
    return { connection, manager, acceptedOverlayCache, snapshot, remoteSessionId };
}

/** The first page of the remote side is not modelled; its connection simply comes up. */
async function createEstablishedSide(
    sessionId: string,
    remoteSessionId: string
): Promise<ManagedSide> {
    const side = await createManagedSide(sessionId, remoteSessionId);
    const native = side.connection.nativePeer(remoteSessionId);
    native.setConnected();
    if (native.channels.length === 0) {
        await native.receiveDataChannel('reliable');
        await native.receiveDataChannel('realtime');
    }
    await Promise.all(native.channels.map((channel) => channel.open()));
    await side.manager.whenReconciled();
    return side;
}

/** What the local side sees when the remote page reloads: the association ends and both lanes close. */
async function endRemotePage(side: ManagedSide): Promise<void> {
    const native = side.connection.nativePeer(side.remoteSessionId);
    native.endSctpAssociation();
    await Promise.all(native.channels.map((channel) => channel.close()));
    await side.manager.whenReconciled();
}

/** A browser fires negotiationneeded once the offering side creates its channels; the fixture leaves it to the test. */
async function negotiate(native: SimulatedNativeRtcPeerConnection): Promise<void> {
    await native.onnegotiationneeded?.call(native, new Event('negotiationneeded'));
}

async function acceptPresence(
    side: ManagedSide,
    version: number,
    activeSessionIds: readonly string[]
): Promise<void> {
    await acceptActiveLayoutGroup(side.manager, side.acceptedOverlayCache, {
        ...side.snapshot,
        causalRevision: { groupRevision: 1, presenceRevision: version },
        group: { ...side.snapshot.group, presenceVersion: version, snapshotVersion: version },
        activeSessions: side.snapshot.activeSessions
            .filter((session) => activeSessionIds.includes(session.sessionId))
            .map((session) =>
                session.sessionId === side.remoteSessionId
                    ? {
                        ...session,
                        generationId: `generation-${version}`,
                        generationVersion: version
                    }
                    : session
            ),
        onlineMemberCount: activeSessionIds.length
    });
}

function sentSignalsOfType<T extends typeof QRtcSignalingType.Offer | typeof QRtcSignalingType.Answer>(
    connection: NativeRtcConnectionFixture,
    signalType: T
): readonly Extract<QRtcSignalingMessage, { signalType: T; }>[] {
    return connection.sentSignals.filter((
        signal
    ): signal is Extract<QRtcSignalingMessage, { signalType: T; }> => signal.signalType === signalType);
}

async function establishPair(
    offerer: SimulatedNativeRtcPeerConnection,
    answerer: SimulatedNativeRtcPeerConnection
): Promise<void> {
    offerer.setConnected();
    answerer.setConnected();
    await answerer.receiveDataChannel('reliable');
    await answerer.receiveDataChannel('realtime');
    await Promise.all([...offerer.channels, ...answerer.channels].map((channel) => channel.open()));
}

describe('WebRtcGroupManager retained peer redial', () => {
    it('redials an unanswered retained dial in the pass that sees its remote side again', async () => {
        const offerer = await createEstablishedSide('z-self', 'a-peer');
        const established = offerer.connection.nativePeer('a-peer');

        await endRemotePage(offerer);
        const lostDial = offerer.connection.nativePeer('a-peer');
        await negotiate(lostDial);
        const lostDialAt = Date.now();
        expect(lostDial).not.toBe(established);
        expect(
            sentSignalsOfType(offerer.connection, QRtcSignalingType.Offer).map((offer) => offer.offerId)
        )
            .toEqual(['offer-1']);

        await vi.advanceTimersByTimeAsync(1_500);
        await acceptPresence(offerer, 2, ['z-self']);
        expect(offerer.connection.service.inFlightPeerIds()).toEqual(['a-peer']);

        await vi.advanceTimersByTimeAsync(3_500);
        const reloaded = await createConnection('a-peer');
        await acceptPresence(offerer, 3, ['z-self', 'a-peer']);
        const redial = offerer.connection.nativePeer('a-peer');

        expect(redial).not.toBe(lostDial);
        expect(lostDial.connectionState).toBe('closed');
        expect(redial.channels.map((channel) => channel.label)).toEqual(['reliable', 'realtime']);
        expect(runtime.createdConnections).toHaveLength(3);
        // The redial keeps the attempt budget: it is not reset, so the redial counts as the second attempt.
        expect(offerer.connection.service.peerConnectionAttemptDiagnostics('a-peer')?.attempts)
            .toBe(2);

        await negotiate(redial);
        const offers = sentSignalsOfType(offerer.connection, QRtcSignalingType.Offer);
        expect(offers.map((offer) => offer.offerId)).toEqual(['offer-1', 'offer-2']);

        await reloaded.receive(offers[1]);
        const [answer] = sentSignalsOfType(reloaded, QRtcSignalingType.Answer);
        expect(answer.offerId).toBe('offer-2');
        await offerer.connection.receive(answer);
        await establishPair(redial, reloaded.nativePeer('z-self'));
        await offerer.manager.whenReconciled();

        expect(offerer.connection.service.readyPeerIdsForLane('reliable')).toEqual(['a-peer']);
        expect(offerer.connection.service.readyPeerIdsForLane('realtime')).toEqual(['a-peer']);
        expect(reloaded.service.readyPeerIdsForLane('reliable')).toEqual(['z-self']);
        expect(Date.now() - lostDialAt).toBeLessThan(ESTABLISHMENT_TIMEOUT_MS);
        expect(runtime.createdConnections).toHaveLength(4);
    });

    it('connects on the redial when the old offer reaches the reloaded page late', async () => {
        const offerer = await createEstablishedSide('z-self', 'a-peer');
        await endRemotePage(offerer);
        const lostDial = offerer.connection.nativePeer('a-peer');
        await negotiate(lostDial);
        await acceptPresence(offerer, 2, ['z-self']);
        await vi.advanceTimersByTimeAsync(2_000);
        const reloaded = await createConnection('a-peer');
        await acceptPresence(offerer, 3, ['z-self', 'a-peer']);
        const redial = offerer.connection.nativePeer('a-peer');
        await negotiate(redial);
        const [lateOffer, currentOffer] = sentSignalsOfType(
            offerer.connection,
            QRtcSignalingType.Offer
        );

        await reloaded.receive(lateOffer);
        const answering = reloaded.nativePeer('z-self');
        const [lateAnswer] = sentSignalsOfType(reloaded, QRtcSignalingType.Answer);
        await offerer.connection.receive(lateAnswer);

        expect(lateAnswer.offerId).toBe('offer-1');
        expect(redial.signalingState).toBe('have-local-offer');
        expect(redial.receivedDescriptions).toEqual([]);
        expect(
            offerer.connection.service.readPeer('a-peer')?.connection.readDiagnostics()
                .staleAnswerIgnoredCount
        ).toBe(1);

        await reloaded.receive(currentOffer);
        const answers = sentSignalsOfType(reloaded, QRtcSignalingType.Answer);
        expect(answers.map((answer) => answer.offerId)).toEqual(['offer-1', 'offer-2']);
        expect(reloaded.nativePeer('z-self')).toBe(answering);
        await offerer.connection.receive(answers[1]);
        expect(redial.signalingState).toBe('stable');
        expect(redial.receivedDescriptions).toHaveLength(1);

        await establishPair(redial, answering);
        await offerer.manager.whenReconciled();
        expect(offerer.connection.service.readyPeerIdsForLane('reliable')).toEqual(['a-peer']);
        expect(reloaded.service.readyPeerIdsForLane('realtime')).toEqual(['z-self']);
        expect(runtime.createdConnections).toHaveLength(4);
    });

    it('keeps an established peer that becomes desired again', async () => {
        const offerer = await createEstablishedSide('z-self', 'a-peer');
        const established = offerer.connection.nativePeer('a-peer');

        await acceptPresence(offerer, 2, ['z-self']);
        await vi.advanceTimersByTimeAsync(2_000);
        await acceptPresence(offerer, 3, ['z-self', 'a-peer']);

        expect(offerer.connection.nativePeer('a-peer')).toBe(established);
        expect(established.connectionState).toBe('connected');
        expect(runtime.createdConnections).toHaveLength(1);
        expect(sentSignalsOfType(offerer.connection, QRtcSignalingType.Offer)).toEqual([]);
        expect(offerer.connection.service.readyPeerIdsForLane('reliable')).toEqual(['a-peer']);
    });

    it('keeps the answering side retained peer that took the offer of the reloaded page', async () => {
        const answerer = await createEstablishedSide('a-self', 'z-peer');
        const established = answerer.connection.nativePeer('z-peer');

        await endRemotePage(answerer);
        const waiting = answerer.connection.nativePeer('z-peer');
        expect(waiting).not.toBe(established);
        await acceptPresence(answerer, 2, ['a-self']);

        await vi.advanceTimersByTimeAsync(3_000);
        const reloaded = await createConnection('z-peer');
        expect(reloaded.service.ensurePeerConnectionStarted('a-self').left).toBeUndefined();
        const offering = reloaded.nativePeer('a-self');
        await negotiate(offering);
        const [offer] = sentSignalsOfType(reloaded, QRtcSignalingType.Offer);
        await answerer.connection.receive(offer);
        await acceptPresence(answerer, 3, ['a-self', 'z-peer']);

        expect(answerer.connection.nativePeer('z-peer')).toBe(waiting);
        const [answer] = sentSignalsOfType(answerer.connection, QRtcSignalingType.Answer);
        expect(answer.offerId).toBe(offer.offerId);
        await reloaded.receive(answer);
        await establishPair(offering, waiting);
        await answerer.manager.whenReconciled();
        expect(answerer.connection.service.readyPeerIdsForLane('reliable')).toEqual(['z-peer']);
        expect(runtime.createdConnections).toHaveLength(3);
    });
});
