import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { resolveBrowserALCheckpointStores } from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    createBrowserALVolatileInboundRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALCheckpointOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { createPassThroughALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import { CommandTimedOutError } from '@shared/cache/Command.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import type WsQueueBoxClientService from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createDefaultVolatileSessionBudget } from '../default-volatile-session-budget.ts';

const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);

const clientData: ClientInfo = {
    clientId: 'client-1',
    sessionId: 'session-1',
    isOnline: true
};

describe('createBrowserWebSocketQueueBox', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', TestWebSocket);
        onTestFinished(() => {
            vi.clearAllTimers();
            vi.useRealTimers();
            vi.unstubAllGlobals();
            TestWebSocket.instances.length = 0;
        });
        configureBrowserALRuntimeStores(clientData.sessionId, { scope: defaultStateScope(), diagnosticsPorts });
    });

    it('returns an open service for the session after the initial socket opens', async () => {
        const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
        onTestFinished(() => socket.close(1000, 'test-finished'));
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const controller = new AbortController();
        onTestFinished(() => controller.abort());

        const initialized = createBrowserWebSocketQueueBox({
            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
            qosProvider: undefined,
            submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
            outboundSettlements: () => {},
            newConnectionRequestId: undefined,
            qboxEngine,
            socket,
            clientData,
            serverPeerId: 'server',
            inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
            inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
                toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
                createDefaultVolatileSessionBudget(),
                createPassThroughALStorageEventSink()
            ),
            volatileBudget: createDefaultVolatileSessionBudget(),
            checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
            connectTimeoutMs: 25,
            signal: controller.signal
        });
        onTestFinished(async () => {
            controller.abort();
            await initialized.catch(() => undefined);
        });
        await vi.advanceTimersByTimeAsync(0);
        const native = readCreatedSocket();
        expect(native.readyState).toBe(WebSocket.CONNECTING);

        native.open();
        const service = await initialized;
        onTestFinished(() => service.close(1000, 'test-finished'));

        expect(service.sessionId).toBe('session-1');
        expect(service.readHealth()).toMatchObject({
            sessionId: 'session-1',
            url: 'ws://test',
            isOpen: true,
            readyState: 'open',
            reconnectEnabled: true
        });
        expect(TestWebSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(25);
        expect(service.readHealth().isOpen).toBe(true);
        expect(native.closedWith).toBeUndefined();
    });

    it.each([
        { label: 'configured', connectTimeoutMs: 25, deadlineMs: 25 },
        { label: 'composition default', connectTimeoutMs: 10_000, deadlineMs: 10_000 }
    ])('aborts a pending real socket at the $label connect timeout', async ({ connectTimeoutMs, deadlineMs }) => {
        const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
        onTestFinished(() => socket.close(1000, 'test-finished'));
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const controller = new AbortController();
        onTestFinished(() => controller.abort());

        const initialized = createBrowserWebSocketQueueBox({
            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
            qosProvider: undefined,
            submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
            outboundSettlements: () => {},
            newConnectionRequestId: undefined,
            qboxEngine,
            socket,
            clientData,
            serverPeerId: 'server',
            inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
            inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
                toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
                createDefaultVolatileSessionBudget(),
                createPassThroughALStorageEventSink()
            ),
            volatileBudget: createDefaultVolatileSessionBudget(),
            checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
            connectTimeoutMs,
            signal: controller.signal
        });
        onTestFinished(async () => {
            controller.abort();
            await initialized.catch(() => undefined);
        });
        const rejected = expect(initialized).rejects.toBeInstanceOf(CommandTimedOutError);
        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        const native = readCreatedSocket();
        expect(native.readyState).toBe(WebSocket.CONNECTING);
        expect(native.closedWith).toBeUndefined();

        await vi.advanceTimersByTimeAsync(1);
        await rejected;

        expect(native.readyState).toBe(WebSocket.CLOSED);
        expect(native.closedWith).toEqual({ code: 1000, reason: 'connect-aborted' });
        expect(socket.ws).toBeUndefined();
    });

    it('ignores incoming data before connect and delivers it after the service is ready', async () => {
        const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
        onTestFinished(() => socket.close(1000, 'test-finished'));
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const controller = new AbortController();
        onTestFinished(() => controller.abort());
        const initialized = createBrowserWebSocketQueueBox({
            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
            qosProvider: undefined,
            submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
            outboundSettlements: () => {},
            newConnectionRequestId: undefined,
            qboxEngine,
            socket,
            clientData,
            serverPeerId: 'server',
            inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
            inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
                toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
                createDefaultVolatileSessionBudget(),
                createPassThroughALStorageEventSink()
            ),
            volatileBudget: createDefaultVolatileSessionBudget(),
            checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
            connectTimeoutMs: 0,
            signal: controller.signal
        });
        onTestFinished(async () => {
            controller.abort();
            await initialized.catch(() => undefined);
        });
        await vi.advanceTimersByTimeAsync(0);
        const native = readCreatedSocket();
        const msg = newALUnicastMessage(
            'server',
            { topicId: 'chat', resourceId: 'early-delivery', contextId: 'conversation' },
            'session-1',
            'chat.message.v1',
            { text: 'hello' }
        );

        native.receive(JSON.stringify(msg));
        await vi.advanceTimersByTimeAsync(0);
        native.open();
        const service = await initialized;
        onTestFinished(() => service.close(1000, 'test-finished'));
        const received: string[] = [];
        service.onInboxMessageDo('chat.message.v1', {
            onMessage: async (message) => {
                received.push(message.id.msgId);
            }
        });

        // Reusing the same message also catches premature admission that consumed its dedup identity.
        native.receive(JSON.stringify(msg));
        await vi.waitFor(() => expect(received).toEqual([msg.id.msgId]));
        expect(service.readHealth().isOpen).toBe(true);
    });

    it.each([0, -1])('allows a pending connection with connectTimeoutMs=%i until its socket opens', async (connectTimeoutMs) => {
        const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
        onTestFinished(() => socket.close(1000, 'test-finished'));
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const controller = new AbortController();
        onTestFinished(() => controller.abort());
        const initialized = createBrowserWebSocketQueueBox({
            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
            qosProvider: undefined,
            submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
            outboundSettlements: () => {},
            newConnectionRequestId: undefined,
            qboxEngine,
            socket,
            clientData,
            serverPeerId: 'server',
            inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
            inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
                toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
                createDefaultVolatileSessionBudget(),
                createPassThroughALStorageEventSink()
            ),
            volatileBudget: createDefaultVolatileSessionBudget(),
            checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
            connectTimeoutMs,
            signal: controller.signal
        });
        onTestFinished(async () => {
            controller.abort();
            await initialized.catch(() => undefined);
        });
        await vi.advanceTimersByTimeAsync(20_000);
        const native = readCreatedSocket();
        expect(native.readyState).toBe(WebSocket.CONNECTING);
        expect(native.closedWith).toBeUndefined();

        native.open();
        const service = await initialized;
        onTestFinished(() => service.close(1000, 'test-finished'));

        expect(service.sessionId).toBe('session-1');
        expect(service.readHealth()).toMatchObject({ isOpen: true, reconnectEnabled: true });
    });
});

