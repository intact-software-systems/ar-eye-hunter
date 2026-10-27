import { Temporal } from '@js-temporal/polyfill';
import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement, ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult, ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RtcOutboundSubmission } from '@shared/multicast/rtc-outbound-submission.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import type { QueueBoxResourceEntryRepository, ResourceInboxReleaseDisposition } from '@shared/queuebox/queue-box-types.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/rate-limiter.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import {
    createPassThroughTransportFaultPort,
    createScriptedTransportFaultPort,
    type TransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcDataChannel, type RtcDataChannelFlowControlPolicy } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import {
    createOutboundRuntimeWithWorkTask,
    peekOutboundWorkReadyAt,
    runOutboundWorkTask
} from '../alm/outbound-runtime-test-fixture.ts';
import { installNativeRtcRuntime, type NativeRtcRuntime } from '../native-rtc-connection-fixture.ts';
import { DeterministicRtcOfferIds } from '../webrtc/deterministic-rtc-offer-ids.ts';
import { TestWebSocket } from '../websocket/test-web-socket.ts';

interface RtcTransportManagerOptions {
    readonly qosProvider?: ALQosInputProvider;
    readonly settlements?: ALDeliverySettlementSink;
}

let nativeRuntime: NativeRtcRuntime;
let settlements: ALDeliverySettlement[] = [];

