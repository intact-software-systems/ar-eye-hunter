// @vitest-environment happy-dom

import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import '../../setup-browser-indexeddb.ts';
import { captureOutboundWorkRunnable } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    TestWebSocket.instances.length = 0;
});

it('a fresh WS owner recovers the same pending IndexedDB original with a fresh fault map and no second enqueue', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('WebSocket', TestWebSocket);
    const sessionId = crypto.randomUUID();
    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
    const oldFaults = createScriptedTransportFaultPort();
    oldFaults.inject({
        faultId: 'until-document-ends',
        carrier: 'ws',
        action: 'not-ready',
        remaining: 'until-cleared',
        match: { typeId: 'reload.original', msgId: undefined, controlType: undefined }
    });
    const oldEngine = new InboxOutboxEngine();
    const drainOld = captureOutboundWorkRunnable(oldEngine);
    const oldConnecting = createBrowserWebSocketQueueBox({
        qosProvider: undefined,
        submissionReadinessFaultPort: oldFaults,
        outboundSettlements: () => {},
        newConnectionRequestId: undefined,
        qboxEngine: oldEngine,
        socket: new JsonWebSocketClient('ws://test', oldFaults),
        clientData: { clientId: sessionId, sessionId, isOnline: true },
        connectTimeoutMs: 0
    });
    await vi.advanceTimersByTimeAsync(0);
    const oldNative = TestWebSocket.instances.at(-1)!;
    oldNative.open();
    const oldOwner = await oldConnecting;
    onTestFinished(() => {
        oldOwner.close();
        oldEngine.stop();
    });
    const original = {
        ...newALUnicastMessage(sessionId, { topicId: 'reload', contextId: 'room', resourceId: 'one' }, 'receiver', 'reload.original', { original: true }, {
            ttlMs: 30_000
        }),
        delivery: { reliability: 'at-least-once', ack: 'none' }
    } as const;
    expect((await oldOwner.enqueueOutboxIfAbsent(original)).verdict).toMatchObject({ kind: 'admitted', durable: true });
    await drainOld();
    expect(oldNative.sent).toEqual([]);
    const retained = await Promise.all((await oldOwner.outbox.getAllKeys()).map((key) => oldOwner.outbox.getItem(key)));
    expect(retained.some((entry) => entry && (entry.status === EntityStatus.NEW || entry.status === EntityStatus.RETRY))).toBe(true);
    oldOwner.close();
    oldEngine.stop();

    // Recreate both runtime store wrappers and transport owners while keeping the same real IndexedDB namespace/session.
    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
    const freshFaults = createScriptedTransportFaultPort();
    const freshEngine = new InboxOutboxEngine();
    const drainFresh = captureOutboundWorkRunnable(freshEngine);
    const freshConnecting = createBrowserWebSocketQueueBox({
        qosProvider: undefined,
        submissionReadinessFaultPort: freshFaults,
        outboundSettlements: () => {},
        newConnectionRequestId: undefined,
        qboxEngine: freshEngine,
        socket: new JsonWebSocketClient('ws://test', freshFaults),
        clientData: { clientId: sessionId, sessionId, isOnline: true },
        connectTimeoutMs: 0
    });
    await vi.advanceTimersByTimeAsync(100);
    const freshNative = TestWebSocket.instances.at(-1)!;
    freshNative.open();
    const freshOwner = await freshConnecting;
    onTestFinished(() => {
        freshOwner.close();
        freshEngine.stop();
    });
    await drainFresh();
    await drainFresh();
    expect(oldNative.sent).toEqual([]);
    expect(freshNative.sent.map((frame) => decodePersistedALMessage(frame).id.msgId)).toEqual([original.id.msgId]);
    expect(freshNative.sent.map((frame) => decodePersistedALMessage(frame).id.senderId)).toEqual([sessionId]);
});