describe('the session volatile bound on the WS client (C3)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', TestWebSocket);
        onTestFinished(() => {
            vi.clearAllTimers();
            vi.useRealTimers();
            vi.unstubAllGlobals();
            TestWebSocket.instances.length = 0;
        });
        configureBrowserALRuntimeStores(clientData.sessionId, { scope: defaultStateScope(), diagnosticsPorts });
    });

    it('counts a received and a sent volatile message against the one budget both of its memory pairs carry', async () => {
        const budget = new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS);
        const service = await openWsClient({ budget, checkpointStores: resolveWsClientCheckpointStores() });
        const received = collectChatArrivals(service);
        const arrival = createChatArrival('received');

        readCreatedSocket().receive(JSON.stringify(arrival));
        await vi.waitFor(() => expect(received).toEqual([arrival.id.msgId]));
        const sent = await service.enqueueOutboxIfAbsent(createChatSend('sent'));

        expect(sent.verdict).toMatchObject({ kind: 'admitted', durable: false });
        expect(budget.readReport(Date.now()).usage.admissions).toBe(2);
    });

    it('admits own sends while arrivals hold the total at its limit, and refuses capacity once the own share is held too (D189)', async () => {
        const budget = new ALVolatileSessionBudget({ ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 4 });
        const service = await openWsClient({ budget, checkpointStores: resolveWsClientCheckpointStores() });
        const received = collectChatArrivals(service);
        const arrivals = ['received-1', 'received-2', 'received-3', 'received-4'].map(createChatArrival);

        arrivals.forEach((arrival) => readCreatedSocket().receive(JSON.stringify(arrival)));
        await vi.waitFor(() => expect(received).toHaveLength(arrivals.length));
        const first = await service.enqueueOutboxIfAbsent(createChatSend('sent-1'));
        const second = await service.enqueueOutboxIfAbsent(createChatSend('sent-2'));
        const third = await service.enqueueOutboxIfAbsent(createChatSend('sent-3'));

        expect([first.verdict, second.verdict, third.verdict]).toMatchObject([
            { kind: 'admitted', durable: false },
            { kind: 'admitted', durable: false },
            { kind: 'refused', reason: 'capacity', limit: 'admissions' }
        ]);
        expect(budget.readReport(Date.now())).toMatchObject({
            usage: { admissions: 6 },
            own: { admissions: 2 },
            inbound: { admissions: 4 },
            overloaded: true
        });
    });
});