beforeEach(() => {
    onTestFinished(() => {
        vi.useRealTimers();
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const acquiredRuntime = installNativeRtcRuntime();
    onTestFinished(() => acquiredRuntime.dispose());
    nativeRuntime = acquiredRuntime;
    settlements = [];
});

describe('RTC outbound transport results', () => {
    it('selects first-admission freshness from a caller TTL and reuses that canonical envelope through real WS fallback', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const storesFor = (namespace: string) =>
            createDefaultInMemoryALOutboundRuntimeStores({
                namespace,
                canonicalScope: 'browser-session:self',
                outboundBackend: backend,
                decodePrepared: decodeALOutboundTransportMessage
            });
        const channel = createChannel();
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        const rtcStores = storesFor('self:rtc');
        const manager = createManager(
            [channel],
            createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage, stores: rtcStores }),
            {
                qosProvider: { defaultsForMessage: () => ({ expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 500 } } }) }
            }
        );
        const socket = new JsonWebSocketClient('ws://canonical-fallback', createPassThroughTransportFaultPort());
        const nativeWs = new TestWebSocket(socket.url);
        nativeWs.open();
        socket.ws = nativeWs;
        const ws = createOutboundRuntimeWithWorkTask(() =>
            createDefaultWsQueueBoxClientService({
                outbox: backend.workQueue,
                socket,
                sessionId: 'self',
                serverPeerId: 'server',
                outboundStores: storesFor('self:ws'),
                qosProvider: { capabilitiesForMessage: () => ({ supportedExpiry: ['ttl-only'] }) }
            })
        );
        onTestFinished(() => ws.close());
        const original = createMessage('fallback', 'peer-1', 5_000);
        const first = await enqueueRtcAndDrain(manager, original);
        expect(first.verdict, first.reason).toMatchObject({ kind: 'admitted', durable: false });
        expect(first.message.constraints?.expiresAtMs).toBe(Date.now() + 500);
        expect(original.constraints?.expiresAtMs).toBe(Date.now() + 5_000);
        const fallback = await ws.enqueueOutboxIfAbsent(first.message);
        await runOutboundWorkTask(ws);
        expect(fallback.entry?.key).toEqual(first.entry?.key);
        expect(fallback.message).toEqual(first.message);
        expect(JSON.parse(nativeWs.sent[0])).toEqual(JSON.parse(JSON.stringify(first.message)));
        expect(JSON.parse(String(native.sent[0])).constraints.expiresAtMs).toBe(Date.now() + 500);
        const rows = await Promise.all((await backend.workQueue.getAllKeys()).map((key) => backend.workQueue.getItem(key)));
        expect(rows.filter((row) => row?.resource.includes('hello'))).toHaveLength(1);
        for (
            const changed of [
                { ...first.message, payload: { ...first.message.payload, resource: '{"text":"changed"}' } },
                { ...first.message, route: { ...first.message.route, contextId: 'changed' } },
                { ...first.message, id: { ...first.message.id, traceId: 'changed' } },
                { ...first.message, constraints: { ...first.message.constraints, expiresAtMs: Date.now() + 501 } }
            ]
        ) {
            await expect(ws.enqueueOutboxIfAbsent(changed)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        }
    });

    it('waits through more readiness cycles than the processing budget and sends when the actual channel opens', async () => {
        const channel = createChannel();
        const native = nativeRuntime.createdConnections[0].channels[0];
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
        const manager = createManager([channel], resources);
        const message = createMessage('long-readiness');
        await enqueueRtcAndDrain(manager, message);
        await vi.advanceTimersByTimeAsync(1_250);
        expect(native.sent).toEqual([]);
        await native.open();
        await vi.advanceTimersByTimeAsync(50);
        expect(native.sent).toHaveLength(1);
        expect(JSON.parse(String(native.sent[0]))).toMatchObject({ id: message.id, constraints: message.constraints });
        expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace)).toBeUndefined();
    });
    it('retains queued send work until submission without blocking an available peer', async () => {
        const blocked = createChannel({ overflow: 'queue' });
        const available = createChannel({}, 'peer-2');
        const blockedNative = nativeRuntime.createdConnections[0].channels[0];
        const availableNative = nativeRuntime.createdConnections[1].channels[0];
        await blockedNative.open();
        await availableNative.open();
        blockedNative.bufferedAmount = 128 * 1024;
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
        const manager = createManager([blocked, available], resources);
        const queuedMessage = createMessage('queued-owner');

        await enqueueRtcAndDrain(manager, queuedMessage);
        await enqueueRtcAndDrain(manager, createMessage('available', 'peer-2'));

        expect(blockedNative.sent).toEqual([]);
        expect(availableNative.sent).toHaveLength(1);
        expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace)).toBeDefined();
        const released = readRtcWorkRelease(resources.workQueue, 'COMPLETED');
        blockedNative.bufferedAmount = 0;
        await blockedNative.drain();
        await released;
        expect(JSON.parse(String(blockedNative.sent[0]))).toMatchObject({ id: queuedMessage.id });
        expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace)).toBeUndefined();
    });

    it('retries the same owned message when a retained native send closes before submission', async () => {
        const channel = createChannel({ overflow: 'queue' });
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        native.bufferedAmount = 128 * 1024;
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
        const manager = createManager([channel], resources);
        const message = createMessage('queued-close');
        await enqueueRtcAndDrain(manager, message);

        const released = readRtcWorkRelease(resources.workQueue, 'RETRY');
        await native.close();
        await released;
        expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace)).toBe(Date.now() + 50);
        channel.connect(true);
        const replacement = nativeRuntime.createdConnections[0].channels[1];
        await replacement.open();
        await vi.advanceTimersByTimeAsync(50);

        expect(native.sent).toEqual([]);
        expect(replacement.sent).toHaveLength(1);
        expect(JSON.parse(String(replacement.sent[0]))).toMatchObject({ id: message.id });
        expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace)).toBeUndefined();
    });

    it('expires a native attempt at its lease boundary while retaining the original message deadline for retry', async () => {
        const channel = createChannel({ overflow: 'queue' });
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        native.bufferedAmount = 128 * 1024;
        const engine = new InboxOutboxEngine();
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage, queueEngine: engine });
        const manager = createManager([channel], resources);
        const message = createMessage('attempt-lease', 'peer-1', 30_000);
        await enqueueRtcAndDrain(manager, message);

        const leaseAt = await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace);
        expect(leaseAt).toBeGreaterThanOrEqual(Date.now() + 10_000);
        expect(leaseAt).toBeLessThanOrEqual(Date.now() + 10_001);
        await vi.advanceTimersByTimeAsync(leaseAt! - Date.now());
        expect(channel.readHealth().queuedItemCount).toBe(0);
        expect(native.sent).toEqual([]);
        native.bufferedAmount = 0;
        await vi.advanceTimersByTimeAsync(50);
        await engine.executeOnce();
        await engine.stop();

        expect(native.sent).toHaveLength(1);
        expect(JSON.parse(String(native.sent[0]))).toMatchObject({ id: message.id, constraints: message.constraints });
        expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace)).toBeUndefined();
    });

    it('releases native queued work when the ALM owner is disposed', async () => {
        const channel = createChannel({ overflow: 'queue' });
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        native.bufferedAmount = 128 * 1024;
        const manager = createManager([channel], createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }));

        await enqueueRtcAndDrain(manager, createMessage('dispose-retained'));
        expect(channel.readHealth().queuedItemCount).toBe(1);
        const disposing = manager.dispose();
        expect(channel.readHealth().queuedItemCount).toBe(0);
        native.bufferedAmount = 0;
        await native.drain();
        await disposing;
        expect(native.sent).toEqual([]);
    });

    it('applies the ALM deadline while work remains in the native queue', async () => {
        const channel = createChannel({ overflow: 'queue' });
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        native.bufferedAmount = 128 * 1024;
        const manager = createManager([channel], createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }));
        await enqueueRtcAndDrain(manager, createMessage('expire-retained'));

        await vi.advanceTimersByTimeAsync(5_000);
        expect(channel.readHealth().queuedItemCount).toBe(0);
        native.bufferedAmount = 0;
        await native.drain();
        expect(native.sent).toEqual([]);
    });

    it('keeps backpressured work available for retry and sends the same logical message when pressure clears', async () => {
        const channel = createChannel();
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        native.bufferedAmount = 128 * 1024;
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
        const manager = createManager([channel], resources);
        const message = createMessage('backpressure');

        await enqueueRtcAndDrain(manager, message);

        expect(native.sent).toEqual([]);
        expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace))
            .toBe(Date.now() + 50);

        native.bufferedAmount = 0;
        await vi.advanceTimersByTimeAsync(50);
        expect(native.sent).toHaveLength(1);
        expect(JSON.parse(String(native.sent[0]))).toMatchObject({ id: message.id });
        expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace))
            .toBeUndefined();
    });

    it('carries the native submission fact from the channel into the attempt it settles', async () => {
        const channel = createChannel({ overflow: 'queue' });
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
        const manager = createManager([channel], resources);

        await enqueueRtcAndDrain(manager, createMessage('submitted'));

        expect(native.sent).toHaveLength(1);
        expect(attemptSettlements()).toMatchObject([
            { carrier: 'rtc', outcome: 'sent', submissionAttempted: true }
        ]);

        native.bufferedAmount = 128 * 1024;
        await enqueueRtcAndDrain(manager, createMessage('unsubmitted'));
        const released = readRtcWorkRelease(resources.workQueue, 'RETRY');
        await native.close();
        await released;

        expect(attemptSettlements()[1]).toMatchObject({
            carrier: 'rtc',
            outcome: 'not-ready',
            submissionAttempted: false
        });
    });

    it.each(['immediate', 'queued'] as const)(
        'retains truthful attempt evidence and retries the original message after a %s native send throws',
        async (mode) => {
            const channel = createChannel({ overflow: 'queue' });
            const native = nativeRuntime.createdConnections[0].channels[0];
            await native.open();
            if (mode === 'queued') {
                native.bufferedAmount = 128 * 1024;
            }
            const failed = Promise.withResolvers<ALDeliverySettlement>();
            const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
            const released = readRtcWorkRelease(resources.workQueue, 'RETRY');
            const manager = createManager([channel], resources, {
                settlements: (settlement) => {
                    if (settlement.kind === 'attempt-settled' && settlement.outcome === 'failed') {
                        failed.resolve(settlement);
                    }
                }
            });
            const message = createMessage(`native-failure-${mode}`);
            const attempted: string[] = [];
            const nativeFailure = new Error('Native send failed after submission was attempted');
            const send = vi.spyOn(native, 'send').mockImplementation((frame) => {
                attempted.push(String(frame));
                throw nativeFailure;
            });
            onTestFinished(() => send.mockRestore());

            await enqueueRtcAndDrain(manager, message);
            if (mode === 'queued') {
                expect(channel.readHealth().queuedItemCount).toBe(1);
                native.bufferedAmount = 0;
                await native.drain();
            }
            const failedAttempt = await failed.promise;
            expect(failedAttempt).toMatchObject({
                carrier: 'rtc',
                msgId: message.id.msgId,
                outcome: 'failed',
                submissionAttempted: true,
                detail: mode === 'immediate' ? nativeFailure.message : 'Native data channel send failed',
                willRetry: true
            });
            expect(attemptSettlements()).toEqual([failedAttempt]);
            expect(attempted.map((frame) => JSON.parse(frame))).toEqual([
                expect.objectContaining({ id: message.id, constraints: message.constraints })
            ]);
            await released;
            const retryAtMs = await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace);
            expect(retryAtMs).toBe(Date.now() + 1);

            send.mockRestore();
            vi.setSystemTime(retryAtMs!);
            await runOutboundWorkTask(manager);

            expect(native.sent.map((frame) => JSON.parse(String(frame)))).toEqual([
                expect.objectContaining({ id: message.id, constraints: message.constraints })
            ]);
            expect(attemptSettlements()).toMatchObject([
                { msgId: message.id.msgId, outcome: 'failed', submissionAttempted: true, willRetry: true },
                { msgId: message.id.msgId, outcome: 'sent', submissionAttempted: true, willRetry: false }
            ]);
            expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace)).toBeUndefined();
        }
    );

    it.each(['admission-read', 'carrier-preflight'] as const)('leaves %s exceptions unattempted and retries after the original failure', async (stage) => {
        const faultPort = createPassThroughTransportFaultPort();
        const channel = createChannel({}, 'peer-1', faultPort);
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
        const manager = createManager([channel], resources);
        const message = createMessage(`pre-native-${stage}`);
        const failure = new Error('Original pre-native failure');
        const failedPort = stage === 'admission-read'
            ? vi.spyOn(resources.admissionStore, 'readSendGuards').mockRejectedValueOnce(failure)
            : vi.spyOn(faultPort, 'decideSend').mockImplementationOnce(() => {
                throw failure;
            });
        onTestFinished(() => failedPort.mockRestore());

        await enqueueRtcAndDrain(manager, message);

        expect(native.sent).toEqual([]);
        expect(channel.readHealth().queuedItemCount).toBe(0);
        expect(attemptSettlements()).toMatchObject([
            { msgId: message.id.msgId, outcome: 'failed', submissionAttempted: false, detail: failure.message, willRetry: true }
        ]);
        const retryAtMs = await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace);
        expect(retryAtMs).toBe(Date.now() + 1);
        vi.setSystemTime(retryAtMs!);
        await runOutboundWorkTask(manager);

        expect(native.sent.map((frame) => JSON.parse(String(frame)))).toEqual([
            expect.objectContaining({ id: message.id, constraints: message.constraints })
        ]);
        expect(attemptSettlements()).toMatchObject([
            { outcome: 'failed', submissionAttempted: false, willRetry: true },
            { outcome: 'sent', submissionAttempted: true, willRetry: false }
        ]);
        expect(await peekOutboundWorkReadyAt(resources.workQueue, resources.admissionStore.namespace)).toBeUndefined();
    });

    it('preserves the original serialization error when no QR terminal settlement exists', async () => {
        const channel = createChannel();
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        const submission = new RtcOutboundSubmission({
            connectionService: {
                input: { sessionId: 'self' },
                readyPeerIdsForLane: () => ['peer-1'],
                readPeer: () => ({ channel })
            },
            clock: { nowMs: Date.now },
            faultPort: createPassThroughTransportFaultPort(),
            qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, undefined),
            diagnostics: undefined
        });
        const failure = new Error('Original RTC serialization failure');
        const message = {
            ...createMessage('serialization'),
            forwarding: { nextHopPeerIds: ['peer-1'] },
            toJSON: () => {
                throw failure;
            }
        };
        const signal = new AbortController().signal;
        const sending = async () =>
            await submission.send(message, {
                signal,
                expiresAtMs: message.constraints?.expiresAtMs,
                leaseUntilMs: Date.now() + 10_000,
                canonicalMessage: message
            });

        await expect(sending()).rejects.toBe(failure);

        expect(native.sent).toEqual([]);
        expect(channel.readHealth().queuedItemCount).toBe(0);
    });

    it('keeps QR direct callers throwing the original native error while settling the attempted failure once', async () => {
        const channel = createChannel();
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        const failure = new Error('Original QR native send failure');
        const settled = Promise.withResolvers<QRtcDataChannel.SendSettlement>();
        const terminal: QRtcDataChannel.SendSettlement[] = [];
        const send = vi.spyOn(native, 'send').mockImplementation(() => {
            throw failure;
        });
        onTestFinished(() => send.mockRestore());

        try {
            channel.sendJson({ message: 'direct-native-failure' }, {
                onSettled: (value) => {
                    terminal.push(value);
                    settled.resolve(value);
                }
            });
            throw new Error('QR must throw the original native failure');
        }
        catch (caught) {
            expect(caught).toBe(failure);
        }
        const result = await settled.promise;

        expect(terminal).toEqual([result]);
        expect(result).toMatchObject({ status: 'failed', submissionAttempted: true });
        expect(native.sent).toEqual([]);
    });

    it('admits a receiver ack on an RTC unicast and answers a room multicast without room authority no-route', async () => {
        const channel = createChannel();
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
        const manager = createManager([channel], resources);
        const message = { ...createMessage('receiver'), delivery: { reliability: 'at-least-once', ack: 'receiver' } } as const;

        const unicast = await enqueueRtcAndDrain(manager, message);
        const multicast = await enqueueRtcAndDrain(manager, {
            ...message,
            id: { ...message.id, msgId: 'receiver-multicast' },
            targets: { mode: 'multicast', groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' } }
        });

        expect(unicast.verdict).toMatchObject({ kind: 'admitted' });
        expect(multicast.verdict).toMatchObject({ kind: 'unroutable', reason: 'no-route' });
    });

    it('resubmits an ACK a one-shot drop fault dropped, and keeps it on the page only while a held fault is armed', async () => {
        const faults = createScriptedTransportFaultPort();
        const channel = createChannel({}, 'peer-1', faults);
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
        const manager = createManager([channel], resources);
        const dropAck = { faultId: 'drop-ack', carrier: 'rtc', match: { controlType: 'ack', typeId: undefined, msgId: undefined } } as const;

        faults.inject({ ...dropAck, action: 'drop', remaining: 1 });
        await enqueueRtcAndDrain(manager, createAck('once-dropped'));
        expect(native.sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(50);
        expect(native.sent.map((frame) => JSON.parse(String(frame)).id.msgId)).toEqual(['once-dropped']);

        faults.inject({ ...dropAck, action: 'drop', remaining: 'until-cleared' });
        await enqueueRtcAndDrain(manager, createAck('held'));
        await vi.advanceTimersByTimeAsync(500);
        expect(native.sent).toHaveLength(1);
        faults.inject({ ...dropAck, action: 'drop', remaining: 0 });
        await vi.advanceTimersByTimeAsync(50);
        expect(native.sent.map((frame) => JSON.parse(String(frame)).id.msgId)).toEqual(['once-dropped', 'held']);
    });

    it('reports admission without claiming a transport send while the channel is closed', async () => {
        const channel = createChannel();
        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
        const manager = createManager([channel], resources);

        const result = await enqueueRtcAndDrain(manager, createMessage('connecting'));

        expect(result.verdict).toMatchObject({ kind: 'admitted', durable: false });
        expect(nativeRuntime.createdConnections[0].channels[0].sent).toEqual([]);
    });
});

