import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { createPassThroughALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
import * as auth from '@shared/api/auth.ts';
import { configureGroupStateSnapshotRepository, setGroupStateSnapshot } from '@shared/repository/group-state-snapshots-repository.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import type WsQueueBoxClientService from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import '../../setup-browser-indexeddb.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import { createDefaultVolatileSessionBudget } from '../default-volatile-session-budget.ts';

const TYPE_ID = 'alm.conformance.ws.buffered-track-drains';
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const SEQS = [...Array.from({ length: 64 }, (_, offset) => offset + 2), 1];

interface OrderedSender {
    readonly service: WsQueueBoxClientService;
    readonly socket: TestWebSocket;
    readonly settlements: readonly ALDeliverySettlement[];
    readonly sessionId: string;
}

describe('ordered ack-none room sends on the browser WS client', () => {
    beforeEach(() => vi.stubGlobal('WebSocket', TestWebSocket));
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('submits all 65 sends of a track sent seq 2 to 65 then seq 1, none waiting on a receipt', async () => {
        const sender = await openOrderedSender(60_000);

        for (const seq of SEQS) {
            expect((await sender.service.enqueueOutboxIfAbsent(createOrderedSend(sender.sessionId, seq))).verdict.kind)
                .toBe('admitted');
        }

        await vi.waitFor(() => expect(readSentSeqs(sender.socket)).toHaveLength(SEQS.length), { timeout: 20_000, interval: 20 });
    }, 30_000);

    it('holds every send not-ready once its own room presence lease in the snapshot has lapsed', async () => {
        const sender = await openOrderedSender(1_500);
        await sender.service.enqueueOutboxIfAbsent(createOrderedSend(sender.sessionId, 2));
        await vi.waitFor(() => expect(readSentSeqs(sender.socket)).toEqual([2]), { timeout: 5_000, interval: 20 });
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        await sender.service.enqueueOutboxIfAbsent(createOrderedSend(sender.sessionId, 3));
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        expect(sender.settlements).toContainEqual(expect.objectContaining({
            kind: 'attempt-settled',
            outcome: 'not-ready',
            detail: 'Room submission is awaiting live sender presence'
        }));
        expect(readSentSeqs(sender.socket)).toEqual([2]);
    }, 30_000);
});

async function openOrderedSender(leaseMs: number): Promise<OrderedSender> {
    const sessionId = crypto.randomUUID();
    configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
    vi.spyOn(auth, 'readSession').mockReturnValue({
        clientId: sessionId,
        sessionId,
        username: 'sender',
        accessToken: 'test-only',
        expiresAtEpochMs: Date.now() + 600_000
    });
    configureGroupStateSnapshotRepository({ ttlMs: 600_000 });
    const snapshot = createGroupSnapshotFixture({ ...ROOM, sessionIds: [sessionId, 'receiver'] });
    setGroupStateSnapshot({
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + leaseMs }))
    });
    const settlements: ALDeliverySettlement[] = [];
    const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
    const engine = new InboxOutboxEngine();
    engine.start();
    const budget = createDefaultVolatileSessionBudget();
    const connecting = createBrowserWebSocketQueueBox({
        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
        qosProvider: undefined,
        submissionReadinessFaultPort: toRallarDiagnosticsPorts(undefined).submissionReadinessFaultPort,
        outboundSettlements: (event) => settlements.push(event),
        newConnectionRequestId: undefined,
        qboxEngine: engine,
        socket,
        clientData: { clientId: sessionId, sessionId, isOnline: true },
        serverPeerId: 'server',
        inboundStores: resolveBrowserSessionALInboundRuntimeStores(sessionId),
        inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(sessionId),
            budget,
            createPassThroughALStorageEventSink()
        ),
        volatileBudget: budget,
        checkpointStores: resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
        connectTimeoutMs: 0
    });
    await vi.waitFor(() => expect(TestWebSocket.instances.length).toBeGreaterThan(0));
    const native = TestWebSocket.instances.at(-1)!;
    native.open();
    const service = await connecting;
    onTestFinished(() => {
        service.close();
        engine.stop();
        socket.close(1000, 'test-finished');
    });
    return { service, socket: native, settlements, sessionId };
}

function createOrderedSend(sessionId: string, seq: number): ALMessage {
    return newALMulticastMessage(
        sessionId,
        { topicId: 'room.alm-conformance', contextId: 'room', resourceId: `track-${seq}` },
        ROOM,
        TYPE_ID,
        { marker: 'buffered-track-drains', seq },
        { ttlMs: 30_000, reliability: 'at-least-once', ack: 'none', seq, orderingKey: 'alm-ws-buffered-track-drains' }
    );
}

function readSentSeqs(socket: TestWebSocket): readonly number[] {
    return socket.sent.flatMap((frame): number[] => {
        const message = decodePersistedALMessage(frame);
        const seq = message.ordering?.seq;
        return message.payload.typeId === TYPE_ID && seq !== undefined ? [seq] : [];
    });
}