describe('the checkpoint lane on the WS client', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', TestWebSocket);
        onTestFinished(() => {
            vi.clearAllTimers();
            vi.useRealTimers();
            vi.unstubAllGlobals();
            TestWebSocket.instances.length = 0;
        });
        configureBrowserALRuntimeStores(clientData.sessionId, { scope: defaultStateScope(), diagnosticsPorts });
    });

    it('admits a local-checkpoint send to the checkpoint pair it is handed, outside the volatile budget', async () => {
        const budget = createDefaultVolatileSessionBudget();
        const checkpointStores = resolveWsClientCheckpointStores();

        const service = await openWsClient({ budget, checkpointStores });

        const sent = await service.enqueueOutboxIfAbsent(newALUnicastMessage(
            'session-1',
            { topicId: 'chat', resourceId: 'checkpointed', contextId: 'conversation' },
            'peer',
            'chat.message.v1',
            { text: 'checkpointed' },
            { ttlMs: 30_000, qos: { durability: { algo: 'local-checkpoint' } } }
        ));

        expect(sent.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(await checkpointStores.admissionStore.hasSentMessageAdmission(sent.message.id.msgId)).toBe(true);
        expect(budget.readReport(Date.now()).usage.admissions).toBe(0);
    });
});

interface OpenWsClientInput {
    readonly budget: ALVolatileSessionBudget;
    readonly checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
}

async function openWsClient(input: OpenWsClientInput): Promise<WsQueueBoxClientService> {
    const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
    onTestFinished(() => socket.close(1000, 'test-finished'));
    const qboxEngine = new InboxOutboxEngine();
    onTestFinished(() => qboxEngine.stop());
    const initialized = createBrowserWebSocketQueueBox({
        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
        qosProvider: undefined,
        submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
        outboundSettlements: () => {},
        newConnectionRequestId: undefined,
        qboxEngine,
        socket,
        clientData,
        serverPeerId: 'server',
        inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
        inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
            input.budget,
            createPassThroughALStorageEventSink()
        ),
        volatileBudget: input.budget,
        checkpointStores: input.checkpointStores,
        connectTimeoutMs: 0
    });
    await vi.advanceTimersByTimeAsync(0);
    readCreatedSocket().open();
    const service = await initialized;
    onTestFinished(() => service.close(1000, 'test-finished'));
    return service;
}

function readCreatedSocket(): TestWebSocket {
    const socket = TestWebSocket.instances.at(-1);
    if (!socket) {
        throw new Error('Connecting the client must create a WebSocket');
    }
    return socket;
}

function resolveWsClientCheckpointStores(): ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage> {
    return resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient;
}

function collectChatArrivals(service: WsQueueBoxClientService): readonly string[] {
    const received: string[] = [];
    service.onInboxMessageDo('chat.message.v1', {
        onMessage: async (message) => {
            received.push(message.id.msgId);
        }
    });
    return received;
}

function createChatArrival(resourceId: string): ALMessage {
    return newALUnicastMessage(
        'server',
        { topicId: 'chat', resourceId, contextId: 'conversation' },
        clientData.sessionId,
        'chat.message.v1',
        { text: resourceId },
        { ttlMs: 30_000 }
    );
}

function createChatSend(resourceId: string): ALMessage {
    return newALUnicastMessage(
        clientData.sessionId,
        { topicId: 'chat', resourceId, contextId: 'conversation' },
        'peer',
        'chat.message.v1',
        { text: resourceId },
        { ttlMs: 30_000 }
    );
}