/** Only the attempt outcomes, so a case can read what the carrier said about one send. */
function attemptSettlements(): readonly Extract<ALDeliverySettlement, { kind: 'attempt-settled'; }>[] {
    return settlements.filter((settlement) => settlement.kind === 'attempt-settled');
}

function createChannel(
    flowControl: RtcDataChannelFlowControlPolicy = {},
    peerId = 'peer-1',
    faultPort: TransportFaultPort = createPassThroughTransportFaultPort()
): QRtcDataChannel {
    const peer = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'self',
        peerSessionId: peerId,
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        isPolite: false
    }, new DeterministicRtcOfferIds());
    onTestFinished(() => {
        peer.reset();
    });
    peer.connect();
    const channel = new QRtcDataChannel(peer, { faultPort, peerId, dataChannelName: 'alm', flowControl });
    onTestFinished(() => channel.reset());
    channel.connect(true);
    return channel;
}

function createManager(
    channels: readonly QRtcDataChannel[],
    resources: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>,
    options: RtcTransportManagerOptions = {}
): WebRtcOverlayMulticastManager {
    const manager = createOutboundRuntimeWithWorkTask(() =>
        new WebRtcOverlayMulticastManager({
            quotaNow: Date.now,
            creationNow: Temporal.Now.instant,
            connectionService: {
                input: { sessionId: 'self' },
                readyPeerIdsForLane: () => channels.map((channel) => channel.input.peerId),
                readPeer: (peerId) => {
                    const channel = channels.find((candidate) => candidate.input.peerId === peerId);
                    return channel ? { channel } : undefined;
                }
            },
            groupCache: new LatestRepository(),
            overlayCache: new LatestRepository(),
            multicasterFactory: () => {
                throw new Error('A direct send must not construct a room multicaster');
            },
            qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, options.qosProvider),
            outboundDiagnostics: undefined,
            outboundSettlements: (settlement) => {
                settlements.push(settlement);
                options.settlements?.(settlement);
            },
            outboundRuntime: resources,
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            faultPort: createPassThroughTransportFaultPort(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        })
    );
    onTestFinished(() => manager.dispose());
    return manager;
}

