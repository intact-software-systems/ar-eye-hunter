import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { DeterministicRtcOfferIds } from './deterministic-rtc-offer-ids.ts';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createDefaultInMemoryALInboundRuntimeStores, createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { setNextInboundCommitConflicted } from '../alm/inbound-runtime-test-fixture.ts';
import { installNativeRtcRuntime } from '../native-rtc-connection-fixture.ts';
import { TestWebSocket } from '../websocket/test-web-socket.ts';

afterEach(() => {
    TestWebSocket.instances.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('settles an answer delayed by admission conflict without applying it to a replacement offer', async () => {
    const nativeRuntime = installNativeRtcRuntime();
    vi.stubGlobal('WebSocket', TestWebSocket);
    const queueEngine = new InboxOutboxEngine();
    const inboundStores = createDefaultInMemoryALInboundRuntimeStores({ namespace: 'rtc-delayed-answer' });
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        namespace: 'rtc-delayed-answer',
        decodePrepared: decodeALOutboundTransportMessage
    });
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const socketClient = new JsonWebSocketClient('ws://signaling-test', createPassThroughTransportFaultPort());
    const queueBoxClient = createDefaultWsQueueBoxClientService({
        queueEngine,
        socket: socketClient,
        outbox: new InMemoryQueueBox(),
        sessionId: 'receiver',
        inboundStores,
        outboundStores,
        inboundDiagnostics: (event) => diagnostics.push(event)
    }).enableDefaultCallbacks();
    const connectionService = new WebRtcConnectionService(new WsRtcSignalingTransportUsingWsQBox(queueBoxClient, 'rtc'), {
        sessionId: 'receiver',
        token: 'test-token',
        dataChannelName: 'room',
        faultPort: createPassThroughTransportFaultPort(),
        rtcSignalingTopicId: 'rtc',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 }
    }, new DeterministicRtcOfferIds());
    const blockerStarted = Promise.withResolvers<void>();
    const releaseBlocker = Promise.withResolvers<void>();
    queueBoxClient.onInboxMessageDo('blocker', {
        onMessage: async () => {
            blockerStarted.resolve();
            await releaseBlocker.promise;
        }
    });
    onTestFinished(() => {
        releaseBlocker.resolve();
        connectionService.removePeerIfPresent('sender');
        queueBoxClient.close();
        queueEngine.stop();
        nativeRuntime.dispose();
    });
    queueEngine.start();
    const connecting = connectionService.connectSignaler();
    await Promise.resolve();
    const socket = TestWebSocket.instances.at(-1);
    if (!socket) {
        throw new Error('Expected signaling socket');
    }
    socket.open();
    await connecting;
    connectionService.ensurePeerConnectionStarted('sender', true);
    const oldNative = nativeRuntime.createdConnections[0];
    await oldNative.onnegotiationneeded?.call(oldNative, new Event('negotiationneeded'));
    socket.receive(JSON.stringify(newALUnicastMessage('sender', newALEventRoute('blocker', 'receiver'), 'receiver', 'blocker', null)));
    await blockerStarted.promise;
    setNextInboundCommitConflicted(inboundStores.admissionStore);
    socket.receive(toAnswerEnvelope('delayed-answer', 'old-answer', 'offer-1'));
    await vi.waitFor(() =>
        expect(diagnostics).toContainEqual(expect.objectContaining({
            kind: 'admission-outcome',
            msgId: 'delayed-answer',
            outcome: 'pending',
            reason: 'pending-admission'
        }))
    );
    expect(oldNative.receivedDescriptions).toEqual([]);
    connectionService.removePeerIfPresent('sender', { resetAttemptBudget: false });
    connectionService.ensurePeerConnectionStarted('sender', true);
    const replacement = nativeRuntime.createdConnections[1];
    await replacement.onnegotiationneeded?.call(replacement, new Event('negotiationneeded'));
    releaseBlocker.resolve();
    await vi.waitFor(() =>
        expect(diagnostics).toContainEqual(expect.objectContaining({
            kind: 'claim-settled',
            msgId: 'delayed-answer',
            payloadKind: 'dispatch-local',
            outcome: 'completed'
        }))
    );
    expect(replacement.receivedDescriptions).toEqual([]);
    expect(replacement.signalingState).toBe('have-local-offer');
    socket.receive(toAnswerEnvelope('current-answer', 'matching-answer', 'offer-2'));
    await vi.waitFor(() => expect(replacement.receivedDescriptions).toEqual([{ type: 'answer', sdp: 'matching-answer' }]));
    expect(oldNative.receivedDescriptions).toEqual([]);
});

function toAnswerEnvelope(messageId: string, sdp: string, offerId: string): string {
    const message = newALUnicastMessage('sender', newALEventRoute('rtc', 'receiver'), 'receiver', 'rtc', {
        channel: 'RtcSignal',
        type: 'Signal',
        fromId: 'sender',
        toId: 'receiver',
        sessionId: 'sender',
        token: 'test-token',
        signalType: 'Answer',
        offerId,
        payload: { description: { type: 'answer', sdp }, candidate: null }
    });
    return JSON.stringify({ ...message, id: { ...message.id, msgId: messageId } });
}
