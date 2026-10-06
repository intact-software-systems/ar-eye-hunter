import '../../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    newALBroadcastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey, type ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import {
    createCheckpointALOutboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import type {
    ALCheckpointOutboundRuntimeStores,
    ALOutboundControlAdmissionResult,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    createDefaultWsQueueBoxClientService,
    type WsQueueBoxClientService
} from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import {
    createTakeableDurableWorkOwnership,
    GLOBAL_CHECKPOINT_TIMERS,
    TEST_CHECKPOINT_SETTINGS
} from '../alm/checkpoint/al-checkpoint-test-support.ts';
import { holdOutboundClaims } from '../alm/outbound-runtime-test-fixture.ts';
import { settleCommittedOutboundBatch } from '../wait-for-al-outbound-work.ts';
import { TestWebSocket } from '../websocket/test-web-socket.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const SERVER_PEER_ID = 'server';
const ACK_TIMEOUT_MS = 100;
const ONE_RETRY: ALQosPolicyRequest = {
    ack: { algo: 'receiver', opts: { timeoutMs: ACK_TIMEOUT_MS } },
    retry: { algo: 'exp-backoff', opts: { maxAttempts: 1 } }
};

const ONE_CHECKPOINTED_RETRY: ALQosPolicyRequest = { ...ONE_RETRY, durability: { algo: 'local-checkpoint' } };

/** An ordered room send whose one hop is the server, with a gap repair the server may ask for; its receipt does not time out within the test. */
const ORDERED_ROOM_SEND: ALQosPolicyRequest = {
    ack: { algo: 'hop', opts: { timeoutMs: 30_000 } },
    retry: { algo: 'exp-backoff', opts: { maxAttempts: 1 } },
    repair: { algo: 'retransmit', opts: { maxRepairs: 1 } }
};
const ORDERING_KEY = 'room-stream';

/** What the client's outbound owner decided about one control its server sent. */
interface ControlAdmissionObservation {
    readonly targetMsgId: string;
    readonly outcome: ALOutboundControlAdmissionResult['kind'];
}

interface OwnHopRetryFixture {
    readonly service: WsQueueBoxClientService;
    readonly sentFrames: readonly string[];
    readonly outboundStores: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly controlAdmissions: readonly ControlAdmissionObservation[];
}

interface CheckpointedOwnHopRetryFixture {
    readonly service: WsQueueBoxClientService;
    readonly sentFrames: readonly string[];
    readonly checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly observer: CountingIndexedDbOperationObserver;
    /** What the checkpoint store states, the recovery outcome of a restore among it. */
    readonly storage: readonly ALStorageEvent[];
}

