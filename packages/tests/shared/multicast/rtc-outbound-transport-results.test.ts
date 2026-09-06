import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QRtcDataChannel, type RtcDataChannelFlowControlPolicy } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { installNativeRtcRuntime, type NativeRtcRuntime } from '../native-rtc-connection-fixture.ts';

let nativeRuntime: NativeRtcRuntime;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    nativeRuntime = installNativeRtcRuntime();
});

afterEach(() => {
    nativeRuntime.dispose();
    vi.useRealTimers();
});

describe('RTC outbound transport results', () => {
    it('retains queued send work until submission without blocking an available peer', async () => {
        const blocked = createChannel({ overflow: 'queue' });
        const available = createChannel({}, 'peer-2');
        const blockedNative = nativeRuntime.createdConnections[0].channels[0];
        const availableNative = nativeRuntime.createdConnections[1].channels[0];
        await blockedNative.open();
        await availableNative.open();
        blockedNative.bufferedAmount = 128 * 1024;
        const resources = createDefaultALOutboundRuntimeResources();
        const manager = createManager([blocked, available], resources);
        onTestFinished(() => manager.dispose());
        const queuedMessage = createMessage('queued-owner');

        await manager.enqueueIfAbsent(queuedMessage);
        await manager.enqueueIfAbsent(createMessage('available', 'peer-2'));

        expect(blockedNative.sent).toEqual([]);
        expect(availableNative.sent).toHaveLength(1);
        expect(await resources.admissionStore.peekNextEffectReadyAt()).toBeDefined();
        blockedNative.bufferedAmount = 0;
        await blockedNative.drain();
        await vi.advanceTimersByTimeAsync(0);
        expect(JSON.parse(String(blockedNative.sent[0]))).toMatchObject({ id: queuedMessage.id });
        expect(await resources.admissionStore.peekNextEffectReadyAt()).toBeUndefined();
    });

    it('retries the same owned message when a retained native send closes before submission', async () => {
        const channel = createChannel({ overflow: 'queue' });
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        native.bufferedAmount = 128 * 1024;
        const resources = createDefaultALOutboundRuntimeResources();
        const manager = createManager([channel], resources);
        onTestFinished(() => manager.dispose());
        const message = createMessage('queued-close');
        await manager.enqueueIfAbsent(message);

        await native.close();
        await vi.advanceTimersByTimeAsync(0);
        expect(await resources.admissionStore.peekNextEffectReadyAt()).toBe(Date.now() + 50);
        channel.connect(true);
        const replacement = nativeRuntime.createdConnections[0].channels[1];
        await replacement.open();
        await vi.advanceTimersByTimeAsync(50);

        expect(native.sent).toEqual([]);
        expect(replacement.sent).toHaveLength(1);
        expect(JSON.parse(String(replacement.sent[0]))).toMatchObject({ id: message.id });
        expect(await resources.admissionStore.peekNextEffectReadyAt()).toBeUndefined();
    });

    it('expires a native attempt at its lease boundary while retaining the original message deadline for retry', async () => {
        const channel = createChannel({ overflow: 'queue' });
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        native.bufferedAmount = 128 * 1024;
        const engine = new InboxOutboxEngine();
        const resources = createDefaultALOutboundRuntimeResources({ queueEngine: engine });
        const manager = createManager([channel], resources);
        onTestFinished(() => manager.dispose());
        const message = createMessage('attempt-lease', 'peer-1', 30_000);
        await manager.enqueueIfAbsent(message);

        const leaseAt = await resources.admissionStore.peekNextEffectReadyAt();
        expect(leaseAt).toBeGreaterThanOrEqual(Date.now() + 10_000);
        expect(leaseAt).toBeLessThanOrEqual(Date.now() + 10_001);
        await vi.advanceTimersByTimeAsync(leaseAt! - Date.now());
        expect(channel.readHealth().queuedItemCount).toBe(0);
        expect(native.sent).toEqual([]);
        native.bufferedAmount = 0;
        await vi.advanceTimersByTimeAsync(50);
        await engine.executeOnce();
        await vi.advanceTimersByTimeAsync(0);

        expect(native.sent).toHaveLength(1);
        expect(JSON.parse(String(native.sent[0]))).toMatchObject({ id: message.id, constraints: message.constraints });
        expect(await resources.admissionStore.peekNextEffectReadyAt()).toBeUndefined();
    });

    it('releases native queued work when the ALM owner is disposed', async () => {
        const channel = createChannel({ overflow: 'queue' });
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        native.bufferedAmount = 128 * 1024;
        const manager = createManager([channel], createDefaultALOutboundRuntimeResources());
        onTestFinished(() => manager.dispose());

        await manager.enqueueIfAbsent(createMessage('dispose-retained'));
        expect(channel.readHealth().queuedItemCount).toBe(1);
        manager.dispose();
        expect(channel.readHealth().queuedItemCount).toBe(0);
        native.bufferedAmount = 0;
        await native.drain();
        expect(native.sent).toEqual([]);
    });

    it('applies the ALM deadline while work remains in the native queue', async () => {
        const channel = createChannel({ overflow: 'queue' });
        const native = nativeRuntime.createdConnections[0].channels[0];
        await native.open();
        native.bufferedAmount = 128 * 1024;
        const manager = createManager([channel], createDefaultALOutboundRuntimeResources());
        onTestFinished(() => manager.dispose());
        await manager.enqueueIfAbsent(createMessage('expire-retained'));

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
        const resources = createDefaultALOutboundRuntimeResources();
        const manager = createManager([channel], resources);
        onTestFinished(() => manager.dispose());
        const message = createMessage('backpressure');

        await manager.enqueueIfAbsent(message);

        expect(native.sent).toEqual([]);
        expect(await resources.admissionStore.peekNextEffectReadyAt())
            .toBe(Date.now() + 50);

        native.bufferedAmount = 0;
        await vi.advanceTimersByTimeAsync(50);
        expect(native.sent).toHaveLength(1);
        expect(JSON.parse(String(native.sent[0]))).toMatchObject({ id: message.id });
        expect(await resources.admissionStore.peekNextEffectReadyAt())
            .toBeUndefined();
    });

    it('reports admission without claiming a transport send while the channel is closed', async () => {
        const channel = createChannel();
        const resources = createDefaultALOutboundRuntimeResources();
        const manager = createManager([channel], resources);
        onTestFinished(() => manager.dispose());

        const result = await manager.enqueueIfAbsent(createMessage('connecting'));

        expect(result.status).toBe('accepted');
        expect(nativeRuntime.createdConnections[0].channels[0].sent).toEqual([]);
    });
});

function createChannel(flowControl: RtcDataChannelFlowControlPolicy = {}, peerId = 'peer-1'): QRtcDataChannel {
    const peer = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'self',
        peerSessionId: peerId,
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        isPolite: false
    });
    peer.connect();
    const channel = new QRtcDataChannel(peer, { peerId, dataChannelName: 'alm', flowControl });
    channel.connect(true);
    onTestFinished(() => {
        peer.reset();
    });
    return channel;
}

function createManager(
    channels: readonly QRtcDataChannel[],
    resources: ALOutboundMessageRuntime.Resources
): WebRtcOverlayMulticastManager {
    return new WebRtcOverlayMulticastManager({
        outbox: new InMemoryQueueBox(),
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
        qosProvider: undefined,
        outboundDiagnostics: undefined,
        outboundRuntime: resources,
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter()
    });
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
