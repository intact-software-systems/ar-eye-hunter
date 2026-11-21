import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { toBrowserWsClientALCheckpointRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-checkpoint-store-ids.ts';
import {
    createBrowserALCheckpointOutboundRuntimeStores,
    resolveBrowserALCheckpointStores
} from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
import { toBrowserALRuntimeDbName, toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    createBrowserALVolatileInboundRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALVolatileInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALCheckpointOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { ALRuntimeStorage } from '@shared/alm/storage/al-runtime-storage.ts';
import { createPassThroughALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import { CommandTimedOutError } from '@shared/cache/Command.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import type WsQueueBoxClientService from '@shared/services/ws-queue-box-client-service.ts';
import * as wsClientFactory from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import '../../setup-browser-indexeddb.ts';

import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createDefaultVolatileSessionBudget } from '../default-volatile-session-budget.ts';

const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);

const clientData: ClientInfo = {
    clientId: 'client-1',
    sessionId: 'session-1',
    isOnline: true
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('WebSocket', TestWebSocket);
    const runtimeStorage = new ALRuntimeStorage();
    onTestFinished(async () => {
        try {
            await runtimeStorage.close();
        }
        finally {
            vi.clearAllTimers();
            vi.useRealTimers();
            vi.unstubAllGlobals();
            TestWebSocket.instances.length = 0;
        }
    });
    configureBrowserALRuntimeStores(clientData.sessionId, {
        runtimeStorage,
        scope: defaultStateScope(),
        diagnosticsPorts
    });
});