describe('WS client retry of its own hop after an acknowledgement timeout', () => {
    afterEach(() => {
        vi.useRealTimers();
        TestWebSocket.instances.length = 0;
    });

    it('resends a receiver command addressed to the server, which names its room, with the same msgId', async () => {
        vi.useFakeTimers();
        const fixture = createOwnHopRetryFixture();
        const command = serverCommand();

        await enqueueAndSettle(fixture.service, command);
        expect(fixture.sentFrames).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
        await expect.poll(async () => {
            await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
            return fixture.sentFrames.length;
        }).toBe(2);

        expect(fixture.sentFrames.map((frame) => decodePersistedALMessage(frame).id.msgId))
            .toEqual([command.id.msgId, command.id.msgId]);
    });

    it('sends a receiver room send once and schedules no acknowledgement timeout: the server owns that retry', async () => {
        vi.useFakeTimers();
        const fixture = createOwnHopRetryFixture();
        const roomSend = receiverRoomSend();

        await enqueueAndSettle(fixture.service, roomSend);
        await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 4);
        await settleCommittedOutboundBatch();

        expect(fixture.sentFrames).toHaveLength(1);
        expect(await fixture.outboundStores.admissionStore.readReceiptState({ originPeerId: 'self', msgId: roomSend.id.msgId }))
            .toBeUndefined();
        expect(await readOutboundEffectKinds(fixture.outboundStores)).not.toContain('ack-timeout');
    });

    it('retransmits the sequence its server hop reports missing from an ordered room send, on the server gap NACK alone', async () => {
        vi.useFakeTimers();
        const fixture = createOwnHopRetryFixture();
        const sends = [1, 2, 3].map(orderedRoomSend);
        for (const send of sends) {
            await enqueueAndSettle(fixture.service, send);
        }
        expect(fixture.sentFrames).toHaveLength(3);

        const admitted = await fixture.service.acceptIncomingMessage(serverGapNack(sends[2], [{ from: 2, to: 2 }]));

        expect(admitted.right?.kind).toBe('control');
        expect(fixture.controlAdmissions).toEqual([{ targetMsgId: sends[2].id.msgId, outcome: 'committed' }]);
        await expect.poll(async () => {
            await vi.advanceTimersByTimeAsync(10);
            return fixture.sentFrames.length;
        }, { timeout: 5_000 }).toBe(4);
        expect(decodePersistedALMessage(fixture.sentFrames[3]).id.msgId).toBe(sends[1].id.msgId);
    });

    it('retries a checkpointed command the next service of the session restores, with the same msgId, once its acknowledgement times out', async () => {
        const dbName = `ws-client-own-hop-retry-${crypto.randomUUID()}`;
        const reloaded = createCheckpointedOwnHopRetryFixture(dbName);
        const command = serverCommand(ONE_CHECKPOINTED_RETRY);
        // The first frame reaches the transport fake and nobody: as a frame a carrier accepted and never delivered.
        await enqueueAndSettle(reloaded.service, command);
        expect(reloaded.sentFrames).toHaveLength(1);
        const held = holdOutboundClaims(reloaded.checkpointStores);
        reloaded.checkpointStores.checkpoint.flush();
        await vi.waitFor(() => expect(reloaded.observer.getCounts().byKind.write).toBeGreaterThanOrEqual(1));
        reloaded.service.close();
        await held.release();

        const restored = createCheckpointedOwnHopRetryFixture(dbName);

        await vi.waitFor(() => expect(restored.sentFrames).toHaveLength(1), { timeout: 5_000 });
        expect(decodePersistedALMessage(restored.sentFrames[0]).id.msgId).toBe(command.id.msgId);
        expect(reloaded.sentFrames).toHaveLength(1);
        expect(restored.storage.filter((event) => event.kind === 'recovery').at(-1))
            .toMatchObject({ kind: 'recovery', storeId: 'ws-client-own-hop-retry', outcome: { kind: 'restored', expired: 0 } });
    }, 20_000);
});

function createOwnHopRetryFixture(): OwnHopRetryFixture {
    const native = new TestWebSocket('ws://own-hop-retry-test');
    native.open();
    const socket = new JsonWebSocketClient('ws://own-hop-retry-test', createPassThroughTransportFaultPort());
    socket.ws = native;
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage });
    const controlAdmissions: ControlAdmissionObservation[] = [];
    const service = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(new Map()),
        socket,
        sessionId: 'self',
        serverPeerId: SERVER_PEER_ID,
        outboundStores,
        outboundDiagnostics: (event) => {
            if (event.kind === 'control-admission') {
                controlAdmissions.push({ targetMsgId: event.targetMsgId, outcome: event.outcome });
            }
        }
    }).enableDefaultCallbacks();
    onTestFinished(() => service.close());
    return { service, sentFrames: native.sent, outboundStores, controlAdmissions };
}

