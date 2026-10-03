import '../../../setup-browser-indexeddb.ts';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createCheckpointALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createTakeableDurableWorkOwnership,
    GLOBAL_CHECKPOINT_TIMERS,
    TEST_CHECKPOINT_SETTINGS
} from '../checkpoint/al-checkpoint-test-support.ts';
import {
    createOutboundMessage,
    createVolatileOutboundTestStores,
    holdOutboundClaims,
    OUTBOUND_LEASE_RECOVERY_BOUND_MS
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';
import { createOutboundTestSession, createSessionOutboundTestRuntime } from '../session-outbound-test-runtime.ts';

const STORE_ID = 'browser-ws-client-checkpoint:session-1';
const QUOTA = new DOMException('full', 'QuotaExceededError');

describe('the checkpoint lane of an outbound runtime', () => {
    it('admits a checkpointed send from memory, durable only in the runtime that owns the work, and stamps its settlements', async () => {
        const owner = createCheckpointTestRuntime({ dbName: newDbName(), owned: true });
        const other = createCheckpointTestRuntime({ dbName: newDbName(), owned: false });

        const owned = await owner.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-owner'));
        const local = await other.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-other'));

        expect(owned.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 1 });
        expect(local.verdict).toEqual({ kind: 'admitted', durable: false, queuedAttempts: 1 });
        await vi.waitFor(() => expect([...owner.sent, ...other.sent]).toEqual(['checkpoint-owner', 'checkpoint-other']));
        expect(new Set(owner.settlements.map((event) => event.lane))).toEqual(new Set(['checkpoint']));
    });

    it('keeps a checkpointed send in memory, never durable, in a runtime that holds no checkpoint lane', async () => {
        const memoryOnly = createCheckpointTestRuntime({ dbName: newDbName(), owned: true, withoutCheckpointLane: true });

        const admitted = await memoryOnly.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-in-memory'));

        expect(admitted.verdict).toEqual({ kind: 'admitted', durable: false, queuedAttempts: 1 });
        await vi.waitFor(() => expect(memoryOnly.sent).toEqual(['checkpoint-in-memory']));
        expect(new Set(memoryOnly.settlements.map((event) => event.lane))).toEqual(new Set(['volatile']));
        expect(memoryOnly.observer.getCounts().total).toBe(0);
    });

    it('restores a reloaded document\'s unsent message before its first batch and sends it once', async () => {
        const dbName = newDbName();
        const reloaded = createCheckpointTestRuntime({ dbName, owned: true });
        await reloaded.runtime.ready();
        const held = holdOutboundClaims(reloaded.checkpointStores);
        await reloaded.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-unsent'));
        reloaded.runtime.flushCheckpoint();
        await vi.waitFor(() => expect(reloaded.observer.getCounts().byKind.write).toBe(1));
        reloaded.runtime.dispose();
        await held.release();

        const restored = createCheckpointTestRuntime({ dbName, owned: true });
        await restored.runtime.ready();

        await vi.waitFor(() => expect(restored.sent).toEqual(['checkpoint-unsent']));
        expect(reloaded.sent).toEqual([]);
        expect(restored.storage.filter((event) => event.kind === 'recovery')).toEqual([
            { kind: 'recovery', storeId: STORE_ID, outcome: { kind: 'restored', claimed: 1, expired: 0 } }
        ]);
    });

    it('restores a closed owner\'s checkpointed message when the next runtime of the session takes over, and sends it once', async () => {
        const session = createOutboundTestSession();
        const closing = createSessionOutboundTestRuntime(session, createTakeableDurableWorkOwnership(true));
        const waiting = createSessionOutboundTestRuntime(session, createTakeableDurableWorkOwnership(false));
        await Promise.all([closing.runtime.ready(), waiting.runtime.ready()]);
        const held = holdOutboundClaims(closing.checkpointStores);
        await closing.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-left'));
        closing.runtime.flushCheckpoint();
        await vi.waitFor(() => expect(session.checkpointObserver.getCounts().byKind.write).toBe(1));
        closing.runtime.dispose();
        await held.release();

        waiting.ownership.take();

        await vi.waitFor(() => expect(waiting.sent).toEqual(['checkpoint-left']));
        expect(closing.sent).toEqual([]);
        await vi.waitFor(() =>
            expect(session.checkpointStorage.filter((event) => event.kind === 'recovery').at(-1)).toEqual({
                kind: 'recovery',
                storeId: 'session-outbound-checkpoint',
                outcome: { kind: 'restored', claimed: 1, expired: 0 }
            })
        );
    });

    it('claims a row a reloaded document left reserved once the row\'s lease ends', async () => {
        const dbName = newDbName();
        const clock = { nowMs: Date.now() };
        const reloaded = createCheckpointTestRuntime({ dbName, owned: true, clock, holdSends: true });
        await reloaded.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-reserved'));
        await vi.waitFor(() => expect(reloaded.attempted).toEqual(['checkpoint-reserved']));
        reloaded.runtime.flushCheckpoint();
        await vi.waitFor(() => expect(reloaded.observer.getCounts().byKind.write).toBe(1));
        reloaded.runtime.dispose();
        clock.nowMs += OUTBOUND_LEASE_RECOVERY_BOUND_MS;

        const restored = createCheckpointTestRuntime({ dbName, owned: true, clock });
        await restored.runtime.ready();

        await vi.waitFor(() => expect(restored.sent).toEqual(['checkpoint-reserved']));
    });

    // Refusing a send while the lag stands is the browser dispatch's: the lane states the lag and keeps sending.
    it('states delayed then failing with checkpoint-lag while its checkpoints fail, and healthy once one completes', async () => {
        const failing = { writes: true };
        const lane = createCheckpointTestRuntime({
            dbName: newDbName(),
            owned: true,
            settings: { intervalMs: 20, lagBoundMs: 100 },
            fault: {
                observe: (operation) => failing.writes && operation.kind === 'write' ? Promise.reject(QUOTA) : undefined
            }
        });

        await lane.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-unsaved'));
        await vi.waitFor(() => expect(lane.readStatuses()).toEqual(['delayed', 'failing']));
        const lagging = await lane.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-while-lagging'));
        failing.writes = false;

        await vi.waitFor(() => expect(lane.readStatuses()).toEqual(['delayed', 'failing', 'healthy']));
        expect(lagging.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(lane.storage.find((event) => event.kind === 'health' && event.status === 'failing')).toMatchObject({
            lastFailure: {
                cause: 'checkpoint-lag',
                detail: expect.stringMatching(
                    /^The oldest unsaved change is \d+ ms old, beyond the 100 ms bound\. The last checkpoint failed: QuotaExceededError: full$/
                )
            }
        });
        await vi.waitFor(() => expect(lane.sent).toEqual(['checkpoint-unsaved', 'checkpoint-while-lagging']));
    });
});

interface CheckpointTestRuntimeInput {
    readonly dbName: string;
    readonly owned: boolean;
    readonly settings?: ALCheckpointWriter.Settings;
    /** Asked before each storage operation of the checkpoint store, after the counting observer. */
    readonly fault?: IndexedDbOperationObserver;
    readonly clock?: { readonly nowMs: number; };
    /** Every attempt starts and none settles, as a document that reloads mid-send leaves it. */
    readonly holdSends?: boolean;
    /** A runtime built without the checkpoint pair, as the server's and Node's are. */
    readonly withoutCheckpointLane?: boolean;
}

function createCheckpointTestRuntime(input: CheckpointTestRuntimeInput) {
    const settlements: ALDeliverySettlement[] = [];
    const sent: string[] = [];
    const attempted: string[] = [];
    const nowMs = () => input.clock?.nowMs ?? Date.now();
    const observer = createCheckpointTestObserver(input.fault);
    const ownership = createTakeableDurableWorkOwnership(input.owned);
    const { checkpointStores, storage } = createCheckpointTestStores(input, ownership, observer);
    const runtime: ALOutboundMessageRuntime<OutboundTestPayload> = createDefaultALOutboundMessageRuntime({
        decodePreparedMessage: decodeOutboundTestPayload,
        queueEngine: new InboxOutboxEngine(),
        outbox: new InMemoryQueueBox(new Map()),
        volatileStores: createVolatileOutboundTestStores(),
        checkpointStores: input.withoutCheckpointLane === true ? undefined : checkpointStores,
        durableWorkOwnership: ownership,
        nowMs,
        carrier: 'ws',
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'checkpoint',
            preparedMessages: [{ peer: 'receiver' }]
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            attempted.push(lifecycle.canonicalMessage.route.resourceId);
            if (input.holdSends === true) {
                return await new Promise(() => undefined);
            }
            sent.push(lifecycle.canonicalMessage.route.resourceId);
            return { status: 'sent', submissionAttempted: true };
        },
        settlements: (event) => settlements.push(event)
    });
    onTestFinished(() => runtime.dispose());
    return {
        runtime,
        checkpointStores,
        observer,
        storage,
        settlements,
        sent,
        attempted,
        readStatuses: () => storage.flatMap((event) => event.kind === 'health' ? [event.status] : [])
    };
}