describe('createBrowserWebSocketQueueBox', () => {
    it('releases an in-flight inbound claim when calibration ends during its consumer', async () => {
        vi.setSystemTime(10_000_000);
        let calibrated = true;
        const nowEpochMs = (): number => {
            if (!calibrated) {
                throw new Error('Calibration lifetime ended');
            }
            return 10_000_000;
        };
        const budget = createDefaultVolatileSessionBudget();
        const inboundVolatileStores = createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
            budget,
            { storage: createPassThroughALStorageEventSink(), nowMs: nowEpochMs, workNowMs: () => 10_000_000 }
        );
        const queue = inboundVolatileStores.workQueue;
        if (!(queue instanceof InMemoryQueueBox)) {
            throw new Error('Browser volatile work must use its memory queue');
        }
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        onTestFinished(() => {
            finish.resolve();
        });
        const service = await openWsClient({
            budget,
            inboundVolatileStores,
            nowEpochMs,
            workNowEpochMs: () => 10_000_000,
            checkpointStores: resolveWsClientCheckpointStores()
        });
        service.onInboxMessageDo('chat.message.v1', {
            onMessage: async () => {
                started.resolve();
                await finish.promise;
            }
        });
        expect((await service.acceptIncomingMessage(serverClockMessage('server', clientData.sessionId))).right)
            .toMatchObject({ kind: 'admitted' });
        await started.promise;
        expect(queue.peekKeys().map((key) => queue.peek(key)?.status)).toEqual(['RESERVED']);

        calibrated = false;
        const closing = service.close(1000, 'clock-ended');
        finish.resolve();
        await closing;

        // Closing interrupts dispatch; its retryable claim must still be released for the next owner.
        expect(queue.peekKeys().map((key) => queue.peek(key)?.status)).toEqual(['RETRY']);
        expect((await service.acceptIncomingMessage(serverClockMessage('server', clientData.sessionId))).right)
            .toEqual({ kind: 'disposed' });
    });

    it.each([-20_000, 20_000])('uses the supplied server epoch for browser WS traffic with device offset %i', async (offsetMs) => {
        let serverNow = 10_000_000;
        vi.setSystemTime(serverNow + offsetMs);
        const service = await openWsClient({
            budget: createDefaultVolatileSessionBudget(),
            checkpointStores: resolveWsClientCheckpointStores(),
            nowEpochMs: () => serverNow
        });
        const received = collectChatArrivals(service);
        const incoming = serverClockMessage('server', clientData.sessionId);
        const outgoing = serverClockMessage(clientData.sessionId, 'peer');

        expect((await service.acceptIncomingMessage(incoming)).right).toMatchObject({ kind: 'admitted' });
        await vi.waitFor(() => expect(received).toEqual([incoming.id.msgId]));
        expect((await service.enqueueOutboxIfAbsent(outgoing)).verdict).toMatchObject({ kind: 'admitted' });
        await vi.waitFor(() => expect(readCreatedSocket().sent.map((value) => JSON.parse(value).id.msgId)).toContain(outgoing.id.msgId));

        serverNow = 10_000_100;
        expect((await service.acceptIncomingMessage(serverClockMessage('server', clientData.sessionId))).right)
            .toMatchObject({ kind: 'not-admitted', reason: 'expired' });
        expect((await service.enqueueOutboxIfAbsent(serverClockMessage(clientData.sessionId, 'peer'))).verdict)
            .toMatchObject({ kind: 'expired' });
        expect(received).toEqual([incoming.id.msgId]);
    });

    it.each(['records', 'throws'])('disposes its acquired real service when initial connection rejects and cleanup reporting %s', async (reporting) => {
        const failure = new Error('initial socket connection failed');
        const reported = vi.spyOn(console, 'error').mockImplementation(() => {
            if (reporting === 'throws') {
                throw new Error('reporting failed');
            }
        });
        const cleanupFailure = new Error('secondary close failure');
        onTestFinished(() => reported.mockRestore());
        const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
        vi.spyOn(socket, 'connect').mockRejectedValue(failure);
        vi.spyOn(socket, 'close').mockImplementation(() => {
            throw cleanupFailure;
        });
        const engine = new InboxOutboxEngine();
        const original = wsClientFactory.createDefaultWsQueueBoxClientService;
        let acquired: WsQueueBoxClientService | undefined;
        const factory = vi.spyOn(wsClientFactory, 'createDefaultWsQueueBoxClientService').mockImplementation((input) => {
            acquired = original(input);
            return acquired;
        });
        onTestFinished(async () => {
            if (acquired) {
                await expect(acquired.close()).rejects.toMatchObject({ errors: [cleanupFailure] });
            }
            await engine.stop();
            factory.mockRestore();
        });
        await expect(createBrowserWebSocketQueueBox({
            nowEpochMs: Date.now,
            workNowEpochMs: Date.now,
            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
            qosProvider: {},
            submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
            outboundSettlements: () => {},
            newConnectionRequestId: undefined,
            qboxEngine: engine,
            socket,
            clientData,
            serverPeerId: 'server',
            inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
            inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
                toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
                createDefaultVolatileSessionBudget(),
                { storage: createPassThroughALStorageEventSink(), nowMs: Date.now, workNowMs: Date.now }
            ),
            volatileBudget: createDefaultVolatileSessionBudget(),
            checkpointStores: resolveWsClientCheckpointStores(),
            connectTimeoutMs: 0
        })).rejects.toBe(failure);
        expect(reported).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ errors: [cleanupFailure] }));
        if (!acquired) {
            throw new Error('Initial socket acquisition must construct the service');
        }
        const sent = await acquired.enqueueOutboxIfAbsent(createChatSend('failed-connect'));
        expect(sent.verdict).toMatchObject({ kind: 'skipped', reason: 'disposed' });
    });

    it('returns an open service for the session after the initial socket opens', async () => {
        const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
        onTestFinished(() => socket.close(1000, 'test-finished'));
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const controller = new AbortController();
        onTestFinished(() => controller.abort());

        const initialized = createBrowserWebSocketQueueBox({
            nowEpochMs: Date.now,
            workNowEpochMs: Date.now,
            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
            qosProvider: {},
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
                { storage: createPassThroughALStorageEventSink(), nowMs: Date.now, workNowMs: Date.now }
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
            nowEpochMs: Date.now,
            workNowEpochMs: Date.now,
            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
            qosProvider: {},
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
                { storage: createPassThroughALStorageEventSink(), nowMs: Date.now, workNowMs: Date.now }
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
            nowEpochMs: Date.now,
            workNowEpochMs: Date.now,
            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
            qosProvider: {},
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
                { storage: createPassThroughALStorageEventSink(), nowMs: Date.now, workNowMs: Date.now }
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
            {
                createdAtEpochMs: Date.now(),
                senderId: 'server',
                route: { topicId: 'chat', resourceId: 'early-delivery', contextId: 'conversation' },
                toPeerId: 'session-1',
                typeId: 'chat.message.v1',
                resource: { text: 'hello' }
            }
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
            nowEpochMs: Date.now,
            workNowEpochMs: Date.now,
            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
            qosProvider: {},
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
                { storage: createPassThroughALStorageEventSink(), nowMs: Date.now, workNowMs: Date.now }
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
    it('admits a local-checkpoint send to the checkpoint pair it is handed, outside the volatile budget', async () => {
        const budget = createDefaultVolatileSessionBudget();
        const checkpointStores = resolveWsClientCheckpointStores();
        const service = await openWsClient({ budget, checkpointStores });

        const sent = await service.enqueueOutboxIfAbsent(newALUnicastMessage(
            {
                createdAtEpochMs: Date.now(),
                senderId: 'session-1',
                route: { topicId: 'chat', resourceId: 'checkpointed', contextId: 'conversation' },
                toPeerId: 'peer',
                typeId: 'chat.message.v1',
                resource: { text: 'checkpointed' },
                options: { ttlMs: 30_000, qos: { durability: { algo: 'local-checkpoint' } } }
            }
        ));

        expect(sent.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(await checkpointStores.admissionStore.hasSentMessageAdmission(sent.message.id.msgId)).toBe(true);
        expect(budget.readReport(Date.now()).usage.admissions).toBe(0);

        await service.close(1000, 'verify-final-checkpoint');
        const reopenedStorage = new ALRuntimeStorage();
        const reopened = createBrowserALCheckpointOutboundRuntimeStores(
            toBrowserWsClientALCheckpointRuntimeStoreId(clientData.sessionId),
            {
                options: { dbName: toBrowserALRuntimeDbName(defaultStateScope()), runtimeStorage: reopenedStorage },
                settings: { intervalMs: 1_000, lagBoundMs: 10_000 },
                ownership: ALWAYS_OWNED_AL_DURABLE_WORK
            }
        );
        try {
            await reopened.checkpoint.restore();
            expect(await reopened.admissionStore.hasSentMessageAdmission(sent.message.id.msgId)).toBe(true);
        }
        finally {
            await reopenedStorage.close();
        }
    });
});

interface OpenWsClientInput {
    readonly nowEpochMs?: () => number;
    readonly workNowEpochMs?: () => number;
    readonly inboundVolatileStores?: ALVolatileInboundRuntimeStores;
    readonly budget: ALVolatileSessionBudget;
    readonly checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
}

async function openWsClient(input: OpenWsClientInput): Promise<WsQueueBoxClientService> {
    const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
    onTestFinished(() => socket.close(1000, 'test-finished'));
    const qboxEngine = new InboxOutboxEngine();
    onTestFinished(() => qboxEngine.stop());
    const initialized = createBrowserWebSocketQueueBox({
        nowEpochMs: input.nowEpochMs ?? Date.now,
        workNowEpochMs: input.workNowEpochMs ?? input.nowEpochMs ?? Date.now,
        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
        qosProvider: {},
        submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
        outboundSettlements: () => {},
        newConnectionRequestId: undefined,
        qboxEngine,
        socket,
        clientData,
        serverPeerId: 'server',
        inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
        inboundVolatileStores: input.inboundVolatileStores ?? createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
            input.budget,
            {
                storage: createPassThroughALStorageEventSink(),
                nowMs: input.nowEpochMs ?? Date.now,
                workNowMs: input.workNowEpochMs ?? input.nowEpochMs ?? Date.now
            }
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
        {
            createdAtEpochMs: Date.now(),
            senderId: 'server',
            route: { topicId: 'chat', resourceId, contextId: 'conversation' },
            toPeerId: clientData.sessionId,
            typeId: 'chat.message.v1',
            resource: { text: resourceId },
            options: { ttlMs: 30_000 }
        }
    );
}

function createChatSend(resourceId: string): ALMessage {
    return newALUnicastMessage(
        {
            createdAtEpochMs: Date.now(),
            senderId: clientData.sessionId,
            route: { topicId: 'chat', resourceId, contextId: 'conversation' },
            toPeerId: 'peer',
            typeId: 'chat.message.v1',
            resource: { text: resourceId },
            options: { ttlMs: 30_000 }
        }
    );
}

/** An independently timestamped wire envelope; it never uses the device-clock message builders. */
function serverClockMessage(senderId: string, toPeerId: string): ALMessage {
    return {
        id: { v: 4, msgId: crypto.randomUUID(), ts: 10_000_000, senderId, traceId: 'clock-test' },
        route: { topicId: 'chat', resourceId: 'clock', contextId: 'conversation' },
        targets: { mode: 'unicast', toPeerId },
        constraints: { expiresAtMs: 10_000_100 },
        payload: { typeId: 'chat.message.v1', contentType: 'application/json', resource: '{}' }
    };
}