/** A WS client over the session's checkpoint pair, owning the session's durable work, as a connected browser document is. */
function createCheckpointedOwnHopRetryFixture(dbName: string): CheckpointedOwnHopRetryFixture {
    const native = new TestWebSocket('ws://own-hop-retry-checkpoint-test');
    native.open();
    const socket = new JsonWebSocketClient('ws://own-hop-retry-checkpoint-test', createPassThroughTransportFaultPort());
    socket.ws = native;
    const observer = createCountingIndexedDbOperationObserver();
    const ownership = createTakeableDurableWorkOwnership(true);
    const storage: ALStorageEvent[] = [];
    const checkpointStores = createCheckpointALOutboundRuntimeStores<ALOutboundTransportMessage>({
        dbName,
        namespace: 'browser:ws-client-own-hop-retry',
        nowMs: Date.now,
        observer,
        decodePrepared: decodeALOutboundTransportMessage,
        storageHealth: new ALStorageHealth({ storeId: 'ws-client-own-hop-retry', storage: (event) => storage.push(event) }),
        ownership,
        ...TEST_CHECKPOINT_SETTINGS,
        timers: GLOBAL_CHECKPOINT_TIMERS
    });
    // A browser hands its WS client a started engine, whose first pass opens the lane's stores and restores the checkpoint.
    const queueEngine = new InboxOutboxEngine();
    queueEngine.start();
    const service = createDefaultWsQueueBoxClientService({
        queueEngine,
        outbox: new InMemoryQueueBox(new Map()),
        socket,
        sessionId: 'self',
        serverPeerId: SERVER_PEER_ID,
        outboundCheckpointStores: checkpointStores,
        durableWorkOwnership: ownership
    }).enableDefaultCallbacks();
    onTestFinished(() => {
        service.close();
        queueEngine.stop();
    });
    return { service, sentFrames: native.sent, checkpointStores, observer, storage };
}

/** Admits a message and waits for the one owner batch the admission committed, the way the worker does. */
async function enqueueAndSettle(service: WsQueueBoxClientService, msg: ALMessage): Promise<void> {
    const result = await service.enqueueOutboxIfAbsent(msg);
    expect(result.verdict).toMatchObject({ kind: 'admitted' });
    await settleCommittedOutboundBatch();
}

/** The shape the browser gives a command channel send addressed to the server (`sendWs` with a `peerId`). */
function serverCommand(qos: ALQosPolicyRequest = ONE_RETRY): ALMessage {
    return newALUnicastMessage(
        'self',
        { topicId: 'room.relic.command', resourceId: 'command-1', contextId: ROOM.groupId },
        SERVER_PEER_ID,
        'relic.command.v1',
        { kind: 'start-expedition' },
        { groupRef: ROOM, ownership: 'shared', reliability: 'at-least-once', ack: 'receiver', qos }
    );
}

/** One sequence of an ordered at-least-once room send, which the WS client sends through its server hop. */
function orderedRoomSend(seq: number): ALMessage {
    return newALBroadcastMessage(
        'self',
        { topicId: 'room.chat', resourceId: `chat-${seq}`, contextId: ROOM.groupId },
        'room',
        'chat.message.v1',
        { seq },
        { groupRef: ROOM, reliability: 'at-least-once', ordering: { orderingKey: ORDERING_KEY, seq }, qos: ORDERED_ROOM_SEND }
    );
}

/** The server's word, as the client's hop, that the track behind `trigger` misses `missingRanges`. */
function serverGapNack(trigger: ALMessage, missingRanges: readonly ALSeqRange[]): ALMessage {
    return newALNackControlMessage(
        { v: 2, msgId: `server-gap-${trigger.id.msgId}`, senderId: SERVER_PEER_ID, ts: Date.now() },
        {
            msgId: trigger.id.msgId,
            fromPeerId: SERVER_PEER_ID,
            toPeerId: 'self',
            reason: 'gap',
            observedAtEpochMs: Date.now(),
            orderingKey: toALOrderingTrackKey(trigger),
            expectedSeq: missingRanges[0].from,
            missingRanges
        }
    );
}

function receiverRoomSend(): ALMessage {
    return newALBroadcastMessage(
        'self',
        { topicId: 'room.notification', resourceId: 'notice-1', contextId: ROOM.groupId },
        'room',
        'notice.v1',
        { text: 'hello' },
        { groupRef: ROOM, reliability: 'at-least-once', ack: 'receiver', qos: ONE_RETRY }
    );
}

/** The `payload.kind` of every outbound effect row the client's work queue holds; canonical message rows are not effects. */
async function readOutboundEffectKinds(stores: ALOutboundRuntimeStores<ALOutboundTransportMessage>): Promise<readonly string[]> {
    const kinds: string[] = [];
    for (const key of await stores.workQueue.getAllKeys()) {
        const entry = key.topicId === 'AL_OUTBOUND' ? await stores.workQueue.getItem(key) : undefined;
        if (entry) {
            kinds.push((JSON.parse(entry.resource) as { payload: { kind: string; }; }).payload.kind);
        }
    }
    return kinds;
}