/** Counts every operation of the checkpoint store, then lets the test's fault answer it. */
function createCheckpointTestObserver(fault: IndexedDbOperationObserver | undefined): CountingIndexedDbOperationObserver {
    const counting = createCountingIndexedDbOperationObserver();
    return {
        ...counting,
        observe: (operation) => {
            counting.observe(operation);
            return fault?.observe(operation);
        }
    };
}

/** The checkpoint pair under the runtime's ownership, and the storage events its store states. */
function createCheckpointTestStores(
    input: CheckpointTestRuntimeInput,
    ownership: ALDurableWorkOwnership,
    observer: CountingIndexedDbOperationObserver
) {
    const storage: ALStorageEvent[] = [];
    const checkpointStores = createCheckpointALOutboundRuntimeStores<OutboundTestPayload>({
        dbName: input.dbName,
        namespace: `browser:${STORE_ID}`,
        nowMs: () => input.clock?.nowMs ?? Date.now(),
        observer,
        decodePrepared: decodeOutboundTestPayload,
        storageHealth: new ALStorageHealth({ storeId: STORE_ID, storage: (event) => storage.push(event) }),
        ownership,
        ...(input.settings ?? TEST_CHECKPOINT_SETTINGS),
        timers: GLOBAL_CHECKPOINT_TIMERS
    });
    return { checkpointStores, storage };
}

function newDbName(): string {
    return `al-checkpoint-lane-${crypto.randomUUID()}`;
}
