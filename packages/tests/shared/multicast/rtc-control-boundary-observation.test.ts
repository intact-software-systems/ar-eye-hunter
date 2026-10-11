import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { ALInboundAcknowledgementEvidence } from '@shared/alm/inbound/control/al-inbound-acknowledgement-evidence.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    createDefaultWebRtcRxStreamerService,
    WebRtcRxStreamerService
} from '@shared/services/web-rtc-rx-streamer-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type NativeRtcConnectionFixture,
    type SimulatedNativeRtcDataChannel
} from '../native-rtc-connection-fixture.ts';
import {
    createOriginOverlay,
    createOriginSnapshot,
    ORIGIN_ROOM,
    toOriginDirectedSnapshot
} from './rtc-origin-overlay-fixture.ts';

describe('exact RTC ACK boundary observations', () => {
    it('joins automatic director and relayed ACKs to native submission and registered ingress despite throwing observers', async () => {
        vi.useRealTimers();
        // This substitutes native capabilities. It does not execute browser ICE, DTLS or SCTP.
        const nativeRuntime = installNativeRtcRuntime();
        const topology = [
            ['03', ['04']],
            ['04', ['03', '02']],
            ['02', ['04', 'director']],
            ['director', ['02']]
        ] as const;
        const messages = ['03', '02'].map((senderId) =>
            newALMulticastMessage(
                senderId,
                { topicId: 'room.ar-eye-hunter.director', resourceId: `${senderId}-shot`, contextId: ORIGIN_ROOM.groupId },
                ORIGIN_ROOM,
                'room.ar-eye-hunter.director.intent.v1',
                { kind: 'player-shot-intent', senderId, seq: 1 },
                { ack: 'group-leader', reliability: 'at-least-once', ttlMs: 30_000, qos: { durability: { algo: 'volatile' } } }
            )
        );
        const relayed = messages[0]!;
        const direct = messages[1]!;
        const hops = [
            { subject: relayed, fromPeerId: 'director', toPeerId: '02', status: 'delivered' },
            { subject: relayed, fromPeerId: '02', toPeerId: '04', status: 'forwarded' },
            { subject: relayed, fromPeerId: '04', toPeerId: '03', status: 'forwarded' },
            { subject: direct, fromPeerId: 'director', toPeerId: '02', status: 'delivered' }
        ] as const;
        // All business, origin and frame observers exist before the first admission.
        const deliveries = new Map(messages.map((message) => [message.id.msgId, Promise.withResolvers<ALMessage>()]));
        const receipts = new Map(messages.map((message) => [message.id.msgId, Promise.withResolvers<ALDeliverySettlement>()]));
        const frames = new Map(hops.map((hop) => [
            `${hop.subject.id.msgId}/${hop.fromPeerId}/${hop.toPeerId}`,
            Promise.withResolvers<ALMessage>()
        ]));
        const arrivals = new Map([...frames.keys()].map((key) => [key, Promise.withResolvers<void>()]));
        const connections = new Map<string, NativeRtcConnectionFixture>();
        const managers = new Map<string, WebRtcOverlayMulticastManager>();
        const streamers: WebRtcRxStreamerService[] = [];
        const groups: LatestRepository<string, GroupSnapshot>[] = [];
        const overlays: LatestRepository<string, OverlayInfo>[] = [];
        const natives = new Map<string, SimulatedNativeRtcDataChannel>();
        const delivered = new Map<string, ALMessage[]>();
        const outbound = new Map<string, ALOutboundRuntimeDiagnosticsEvent[]>();
        const inbound = new Map<string, ALInboundRuntimeDiagnosticsEvent[]>();
        const pendingReceives: Promise<void>[] = [];
        const observerFailure = new Error('Optional RTC boundary observer failed');
        let primaryFailed = false;
        onTestFinished(async () => {
            const cancellation: Promise<void>[] = [];
            const cleanupFailures: Error[] = [];
            for (const owner of [...streamers, ...managers.values()]) {
                try {
                    cancellation.push(owner.dispose());
                }
                catch (caught) {
                    cleanupFailures.push(toError(caught));
                }
            }
            for (const owner of [...connections.values(), ...groups, ...overlays]) {
                try {
                    owner.dispose();
                }
                catch (caught) {
                    cleanupFailures.push(toError(caught));
                }
            }
            const outcomes = await Promise.allSettled([...cancellation, ...pendingReceives]);
            for (const outcome of outcomes) {
                if (outcome.status === 'rejected') {
                    cleanupFailures.push(toError(outcome.reason));
                }
            }
            try {
                nativeRuntime.dispose();
            }
            catch (caught) {
                cleanupFailures.push(toError(caught));
            }
            finally {
                vi.restoreAllMocks();
            }
            console.info(
                'Task55 cleanup joins',
                JSON.stringify({ owners: cancellation.length, receives: pendingReceives.length, failures: cleanupFailures.length })
            );
            if (cleanupFailures.length > 0 && !primaryFailed) {
                throw cleanupFailures[0];
            }
        });

        try {
            const snapshot = toOriginDirectedSnapshot(createOriginSnapshot(topology.map(([sessionId]) => sessionId), 1), 'director');
            const overlayId = toScopedOverlayId(ORIGIN_ROOM);
            for (const [sessionId, peerIds] of topology) {
                const faultPort = createPassThroughTransportFaultPort();
                const connection = createNativeRtcConnectionFixture(
                    {
                        sessionId,
                        token: 'fixture-token',
                        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
                        dataChannelName: 'alm',
                        rtcSignalingTopicId: 'rtc'
                    },
                    nativeRuntime,
                    faultPort
                );
                connections.set(sessionId, connection);
                const groupCache = new LatestRepository<string, GroupSnapshot>();
                groups.push(groupCache);
                groupCache.accept(overlayId, snapshot);
                const overlayCache = new LatestRepository<string, OverlayInfo>();
                overlays.push(overlayCache);
                overlayCache.accept(overlayId, { ...createOriginOverlay(peerIds), overlayId });
                const outboundEvents: ALOutboundRuntimeDiagnosticsEvent[] = [];
                const inboundEvents: ALInboundRuntimeDiagnosticsEvent[] = [];
                outbound.set(sessionId, outboundEvents);
                inbound.set(sessionId, inboundEvents);
                const manager = new WebRtcOverlayMulticastManager({
                    connectionService: connection.service,
                    groupCache,
                    overlayCache,
                    multicasterFactory: (id) => new WebRtcOverlayMulticastService(id, connection.service),
                    qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, undefined),
                    outboundDiagnostics: (event) => {
                        outboundEvents.push(event);
                        if (event.kind === 'rtc-ack-submission') {
                            throw observerFailure;
                        }
                    },
                    outboundSettlements: (settlement) => {
                        if (settlement.kind === 'acknowledgement' && settlement.complete) {
                            const subject = messages.find((message) => message.id.msgId === settlement.msgId && message.id.senderId === sessionId);
                            if (subject) {
                                receipts.get(subject.id.msgId)!.resolve(settlement);
                            }
                        }
                    },
                    outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
                    circuitBreaker: toCircuitBreaker(),
                    rateLimiter: toRateLimiter(),
                    faultPort,
                    dequeueResilience: createDefaultALOutboundDequeueResilience()
                });
                managers.set(sessionId, manager);
                const streamer = createDefaultWebRtcRxStreamerService({
                    multicast: manager,
                    sessionId,
                    inboundStores: createDefaultInMemoryALInboundRuntimeStores(),
                    inboundDiagnostics: Object.assign((event: ALInboundRuntimeDiagnosticsEvent) => {
                        inboundEvents.push(event);
                        if (event.kind === 'rtc-ack-ingress') {
                            throw observerFailure;
                        }
                    }, {
                        acknowledgementCapture: { evidence: ALInboundAcknowledgementEvidence, batchObservations: ALWorkBatchObservations }
                    }),
                    nowEpochMs: Date.now,
                    heartbeat: { maxMissedPings: 5, pingFrequencyMsecs: 5000 }
                });
                streamers.push(streamer);
                streamer.setRttReportingPeerIds([]);
                const received: ALMessage[] = [];
                delivered.set(sessionId, received);
                streamer.onAllInboxMessagesDo({
                    onMessage: async (message) => {
                        received.push(message);
                        if (sessionId === 'director') {
                            deliveries.get(message.id.msgId)?.resolve(message);
                        }
                    }
                });
                for (const peerId of peerIds) {
                    const started = connection.service.ensurePeerConnectionStarted(peerId, true);
                    expect(started.left).toBeUndefined();
                    const peer = started.right!.peer;
                    streamer.addPeer(peer);
                    const nativePeer = connection.nativePeer(peerId);
                    nativePeer.setConnected();
                    const native = nativePeer.channels.find((channel) => channel === peer.channel.status.dc)!;
                    expect(native).toBeDefined();
                    natives.set(`${sessionId}/${peerId}`, native);
                    await native.open();
                    expect(peer.channel.readHealth().readyState).toBe('open');
                }
            }
            for (const [sessionId, peerIds] of topology) {
                for (const peerId of peerIds) {
                    const native = natives.get(`${sessionId}/${peerId}`)!;
                    const remote = natives.get(`${peerId}/${sessionId}`)!;
                    const send = native.send.bind(native);
                    vi.spyOn(native, 'send').mockImplementation((frame) => {
                        send(frame);
                        const message = decodePersistedALMessageValue(JSON.parse(String(frame)));
                        const control = parseALControlMessage(message);
                        const key = control?.type === 'ack' && control.payload.logicalRecipientPeerId === 'director'
                            ? `${control.payload.ackedMsgId}/${sessionId}/${peerId}`
                            : undefined;
                        if (key) {
                            frames.get(key)?.resolve(message);
                        }
                        const receiving = remote.receive(frame);
                        pendingReceives.push(receiving);
                        void receiving.then(() => {
                            if (key) {
                                arrivals.get(key)?.resolve();
                            }
                        }, (caught) => {
                            if (key) {
                                arrivals.get(key)?.reject(caught);
                            }
                        });
                    });
                }
            }

            const admitted = await Promise.all(messages.map((message) => managers.get(message.id.senderId)!.enqueueIfAbsent(message)));
            for (const admission of admitted) {
                expect(admission.verdict, admission.reason).toMatchObject({ kind: 'admitted' });
            }
            const business = await Promise.all([...deliveries.values()].map((waiter) => waiter.promise));
            const completed = await Promise.all([...receipts.values()].map((waiter) => waiter.promise));
            const ackFrames = await Promise.all([...frames.values()].map((waiter) => waiter.promise));
            await Promise.all([...arrivals.values()].map((waiter) => waiter.promise));
            expect(delivered.get('director')!.map((message) => message.id.msgId).toSorted()).toEqual(messages.map((message) => message.id.msgId).toSorted());
            expect([...delivered].filter(([sessionId]) => sessionId !== 'director').flatMap(([, values]) => values)).toEqual([]);
            for (const receipt of completed) {
                expect(receipt).toMatchObject({
                    mode: 'leader',
                    expectedRecipientPeerIds: ['director'],
                    confirmedRecipientPeerIds: ['director'],
                    unconfirmedRecipientPeerIds: [],
                    complete: true
                });
            }
            for (const original of messages) {
                const delivery = business.find((message) => message.id.msgId === original.id.msgId)!;
                expect(delivery.id).toEqual(original.id);
                expect(delivery.delivery).toEqual(original.delivery);
                expect(delivery.constraints).toEqual(original.constraints);
                expect(delivery.payload).toEqual(original.payload);
                expect(delivery.targets).toMatchObject({ mode: 'multicast', groupRef: ORIGIN_ROOM, recipientPeerIds: ['director'], snapshotVersion: 1 });
            }
            const missing: object[] = [];
            const witnesses: object[] = [];
            for (const [index, hop] of hops.entries()) {
                const ack = ackFrames[index]!;
                const nativeFrames = natives.get(`${hop.fromPeerId}/${hop.toPeerId}`)!.sent.map((frame) =>
                    decodePersistedALMessageValue(JSON.parse(String(frame)))
                );
                expect(nativeFrames).toContainEqual(ack);
                expect(parseALControlMessage(ack)).toEqual({
                    type: 'ack',
                    payload: expect.objectContaining({
                        ackedMsgId: hop.subject.id.msgId,
                        originPeerId: hop.subject.id.senderId,
                        logicalRecipientPeerId: 'director',
                        fromPeerId: hop.fromPeerId,
                        toPeerId: hop.toPeerId,
                        carrier: 'rtc',
                        status: hop.status
                    })
                });
                const identity = {
                    controlMsgId: ack.id.msgId,
                    controlSenderId: ack.id.senderId,
                    fromPeerId: hop.fromPeerId,
                    toPeerId: hop.toPeerId,
                    carrier: 'rtc'
                };
                expect(inbound.get(hop.toPeerId)).toContainEqual(expect.objectContaining({
                    kind: 'acknowledgement-association',
                    incoming: expect.objectContaining({
                        ...identity,
                        subjectMsgId: hop.subject.id.msgId,
                        originPeerId: hop.subject.id.senderId,
                        logicalRecipientPeerId: 'director'
                    })
                }));
                // The existing admission port states the actual return kind; a retained ACK may be pending here.
                const admission = inbound.get(hop.toPeerId)!
                    .filter((event) => event.kind === 'admission-outcome')
                    .find((event) => event.msgId === ack.id.msgId);
                expect(admission).toBeDefined();
                expect([
                    { outcome: 'committed', reason: 'control' },
                    { outcome: 'not-handled', reason: 'control' },
                    { outcome: 'pending', reason: 'pending-admission' }
                ]).toContainEqual({ outcome: admission!.outcome, reason: admission!.reason });
                witnesses.push({
                    ...identity,
                    subjectMsgId: hop.subject.id.msgId,
                    originPeerId: hop.subject.id.senderId,
                    logicalRecipientPeerId: 'director',
                    status: hop.status,
                    admission: { outcome: admission!.outcome, reason: admission!.reason }
                });
                for (
                    const [sessionId, events, expected] of [
                        [hop.fromPeerId, outbound.get(hop.fromPeerId)!, { kind: 'rtc-ack-submission', ...identity, status: 'sent', submissionAttempted: true }],
                        [hop.toPeerId, inbound.get(hop.toPeerId)!, { kind: 'rtc-ack-ingress', ...identity, stage: 'callback-entered' }],
                        [hop.toPeerId, inbound.get(hop.toPeerId)!, {
                            kind: 'rtc-ack-ingress',
                            ...identity,
                            stage: 'admission-returned',
                            pass: 'initial',
                            outcome: 'accepted',
                            acceptance: admission!.reason
                        }]
                    ] as const
                ) {
                    if (!events.some((event) => expect.objectContaining({ ...expected, observedAtEpochMs: expect.any(Number) }).asymmetricMatch(event))) {
                        missing.push({ sessionId, ...expected });
                    }
                }
            }
            console.info(
                'Task55 independent semantic/frame GREEN',
                JSON.stringify({ witnesses, receipts: completed.map((receipt) => ({ kind: receipt.kind, msgId: receipt.msgId })), missing })
            );
            expect(missing, 'Exact ACK boundary observations must exist after independent business, origin, native-frame and registered-receive success')
                .toEqual([]);
        }
        catch (caught) {
            primaryFailed = true;
            throw caught;
        }
    });
});
