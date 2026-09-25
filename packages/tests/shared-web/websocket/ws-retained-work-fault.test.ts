import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { computeAlmConformanceQosDefaults } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/compute-alm-conformance-qos-defaults.ts';
import {
    configureBrowserALRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import { newALMulticastMessage, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import * as auth from '@shared/api/auth.ts';
import { configureGroupStateSnapshotRepository, setGroupStateSnapshot } from '@shared/repository/group-state-snapshots-repository.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { captureOutboundWorkRunnable } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

describe('WS retained-work faults', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', TestWebSocket);
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('supersedes held work through the real configured QoS normalizer and submits only its replacement', async () => {
        const sessionId = crypto.randomUUID();
        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
        const faults = createScriptedTransportFaultPort();
        const fault = {
            faultId: 'hold',
            carrier: 'ws',
            action: 'not-ready',
            remaining: 'until-cleared',
            match: { typeId: 'alm.lifecycle', msgId: undefined, controlType: undefined }
        } as const;
        faults.inject(fault);
        const socket = new JsonWebSocketClient('ws://test', faults);
        const engine = new InboxOutboxEngine();
        const drain = captureOutboundWorkRunnable(engine);
        const registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, maxEntries: 10, retainTerminalMs: 60_000, cancel: () => {} });
        const connecting = createBrowserWebSocketQueueBox({
            qosProvider: { defaultsForMessage: computeAlmConformanceQosDefaults },
            submissionReadinessFaultPort: faults,
            outboundSettlements: (event) => registry.record(event),
            newConnectionRequestId: undefined,
            qboxEngine: engine,
            socket,
            clientData: { clientId: sessionId, sessionId, isOnline: true },
            inboundStores: resolveBrowserSessionALInboundRuntimeStores(sessionId),
            connectTimeoutMs: 0
        });
        await vi.advanceTimersByTimeAsync(0);
        const native = TestWebSocket.instances.at(-1);
        if (!native) {
            throw new Error('Connecting must create a native socket');
        }
        native.open();
        const service = await connecting;
        onTestFinished(() => {
            service.close();
            engine.stop();
        });
        const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
        // This fixture owns the auth-storage port; room authority is the real readable repository.
        vi.spyOn(auth, 'readSession').mockReturnValue({
            clientId: sessionId,
            sessionId,
            username: 'sender',
            accessToken: 'test-only',
            expiresAtEpochMs: Date.now() + 60_000
        });
        configureGroupStateSnapshotRepository({ ttlMs: 60_000 });
        const snapshot = createGroupSnapshotFixture({ ...room, sessionIds: [sessionId] });
        setGroupStateSnapshot({
            ...snapshot,
            activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 60_000 }))
        });
        const original = newALMulticastMessage(sessionId, { topicId: 'room.lifecycle', contextId: 'room', resourceId: 'old' }, room, 'alm.lifecycle', {
            marker: 'delivery-lifecycle',
            specimen: 'supersedence'
        }, { ack: 'receiver', reliability: 'at-least-once', seq: 1 });
        const replacement = newALMulticastMessage(sessionId, { topicId: 'room.lifecycle', contextId: 'room', resourceId: 'new' }, room, 'alm.lifecycle', {
            marker: 'delivery-lifecycle',
            specimen: 'supersedence'
        }, { ack: 'receiver', reliability: 'at-least-once', seq: 2 });
        const oldHandle = registry.open(original, 'ws');
        await service.enqueueOutboxIfAbsent(original);
        await drain();
        expect(native.sent).toEqual([]);
        registry.open(replacement, 'ws');
        await service.enqueueOutboxIfAbsent(replacement);
        await vi.advanceTimersByTimeAsync(100);
        await drain();
        expect(oldHandle.lifecycle().state).toBe('superseded');
        faults.inject({ ...fault, remaining: 0 });
        await vi.advanceTimersByTimeAsync(100);
        await drain();
        expect(native.sent.map((frame) => decodePersistedALMessage(frame).id.msgId)).toEqual([replacement.id.msgId]);
    });

    it('holds original durable work before every callback and releases it exactly once without retry charges', async () => {
        const sessionId = crypto.randomUUID();
        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
        const faults = createScriptedTransportFaultPort();
        const fault = {
            faultId: 'hold-original',
            carrier: 'ws',
            action: 'not-ready',
            remaining: 'until-cleared',
            match: { typeId: 'held.message', msgId: undefined, controlType: undefined }
        } as const;
        faults.inject(fault);
        const socket = new JsonWebSocketClient('ws://test', faults);
        const engine = new InboxOutboxEngine();
        const drain = captureOutboundWorkRunnable(engine);
        const settlements: ALDeliverySettlement[] = [];
        const connecting = createBrowserWebSocketQueueBox({
            qosProvider: undefined,
            submissionReadinessFaultPort: faults,
            outboundSettlements: (settlement) => settlements.push(settlement),
            newConnectionRequestId: undefined,
            qboxEngine: engine,
            socket,
            clientData: { clientId: sessionId, sessionId, isOnline: true },
            inboundStores: resolveBrowserSessionALInboundRuntimeStores(sessionId),
            connectTimeoutMs: 0
        });
        await vi.advanceTimersByTimeAsync(0);
        const native = TestWebSocket.instances.at(-1);
        if (!native) {
            throw new Error('Connecting must create a native socket');
        }
        native.open();
        const service = await connecting;
        onTestFinished(() => {
            service.close();
            engine.stop();
        });
        const callbackMessages: string[] = [];
        service.onOutboxMessageDo('observer', {
            onMessage: async (entry) => {
                callbackMessages.push(decodePersistedALMessage(entry.resource).id.msgId);
            }
        });
        const message = {
            ...newALUnicastMessage(sessionId, { topicId: 'held', contextId: 'room', resourceId: 'original' }, 'receiver', 'held.message', { original: true }, {
                ttlMs: 60_000
            }),
            delivery: { reliability: 'at-least-once', ack: 'receiver' },
            // A WS unicast refuses `receiver` (D42): the addressee's ACK counts as the hop's.
            qos: { ack: { algo: 'hop' } }
        } as const;
        expect((await service.enqueueOutboxIfAbsent(message)).verdict.kind).toBe('admitted');
        await drain();
        await vi.advanceTimersByTimeAsync(100);
        await drain();
        expect(native.sent).toEqual([]);
        expect(callbackMessages).toEqual([]);
        expect(settlements.filter((event) => event.kind === 'attempt-settled')).toEqual([
            expect.objectContaining({ outcome: 'not-ready', submissionAttempted: false, willRetry: true }),
            expect.objectContaining({ outcome: 'not-ready', submissionAttempted: false, willRetry: true })
        ]);
        const retained = await Promise.all((await service.outbox.getAllKeys()).map((key) => service.outbox.getItem(key)));
        expect(retained.length).toBeGreaterThan(0);
        expect(retained.some((entry) => entry !== undefined && entry.dequeueAudit.attempts > 0)).toBe(false);
        faults.inject({ ...fault, remaining: 0 });
        await vi.advanceTimersByTimeAsync(100);
        await drain();
        await drain();
        expect(native.sent.map((frame) => decodePersistedALMessage(frame).id.msgId)).toEqual([message.id.msgId]);
        expect(callbackMessages).toEqual([message.id.msgId]);
    });
});
