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
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALInboundAcknowledgementEvidence } from '@shared/alm/inbound/control/al-inbound-acknowledgement-evidence.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundMessageRuntime, ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage, type ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType, type OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toCircuitBreaker, type CircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter, type RateLimiter } from '@shared/resilience/Resilience.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    createDefaultWebRtcRxStreamerService,
    WebRtcRxStreamerService
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

interface ControlWorkTransition {
    readonly status: EntityStatus;
    readonly attempts: number;
    readonly releasedAtMs: number;
    readonly retryAtMs: number | null;
}

describe('exact RTC ACK boundary observations', () => {
    it.each(['healthy', 'quota-recovery', 'quota-due-time'] as const)(
        'joins automatic director and relayed ACKs to native submission and registered ingress despite throwing observers (%s)',
        async (mode) => {
            vi.useRealTimers();
            let quotaNowMs = 1791883286866;
            if (mode !== 'healthy') {
                vi.spyOn(Date, 'now').mockImplementation(() => quotaNowMs);
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
            const completedSubjects = new Set<string>();
            const controlTransitions: ControlWorkTransition[] = [];
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
            const inboundStores = new Map<string, ALInboundRuntimeStores>();
            const outboundResources = new Map<string, ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>>();
            const batchObservers = new Map<string, ALWorkBatchTestObserver>();
            const circuitBreakers = new Map<string, CircuitBreaker>();
            const rateLimiters = new Map<string, RateLimiter>();
            const engines = new Map<string, InboxOutboxEngine>();
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
                const outcomes = await Promise.allSettled([...cancellation, ...pendingReceives, ...[...engines.values()].map((engine) => engine.stop())]);
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
                    const circuitBreaker = toCircuitBreaker();
                    circuitBreakers.set(sessionId, circuitBreaker);
                    const rateLimiter = toRateLimiter();
                    rateLimiters.set(sessionId, rateLimiter);
                    const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
                    outboundResources.set(sessionId, resources);
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
                    const stores = createDefaultInMemoryALInboundRuntimeStores();
                    inboundStores.set(sessionId, stores);
                    const batches = new ALWorkBatchTestObserver();
                    batchObservers.set(sessionId, batches);
                    const engine = sessionId === '04' && mode !== 'healthy' ? new InboxOutboxEngine() : undefined;
                    if (engine) {
                        engines.set(sessionId, engine);
                    }
                    const inboundDiagnostics = Object.assign((event: ALInboundRuntimeDiagnosticsEvent) => {
                        inboundEvents.push(event);
                        if (event.kind === 'rtc-ack-ingress') {
                            throw observerFailure;
                        }
                    }, {
                        acknowledgementCapture: { evidence: ALInboundAcknowledgementEvidence, batchObservations: batches.batchObservations }
                    });
                    const streamerInput: WebRtcRxStreamerService.Input = {
                        multicast: manager,
                        sessionId,
                        inboundStores: stores,
                        queueEngine: engine,
                        inboundDiagnostics,
                        nowEpochMs: Date.now,
                        heartbeat: { maxMissedPings: 5, pingFrequencyMsecs: 5000 }
                    };
                    const streamer = sessionId === '04' && mode === 'quota-due-time'
                        ? new WebRtcRxStreamerService({
                            multicast: manager,
                            sessionId,
                            inboundRuntime: createDefaultALInboundRuntimeResources({
                                stores,
                                queueEngine: engine,
                                selfPeerId: sessionId,
                                toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.RTC_INBOX),
                                random: () => 0.5
                            }),
                            epochNow: Date.now,
                            heartbeat: { maxMissedPings: 5, pingFrequencyMsecs: 5000 },
                            roomAuthorityRefresh: undefined,
                            inboundDiagnostics,
                            onResyncRequired: undefined
                        })
                        : createDefaultWebRtcRxStreamerService(streamerInput);
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

                const quotaStartedAtMs = Date.now();
                if (mode !== 'healthy') {
                    const limiter = rateLimiters.get('04')!;
                    // Occupy the real default quota as concurrent traffic would; every handoff below remains production-owned.
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
                if (mode !== 'healthy') {
                    // The direct subject completes while the other subject's forwarded ACK remains replayable.
                    expect(await receipts.get(direct.id.msgId)!.promise).toMatchObject({ complete: true });
                    await arrivals.get(`${relayed.id.msgId}/02/04`)!.promise;
                    await batchObservers.get('04')!.waitForPublishedBatches();
                    const stores = inboundStores.get('04')!;
                    const controls = await readForwardedControlWork(stores, relayed.id.msgId);
                    expect(controls).toHaveLength(1);
                    let retrying = controls[0]!;
                    expect(retrying).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
                    expect(Number(retrying.dequeueAudit.nextTs!.epochMilliseconds) - quotaStartedAtMs).toBe(1);
                    controlTransitions.push(toControlWorkTransition(retrying));
                    expect(completedSubjects.has(relayed.id.msgId)).toBe(false);
                    const work = decodeALInboundWorkEntry(retrying, stores.admissionStore.namespace);
                    expect(work.payload.kind).toBe('send-control');
                    if (work.payload.kind !== 'send-control') {
                        throw new Error('Expected the forwarded ACK control work');
                    }
                    const control = work.payload.msg;
                    expect(parseALControlMessage(control)).toMatchObject({
                        type: 'ack',
                        payload: {
                            ackedMsgId: relayed.id.msgId,
                            originPeerId: '03',
                            logicalRecipientPeerId: 'director',
                            fromPeerId: '04',
                            toPeerId: '03',
                            status: 'forwarded'
                        }
                    });
                    expect(await outboundResources.get('04')!.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(false);
                    expect(natives.get('04/03')!.sent.map((frame) => decodePersistedALMessageValue(JSON.parse(String(frame))).id))
                        .not.toContainEqual(control.id);
                    const engine = engines.get('04')!;
                    for (
                        const [attempt, minDelayMs, maxDelayMs, centeredDelayMs] of [[2, 2, 2, 2], [3, 3, 5, 4], [4, 6, 10, 8], [5, 13, 19, 16], [
                            6,
                            800,
                            1200,
                            1000
                        ]] as const
                    ) {
                        const dueAtMs = Number(retrying.dequeueAudit.nextTs!.epochMilliseconds);
                        quotaNowMs = dueAtMs;
                        await expect.poll(async () => {
                            await engine.executeOnce();
                            await batchObservers.get('04')!.waitForPublishedBatches();
                            await engine.stop();
                            retrying = (await stores.workQueue.getItem(retrying.key))!;
                            return retrying.dequeueAudit.attempts;
                        }).toBe(attempt);
                        expect(retrying).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: attempt } });
                        controlTransitions.push(toControlWorkTransition(retrying));
                        const delayMs = Number(retrying.dequeueAudit.nextTs!.epochMilliseconds) - dueAtMs;
                        expect(delayMs).toBeGreaterThanOrEqual(minDelayMs);
                        expect(delayMs).toBeLessThanOrEqual(maxDelayMs);
                        if (mode === 'quota-due-time') {
                            expect(delayMs).toBe(centeredDelayMs);
                        }
                        expect(circuitBreakers.get('04')!.isClosed()).toBe(true);
                        expect(completedSubjects.has(relayed.id.msgId)).toBe(false);
                        expect(await outboundResources.get('04')!.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(false);
                        expect(natives.get('04/03')!.sent.map((frame) => decodePersistedALMessageValue(JSON.parse(String(frame))).id))
                            .not.toContainEqual(control.id);
                    }
                    // The default nominal 1,000 ms limiter includes one overlapping 250 ms bucket at its edge.
                    expect(rateLimiters.get('04')!.isAllowedAt(quotaStartedAtMs + 1250)).toBe(false);
                    expect(rateLimiters.get('04')!.isAllowedAt(quotaStartedAtMs + 1251)).toBe(true);
                    if (mode === 'quota-due-time') {
                        quotaNowMs = Number(retrying.dequeueAudit.nextTs!.epochMilliseconds);
                        expect(quotaNowMs - quotaStartedAtMs).toBe(1031);
                        await expect.poll(async () => {
                            await engine.executeOnce();
                            await batchObservers.get('04')!.waitForPublishedBatches();
                            await engine.stop();
                            retrying = (await stores.workQueue.getItem(retrying.key))!;
                            return retrying.dequeueAudit.attempts;
                        }).toBe(7);
                        expect(retrying.status).toBe(EntityStatus.RETRY);
                        controlTransitions.push(toControlWorkTransition(retrying));
                        expect(Number(retrying.dequeueAudit.nextTs!.epochMilliseconds) - quotaNowMs).toBe(2000);
                        expect(circuitBreakers.get('04')!.isClosed()).toBe(true);
                        expect(completedSubjects.has(relayed.id.msgId)).toBe(false);
                        expect(await outboundResources.get('04')!.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(false);
                        expect(natives.get('04/03')!.sent.map((frame) => decodePersistedALMessageValue(JSON.parse(String(frame))).id))
                            .not.toContainEqual(control.id);
                        quotaNowMs = Number(retrying.dequeueAudit.nextTs!.epochMilliseconds);
                        expect(quotaNowMs - quotaStartedAtMs).toBe(3031);
                    }
                    else {
                        quotaNowMs = quotaStartedAtMs + 1251;
                    }
                    await expect.poll(async () => {
                        await engine.executeOnce();
                        await batchObservers.get('04')!.waitForPublishedBatches();
                        await engine.stop();
                        retrying = (await stores.workQueue.getItem(retrying.key))!;
                        return retrying.status;
                    }).toBe(EntityStatus.COMPLETED);
                    expect(retrying).toMatchObject({
                        status: EntityStatus.COMPLETED,
                        dequeueAudit: { attempts: mode === 'quota-due-time' ? 8 : 7 }
                    });
                    controlTransitions.push(toControlWorkTransition(retrying));
                    expect(decodeALInboundWorkEntry(retrying, stores.admissionStore.namespace).payload).toEqual(work.payload);
                    expect(circuitBreakers.get('04')!.isClosed()).toBe(true);
                    expect(await outboundResources.get('04')!.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(true);
                    const frame = await frames.get(`${relayed.id.msgId}/04/03`)!.promise;
                    expect(frame.id).toEqual(control.id);
                    expect(frame.payload).toEqual(control.payload);
                    expect(frame.route).toEqual(control.route);
                    expect(nativeSubmissionAtByHop.get(`${relayed.id.msgId}/04/03`)).toBe(quotaNowMs);
                }
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
                        controlTransitions,
                        quotaStartedAtMs: mode === 'healthy' ? null : quotaStartedAtMs,
                        earliestQuotaEligibleAtMs: mode === 'healthy' ? null : quotaStartedAtMs + 1251,
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
            }
            catch (caught) {
                primaryFailed = true;
                throw caught;
            }
        }
    );
});

function toControlWorkTransition(entry: ResourceEntry): ControlWorkTransition {
    return {
        status: entry.status,
        attempts: entry.dequeueAudit.attempts,
        releasedAtMs: Number(entry.dequeueAudit.endTs!.epochMilliseconds),
        retryAtMs: entry.dequeueAudit.nextTs === undefined ? null : Number(entry.dequeueAudit.nextTs.epochMilliseconds)
    };
}

async function readForwardedControlWork(stores: ALInboundRuntimeStores, subjectMsgId: string): Promise<readonly ResourceEntry[]> {
    const page = await stores.workQueue.readWorkPage({
        typeId: toALInboundWorkType(stores.admissionStore.namespace, 'rtc'),
        status: EntityStatus.RETRY,
        maxToRead: 10,
        cursor: null
    });
    return page.entries.filter((entry) => {
        const effect = decodeALInboundWorkEntry(entry, stores.admissionStore.namespace);
        const control = effect.payload.kind === 'send-control' ? parseALControlMessage(effect.payload.msg) : undefined;
        return control?.type === 'ack' && control.payload.ackedMsgId === subjectMsgId &&
            control.payload.logicalRecipientPeerId === 'director' && control.payload.status === 'forwarded';
    });
}
