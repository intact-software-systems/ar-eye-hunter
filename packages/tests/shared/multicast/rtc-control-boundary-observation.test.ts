import { Temporal } from '@js-temporal/polyfill';
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
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { toCircuitBreaker, type CircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter, type RateLimiter } from '@shared/resilience/rate-limiter.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    createDefaultWebRtcRxStreamerService,
    type WebRtcRxStreamerService
} from '@shared/services/web-rtc-rx-streamer-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import { ALWorkBatchTestObserver } from '../alm/work/al-work-batch-test-observer.ts';
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
    it.each(['healthy', 'relay-quota-exhausted'] as const)(
        'joins automatic director and relayed ACKs to native submission and registered ingress despite throwing observers (%s)',
        async (mode) => {
            vi.useRealTimers();
            if (mode === 'relay-quota-exhausted') {
                // A frozen quota clock keeps the relay's spent quota spent for the whole exchange.
                const frozenNowMs = 1791883286866;
                vi.spyOn(Date, 'now').mockImplementation(() => frozenNowMs);
            }
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
                    {
                        ack: 'group-leader',
                        reliability: 'at-least-once',
                        ttlMs: 30_000,
                        qos: { durability: { algo: 'volatile' } },
                        traceId: `trace-${senderId}-shot`
                    }
                )
            );
            const relayed = messages[0]!;
            const direct = messages[1]!;
            const hops = [
                { subject: relayed, traceId: 'trace-03-shot', fromPeerId: 'director', toPeerId: '02', status: 'delivered' },
                { subject: relayed, traceId: 'trace-03-shot', fromPeerId: '02', toPeerId: '04', status: 'forwarded' },
                { subject: relayed, traceId: 'trace-03-shot', fromPeerId: '04', toPeerId: '03', status: 'forwarded' },
                { subject: direct, traceId: 'trace-02-shot', fromPeerId: 'director', toPeerId: '02', status: 'delivered' }
            ] as const;
            // All business, origin and frame observers exist before the first admission.
            const deliveries = new Map(messages.map((message) => [message.id.msgId, Promise.withResolvers<ALMessage>()]));
            const receipts = new Map(messages.map((message) => [message.id.msgId, Promise.withResolvers<ALDeliverySettlement>()]));
            const completedSubjects = new Set<string>();
            const nativeSubmissionAtByHop = new Map<string, number>();
            const receiptAtBySubject = new Map<string, number>();
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
            const circuitBreakers = new Map<string, CircuitBreaker>();
            const rateLimiters = new Map<string, RateLimiter>();
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
                    vi.useRealTimers();
                }
                console.info(
                    'RTC ACK cleanup joins',
                    JSON.stringify({ owners: cancellation.length, receives: pendingReceives.length, failures: cleanupFailures.length })
                );
                if (cleanupFailures.length > 0 && !primaryFailed) {
                    throw cleanupFailures[0];
                }
            });

            try {
                const snapshot = toOriginDirectedSnapshot(createOriginSnapshot(topology.map(([sessionId]) => sessionId), 1), 'director', Date.now());
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
                    const circuitBreaker = toCircuitBreaker();
                    circuitBreakers.set(sessionId, circuitBreaker);
                    const rateLimiter = toRateLimiter();
                    rateLimiters.set(sessionId, rateLimiter);
                    const resources = createDefaultALOutboundRuntimeResources({
                        decodePrepared: decodeALOutboundTransportMessage,
                        nowMs: Date.now
                    });
                    const manager = new WebRtcOverlayMulticastManager({
                        quotaNow: Date.now,
                        creationNow: Temporal.Now.instant,
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
                                    completedSubjects.add(subject.id.msgId);
                                    receiptAtBySubject.set(subject.id.msgId, Date.now());
                                    receipts.get(subject.id.msgId)!.resolve(settlement);
                                }
                            }
                        },
                        outboundRuntime: resources,
                        circuitBreaker,
                        rateLimiter,
                        faultPort,
                        dequeueResilience: createDefaultALOutboundDequeueResilience()
                    });
                    managers.set(sessionId, manager);

                    const batches = new ALWorkBatchTestObserver();
                    const stores = createDefaultInMemoryALInboundRuntimeStores();
                    const inboundDiagnostics = Object.assign((event: ALInboundRuntimeDiagnosticsEvent) => {
                        inboundEvents.push(event);
                        if (event.kind === 'rtc-ack-ingress') {
                            throw observerFailure;
                        }
                    }, {
                        acknowledgementCapture: { evidence: ALInboundAcknowledgementEvidence, batchObservations: batches.batchObservations }
                    });
                    const streamer = createDefaultWebRtcRxStreamerService({
                        multicast: manager,
                        sessionId,
                        inboundStores: stores,
                        queueEngine: undefined,
                        inboundDiagnostics,
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
                                nativeSubmissionAtByHop.set(key, Date.now());
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

                if (mode === 'relay-quota-exhausted') {
                    // Occupy the relay's whole send quota as concurrent own sends would.
                    const limiter = rateLimiters.get('04')!;
                    for (let token = 0; token < 20; token += 1) {
                        expect(limiter.allow()).toBe(true);
                    }
                    expect(limiter.isAllowedAt(Date.now())).toBe(false);
                }
                const admitted = await Promise.all(messages.map((message) => managers.get(message.id.senderId)!.enqueueIfAbsent(message)));
                for (const admission of admitted) {
                    expect(admission.verdict, admission.reason).toMatchObject({ kind: 'admitted' });
                }
                const business = await Promise.all([...deliveries.values()].map((waiter) => waiter.promise));
                const completed = await Promise.all([...receipts.values()].map((waiter) => waiter.promise));
                const ackFrames = await Promise.all([...frames.values()].map((waiter) => waiter.promise));
                await Promise.all([...arrivals.values()].map((waiter) => waiter.promise));
                expect(delivered.get('director')!.map((message) => message.id.msgId).toSorted()).toEqual(
                    messages.map((message) => message.id.msgId).toSorted()
                );
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
                        carrier: 'rtc',
                        // Every hop's ACK travels under the trace of the message it acknowledges.
                        traceId: hop.traceId,
                        corrId: ack.id.msgId
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
                            [hop.fromPeerId, outbound.get(hop.fromPeerId)!, {
                                kind: 'rtc-ack-submission',
                                ...identity,
                                status: 'sent',
                                submissionAttempted: true
                            }],
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
                    'RTC ACK independent semantic/frame proof',
                    JSON.stringify({
                        mode,
                        forwardedNativeSubmissionAtMs: nativeSubmissionAtByHop.get(`${relayed.id.msgId}/04/03`),
                        originReceiptAtMs: receiptAtBySubject.get(relayed.id.msgId),
                        completedAtMs: Date.now(),
                        witnesses,
                        receipts: completed.map((receipt) => ({ kind: receipt.kind, msgId: receipt.msgId })),
                        missing
                    })
                );
                expect(missing, 'Exact ACK boundary observations must exist after independent business, origin, native-frame and registered-receive success')
                    .toEqual([]);
                // The relay hands its ACK controls off whatever its own-send quota holds.
                expect(outbound.get('04')!.filter((event) => event.kind === 'rtc-handoff-refusal')).toEqual([]);
                expect(rateLimiters.get('04')!.isAllowedAt(Date.now())).toBe(mode === 'healthy');
            }
            catch (caught) {
                primaryFailed = true;
                throw caught;
            }
        }
    );
});