/** Observes the next matching real queue write, so retained settlement is not mistaken for its release. */
function readRtcWorkRelease(
    queue: QueueBoxResourceEntryRepository,
    status: ResourceInboxReleaseDisposition['status']
): Promise<void> {
    const released = Promise.withResolvers<void>();
    const releaseEntries = queue.releaseEntries.bind(queue);
    const observer = vi.spyOn(queue, 'releaseEntries').mockImplementation(async (releases) => {
        const written = await releaseEntries(releases);
        if (releases.some((release) => release.disposition.status === status)) {
            released.resolve();
        }
        return written;
    });
    onTestFinished(() => observer.mockRestore());
    return released.promise;
}

/** Admits a message and runs the one owner batch the admission committed, the way the worker does. */
async function enqueueRtcAndDrain(
    manager: WebRtcOverlayMulticastManager,
    msg: ALMessage
): Promise<ALOutboundEnqueueResult> {
    const result = await manager.enqueueIfAbsent(msg);
    // enqueueIfAbsent's own commit fires the owner's batch without awaiting it; this settles that pass.
    await runOutboundWorkTask(manager);
    return result;
}

function createMessage(resourceId: string, peerId = 'peer-1', ttlMs = 5_000) {
    return newALUnicastMessage(
        'self',
        { topicId: 'chat', resourceId, contextId: 'direct' },
        peerId,
        'chat.message.v1',
        { text: 'hello' },
        { ttlMs, qos: { durability: { algo: 'volatile' } } }
    );
}

function createAck(msgId: string): ALMessage {
    return newALAckControlMessage({ v: 4, msgId, senderId: 'self', ts: Date.now(), traceId: 'trace-rtc-outbound-transport-results' }, {
        ackedMsgId: `${msgId}-acked`,
        fromPeerId: 'self',
        toPeerId: 'peer-1',
        originPeerId: 'peer-1',
        logicalRecipientPeerId: 'self',
        carrier: 'rtc',
        status: 'delivered',
        observedAtEpochMs: Date.now()
    });
}
