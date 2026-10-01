import 'fake-indexeddb/auto';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import { decodeALAdmissionString } from '@shared/alm/al-admission-value-validation.ts';
import {
    createVolatileALInboundRuntimeStores,
    createVolatileALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    AL_OUTBOUND_WORK_PAGE_SIZE,
    readALOutboundWorkReadyAt,
    type ALOutboundDequeueDeferral
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import type {
    IndexedDbOperationCounts,
    IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, toResourceEntryWithKey, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    readInboundTestAdmission,
    type InboundTestRuntime
} from './inbound-runtime-test-fixture.ts';
import {
    createDefaultOutboundTestRuntime,
    createIndexedDbOutboundCountStores,
    createOutboundMessage,
    runOutboundWorkTask
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';
import { toTestALWorkReadySelection } from './work/al-work-test-entries.ts';

const NOW_MS = 1_700_000_000_000;
const INBOUND_NAMESPACE = 'al-inbound-counts';
const INBOUND_WORKER_ID = 'al-inbound:counts';
/** Rounds a drain needs at worst: the rotation walks three statuses before it scans NEW again. */
const INBOUND_ROTATION_ROUND_LIMIT = 16;
/**
 * A hundred engine passes at the engine's fixed 100 ms delay: ten idle seconds of a rotation with
 * nothing to claim, so a bound per round is also the bound per second the relay has to hold.
 */
const INBOUND_IDLE_ROUNDS = 100;
/** Far above the 4 per hundred rounds the outbound owner spends, whose probe answer stands for the idle ceiling. */
const INBOUND_IDLE_ROUNDS_PROBED_AT_LEAST = INBOUND_IDLE_ROUNDS / 2;
const WORK_TYPES = ['AL_OUTBOUND:counts', 'WS_OUTBOX'] as const;
/** The resource inbox's timeout-claim and fairness rate-limit window, so the pin crosses at least one of each. */
const IDLE_OWNER_RATE_WINDOW_MS = 60_000;
const NO_DEFERRAL: ALOutboundDequeueDeferral = { types: new Set<string>(), readyAtMs: undefined };

describe('AL-owned IndexedDB operation counts', () => {
    it('counts admission reads, writes, and work operations through the backend', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const backend = new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `al-counts-${crypto.randomUUID()}`,
            storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
            nowMs: () => 1_000,
            newWriteToken: () => crypto.randomUUID(),
            observer
        });
        await backend.ready();

        await backend.read('missing', decodeALAdmissionString);
        await backend.write(async (tx) => {
            await tx.set('present', 'value');
        });
        await backend.workQueue.readWorkPage({
            typeId: 'AL_OUTBOUND:test',
            status: 'NEW',
            maxToRead: 4,
            cursor: null
        });

        const counts = observer.getCounts();
        expect(counts.byOwner['al-admission']).toBe(2);
        expect(counts.byKind.read).toBe(1);
        expect(counts.byKind.write).toBe(1);
        expect(counts.byKind['work-page']).toBe(1);
        expect(counts.byOwner['al-work']).toBe(1);
    });
});

describe('outbound work owner IndexedDB scan volume', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('spends one work-page operation, in one readonly transaction, on one readiness probe', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const port = createOutboundWorkPort(observer);
        await port.retainIfAbsent(newOutboundWorkEntry(WORK_TYPES[0], 'due-now'));
        const opened = countReadonlyTransactions();
        const before = observer.getCounts().byKind['work-page'] ?? 0;

        const readyAtMs = await readALOutboundWorkReadyAt(port, NOW_MS, NO_DEFERRAL);

        expect(readyAtMs).toBe(NOW_MS);
        expect((observer.getCounts().byKind['work-page'] ?? 0) - before).toBe(1);
        expect(opened.count()).toBe(1);
    });

    it('answers from every scanned status and every work type, exactly as the status-by-status scan did', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const port = createOutboundWorkPort(observer);

        expect(await readALOutboundWorkReadyAt(port, NOW_MS, NO_DEFERRAL)).toBeUndefined();

        // Only the second work type holds a row: a probe that stopped at the first type would miss it.
        await port.retainIfAbsent(newOutboundWorkEntry(WORK_TYPES[1], 'second-type'));
        expect(await readALOutboundWorkReadyAt(port, NOW_MS, NO_DEFERRAL)).toBe(NOW_MS);
        expect(await readALOutboundWorkReadyAt(port, NOW_MS, { types: new Set(WORK_TYPES), readyAtMs: NOW_MS + 60_000 }))
            .toBe(NOW_MS + 60_000);

        // Claiming moves the row to RESERVED, which the scan still reads: it now answers at the lease end.
        expect(await port.claim({ maxCount: AL_OUTBOUND_WORK_PAGE_SIZE, observedEntries: undefined })).toHaveLength(1);
        expect(await readALOutboundWorkReadyAt(port, NOW_MS, NO_DEFERRAL)).toBe(NOW_MS + AL_OUTBOUND_WORK_LEASE_MS);
    });

    it('costs four work-page operations over ten idle seconds of engine passes', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const port = createOutboundWorkPort(observer);
        let nowMs = NOW_MS;
        const engine = new InboxOutboxEngine();
        const handler = new ALWorkHandler({
            workerId: 'al-outbound:counts',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: (probed) => readALOutboundWorkReadyAt(probed, nowMs, NO_DEFERRAL),
            selectReady: async (claimed, size) => toTestALWorkReadySelection(await claimed.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();
        const before = observer.getCounts().byKind['work-page'] ?? 0;

        // A hundred engine passes at the engine's fixed 100 ms delay: ten idle seconds of an owner
        // with nothing to do, which is the shape the hosted runner spent 61 % of its storage on.
        for (let pass = 0; pass < 100; pass += 1) {
            await engine.executeOnce();
            nowMs += 100;
        }

        expect((observer.getCounts().byKind['work-page'] ?? 0) - before).toBe(4);
        handler.dispose();
    });
    it('claims a row an external writer enqueued once a wake announces it', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const port = createOutboundWorkPort(observer);
        const claimed: string[] = [];
        const engine = new InboxOutboxEngine();
        const handler = new ALWorkHandler({
            workerId: 'al-outbound:external-wake',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => NOW_MS },
            pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: (probed) => readALOutboundWorkReadyAt(probed, NOW_MS, NO_DEFERRAL),
            selectReady: async (claimable, size) => toTestALWorkReadySelection(await claimable.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async (claim) => {
                claimed.push(claim.entry.key.contextId);
                return { status: 'completed' };
            },
            diagnostics: undefined
        });

        await handler.ready();
        await engine.executeOnce();

        // The row reaches the queue without this runtime's admission: only the external-write wake
        // announces it.
        await port.retainIfAbsent(newOutboundWorkEntry(WORK_TYPES[1], 'external-write'));
        engine.wakeAfterExternalWrite();
        await engine.executeOnce();

        await vi.waitFor(() => expect(claimed).toEqual(['external-write']));
        handler.dispose();
    });
});

describe('outbound default send IndexedDB volume', () => {
    it('sends one durable message in 10 al-admission and 11 al-work operations', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const runtime = createDefaultOutboundTestRuntime({
            stores: createIndexedDbOutboundCountStores(observer, 'outbound-default-send'),
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, persist: true, preparedMessages: [{ kind: 'send' }] }),
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
        });

        const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage('msg-default-send'));
        expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: true });
        await runOutboundWorkTask(runtime);

        const counts = observer.getCounts();
        // These figures protect the default send's admission and work I/O budget.
        expect(counts.byOwner['al-admission'], 'one default send spends 10 al-admission operations today').toBe(10);
        expect(
            counts.byOwner['al-work'],
            'one default send spends 11 al-work operations: its decision read holds the effect row and canonical pair its commit fences, so the commit re-reads neither, and its claim takes the committed canonical pair in memory instead of two work reads'
        ).toBe(11);
        runtime.dispose();
    });
});

describe('outbound volatile send IndexedDB volume', () => {
    it('sends one volatile message beside a durable pair in 0 al-admission and 0 non-probe al-work operations', async () => {
        const budget = createDefaultSessionBudget();
        const observer = createCountingIndexedDbOperationObserver();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createIndexedDbOutboundCountStores(observer, 'outbound-volatile-send'),
            volatileStores: createVolatileALOutboundRuntimeStores({
                decodePrepared: decodeOutboundTestPayload
            }, budget),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            }),
            sendPreparedMessage: async () => {
                sent.push('send');
                return { status: 'sent' as const, submissionAttempted: true };
            }
        });
        await runtime.ready();
        observer.reset();

        const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage('msg-volatile-send'));
        expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: false });
        // The volatile lane's own commit runs its batch, as in production. `runOutboundWorkTask` would
        // also run the idle durable lane's batch directly, a claim the engine never makes without a
        // due probe answer.
        await vi.waitFor(() => expect(sent).toEqual(['send']));

        const counts = observer.getCounts();
        // A volatile default leaves nothing in IndexedDB; only the idle durable owner's probes
        // (work-page, work-probe) may read it.
        expect(counts.byOwner['al-admission'], 'a volatile send commits nothing to IndexedDB').toBe(
            0
        );
        expect(computeNonProbeWorkOperations(counts), 'no non-probe al-work operation').toBe(0);
        // S3c-ii (D74): the session budget counts the send in memory and moves no IndexedDB counter.
        expect(budget.readUsage(Date.now()).admissions, 'the bounded send is counted once').toBe(1);
        runtime.dispose();
    });
});

// The first use runs the durable owner's lazy bootstrap batch (`enqueueIfAbsent` awaits
// `ready()`); empty finalize, claim, and timeout-claim reads are probes.
describe('an idle durable outbound owner beside a volatile send', () => {
    // The cold runtime pays bootstrap inside the first send's window, and never again.
    it('spends only probes on a cold runtime\'s first volatile send and nothing on its second', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createIndexedDbOutboundCountStores(observer, 'outbound-cold-durable-owner'),
            volatileStores: createVolatileALOutboundRuntimeStores({ decodePrepared: decodeOutboundTestPayload }, undefined),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            }),
            sendPreparedMessage: async () => {
                sent.push('send');
                return { status: 'sent' as const, submissionAttempted: true };
            }
        });

        await runtime.enqueueIfAbsent(createOutboundMessage('msg-cold-volatile-first'));
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        const first = observer.getCounts();
        observer.reset();
        await runtime.enqueueIfAbsent(createOutboundMessage('msg-cold-volatile-second'));
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        const second = observer.getCounts();

        expect(first.byOwner['al-admission'], 'the bootstrap reads no admission row').toBe(0);
        expect(first.byKind['work-probe'] ?? 0, 'the bootstrap inspects the empty queue').toBeGreaterThan(0);
        expect(computeNonProbeWorkOperations(first), 'the bootstrap changes nothing').toBe(0);
        expect(second.total, 'a warm runtime spends nothing on a volatile send').toBe(0);
        runtime.dispose();
    });

    it('spends only probes on batches over an empty queue across the readiness memory and the rate window', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const observer = createCountingIndexedDbOperationObserver();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createIndexedDbOutboundCountStores(observer, 'outbound-idle-durable-owner'),
            volatileStores: createVolatileALOutboundRuntimeStores({ decodePrepared: decodeOutboundTestPayload }, undefined),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            }),
            sendPreparedMessage: async () => {
                sent.push('send');
                return { status: 'sent' as const, submissionAttempted: true };
            }
        });
        await runtime.ready();
        observer.reset();

        await runtime.enqueueIfAbsent(createOutboundMessage('msg-volatile-beside-idle-owner'));
        await vi.waitFor(() => expect(sent).toEqual(['send']));
        const startedAtMs = Date.now();
        while (Date.now() - startedAtMs <= AL_WORK_READINESS_MEMORY_MS + IDLE_OWNER_RATE_WINDOW_MS) {
            vi.setSystemTime(Date.now() + 5_000);
            await runOutboundWorkTask(runtime);
        }

        const counts = observer.getCounts();
        expect(counts.byOwner['al-admission']).toBe(0);
        expect(counts.byKind['work-probe'] ?? 0, 'the idle owner still inspects its queue').toBeGreaterThan(0);
        expect(computeNonProbeWorkOperations(counts), 'a reservation that changed nothing is not work').toBe(0);
        runtime.dispose();
    });
});

describe('inbound work owner IndexedDB scan volume', () => {
    it('drains the dispatch-local row its rotation finds', async () => {
        const drained = await readDrainedInboundRotation();

        expect(drained.committed).toBe('committed');
        expect(drained.delivered).toEqual(['dispatched']);
    });

    it('drains one dispatch-local row in 2 admission operations', async () => {
        expect(
            (await readDrainedInboundRotation()).admissionOperations,
            'inbound rotation over one dispatch-local row: the readiness read takes the message and its ' +
                'planning state, and the dispatch that read cleared reads neither of them again'
        ).toBe(2);
    });

    it('admits one unordered message through the real ingress and dispatches it', async () => {
        const admitted = await readAdmittedInboundDelivery({ volatile: false, durability: undefined });

        expect(admitted.acceptance).toEqual({ kind: 'admitted' });
        expect(admitted.delivered).toEqual(['dispatched']);
    });

    it('admits and delivers one unordered message over a single durable pair in 8 admission operations', async () => {
        expect(
            (await readAdmittedInboundDelivery({ volatile: false, durability: undefined })).admissionOperations,
            'inbound admit to deliver: 6 operations for the admission, and 2 for the drain that dispatches it'
        ).toBe(8);
    });

    it('admits and delivers one volatile message beside a durable pair in 0 admission and 0 non-probe work operations', async () => {
        const admitted = await readAdmittedInboundDelivery({ volatile: true, durability: undefined });

        expect(admitted.acceptance).toEqual({ kind: 'admitted' });
        expect(admitted.delivered).toEqual(['dispatched']);
        // The volatile default admits to the memory pair.
        expect(admitted.admissionOperations).toBe(0);
        expect(admitted.nonProbeWorkOperations).toBe(0);
        expect(admitted.budgetAdmissions, 'the bounded arrival is counted in memory').toBe(1);
    });

    it('still admits a local-inbox message beside a volatile pair in 8 admission operations', async () => {
        expect(
            (await readAdmittedInboundDelivery({ volatile: true, durability: 'local-inbox' }))
                .admissionOperations
        ).toBe(8);
    });

    it('answers an acknowledgement of its own message without reading any store', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const fixture = createInboundTestRuntime({
            carrier: 'ws',
            stores: createInboundTestStores({
                namespace: INBOUND_NAMESPACE,
                storage: 'indexeddb',
                observer
            }),
            effectWorkerId: INBOUND_WORKER_ID
        });
        await fixture.runtime.ready();
        observer.reset();

        const admitted = await fixture.runtime.admitIncomingMessage(
            newALAckControlMessage(
                {
                    v: 2,
                    msgId: 'ack-own-message',
                    senderId: INBOUND_TEST_SENDER_PEER_ID,
                    ts: Date.now()
                },
                {
                    ackedMsgId: 'own-message',
                    fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
                    toPeerId: INBOUND_TEST_SELF_PEER_ID,
                    originPeerId: INBOUND_TEST_SELF_PEER_ID,
                    logicalRecipientPeerId: INBOUND_TEST_SENDER_PEER_ID,
                    carrier: 'ws',
                    status: 'delivered',
                    observedAtEpochMs: Date.now()
                }
            ),
            INBOUND_TEST_SOURCE
        );

        expect(admitted.right).toEqual({ kind: 'control', handled: false });
        expect(observer.getCounts().byOwner['al-admission']).toBe(0);
    });

    it.each(['empty-queue', 'deferred-row'] as const)(
        'probes storage on every idle rotation round and relays nothing for it, scanning an %s',
        async (scanned) => {
            const idle = await readIdleInboundRotation(scanned);

            // The rotation carries its scan position inside the read, so no answer of its own can
            // stand and every round reaches storage. That is also why the runtime relays no
            // `readiness-probe`: one event per engine round is a round trip out of the page in the
            // conformance lane, which doubled its per-operation cost and failed the RTC cell.
            expect(idle.workPages).toBeGreaterThan(INBOUND_IDLE_ROUNDS_PROBED_AT_LEAST);
            expect(idle.workPages).toBeLessThanOrEqual(INBOUND_IDLE_ROUNDS);
            // `rotation-alive` is the one thing an idle rotation may say, and it says it once per
            // `AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS` rounds rather than once per round.
            expect(idle.relayedKinds.filter((kind) => kind !== 'rotation-alive')).toEqual([]);
        }
    );

    it('spends only probes on an idle rotation over an empty queue', async () => {
        const idle = await readIdleInboundRotation('empty-queue');

        // A claim that observed nothing opens no transaction, and an exhausted-retry finalization that
        // finds nothing is the idle owner's probe: the non-probe window reads zero beside it.
        expect(idle.nonProbeWorkOperations).toBe(0);
        expect(idle.workProbes).toBeGreaterThan(0);
    });
});

describe('work batch release volume', () => {
    it('releases one batch of completed claims in 1 work-release operation', async () => {
        expect(await readCompletedBatchReleaseOperations(4)).toBe(1);
    });
});

/**
 * One batch of `claimCount` retained rows run to completion, counted by `work-release` alone.
 *
 * The engine's own task pump starts a batch and returns without awaiting it (`ComputeAsyncTask`
 * tracks the runnable rather than blocking the pump on it), so `engine.executeOnce()` resolves
 * before the batch's own releases land. The `work-batch` diagnostic fires only once every claim in
 * the batch released, so waiting on it -- rather than on `executeOnce()` alone -- is what makes
 * this measurement observe the batch's completed cost instead of a mid-flight snapshot.
 */
async function readCompletedBatchReleaseOperations(claimCount: number): Promise<number> {
    const observer = createCountingIndexedDbOperationObserver();
    const port = createOutboundWorkPort(observer);
    const engine = new InboxOutboxEngine();
    let onBatchSettled: () => void;
    const batchSettled = new Promise<void>((resolve) => {
        onBatchSettled = resolve;
    });
    const handler = new ALWorkHandler({
        workerId: 'al-outbound:batched-release',
        port,
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: () => NOW_MS },
        pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
        readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
        readNextReadyAtMs: (probed) => readALOutboundWorkReadyAt(probed, NOW_MS, NO_DEFERRAL),
        selectReady: async (claimable, size) =>
            toTestALWorkReadySelection(
                await claimable.claim({ maxCount: size, observedEntries: undefined })
            ),
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: (event) => {
            if (event.kind === 'work-batch' && event.completedCount === claimCount) {
                onBatchSettled();
            }
        }
    });
    await handler.ready();
    for (let index = 0; index < claimCount; index += 1) {
        await port.retainIfAbsent(newOutboundWorkEntry(WORK_TYPES[0], `batched-${index}`));
    }
    // The rows reach the queue behind the handler's back, so only this wake announces them.
    engine.wakeAfterExternalWrite();
    const before = observer.getCounts().byKind['work-release'] ?? 0;
    await engine.executeOnce();
    await batchSettled;
    const released = (observer.getCounts().byKind['work-release'] ?? 0) - before;
    handler.dispose();
    return released;
}

interface IdleInboundRotation {
    readonly workPages: number;
    readonly workProbes: number;
    /** Every `al-work` operation but the probes (`work-page`, `work-probe`). */
    readonly nonProbeWorkOperations: number;
    readonly relayedKinds: readonly ALInboundRuntimeDiagnosticsEvent['kind'][];
}

/** An owner with an empty queue, driven for ten idle seconds of engine passes and nothing else. */
async function readIdleInboundRotation(scanned: 'empty-queue' | 'deferred-row'): Promise<IdleInboundRotation> {
    const observer = createCountingIndexedDbOperationObserver();
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({ namespace: INBOUND_NAMESPACE, storage: 'indexeddb', observer }),
        effectWorkerId: INBOUND_WORKER_ID,
        canDispatchMessage: () => false
    });
    await fixture.runtime.ready();
    if (scanned === 'deferred-row') {
        await fixture.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'idle-rotation' }),
            INBOUND_TEST_SOURCE
        );
    }
    // The batch a commit schedules for itself is not awaited by its caller: let it leave the window.
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.reset();
    const eventsBefore = fixture.diagnostics.length;

    for (let round = 0; round < INBOUND_IDLE_ROUNDS; round += 1) {
        await fixture.queueEngine.executeOnce();
        // A round whose task is still in flight asks the owner nothing: let the pass before it end.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const counts = observer.getCounts();
    return {
        workPages: counts.byKind['work-page'] ?? 0,
        workProbes: counts.byKind['work-probe'] ?? 0,
        nonProbeWorkOperations: computeNonProbeWorkOperations(counts),
        relayedKinds: fixture.diagnostics.slice(eventsBefore).map((event) => event.kind)
    };
}

interface DrainedInboundRotation {
    readonly committed: 'committed' | 'conflict' | 'expired';
    readonly delivered: readonly string[];
    readonly admissionOperations: number;
}

/**
 * A row committed outside the owner's own drain, so the rotation that finds it is the only thing
 * inside the measured window. Rounds that scan an empty status cost no admission operation at all,
 * which is what makes this count one rotation's and not the whole walk's.
 */
async function readDrainedInboundRotation(): Promise<DrainedInboundRotation> {
    const observer = createCountingIndexedDbOperationObserver();
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({ namespace: INBOUND_NAMESPACE, storage: 'indexeddb', observer }),
        effectWorkerId: INBOUND_WORKER_ID
    });
    await fixture.runtime.ready();
    const admissionStore = fixture.stores.admissionStore;
    const message = createInboundTestMessage({ msgId: 'rotation-drain' });
    const committed = await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, message));
    observer.reset();

    await runInboundRotationUntilSettled(fixture, fixture.stores.workQueue);

    return {
        committed,
        delivered: fixture.delivered,
        admissionOperations: observer.getCounts().byOwner['al-admission']
    };
}

interface AdmittedInboundDelivery {
    readonly acceptance: ALInboundMessageRuntime.Acceptance | undefined;
    readonly delivered: readonly string[];
    readonly admissionOperations: number;
    /** Every `al-work` operation but the idle owners' probes (`work-page`, `work-probe`). */
    readonly nonProbeWorkOperations: number;
    /** What the session budget over the memory pair counted: zero when no memory pair admitted it. */
    readonly budgetAdmissions: number;
}

/** The whole path one unordered message walks: its ingress admission, then the drain that dispatches it. */
async function readAdmittedInboundDelivery(
    input: Readonly<{ volatile: boolean; durability: ALDurabilityAlgo | undefined; }>
): Promise<AdmittedInboundDelivery> {
    const observer = createCountingIndexedDbOperationObserver();
    const budget = createDefaultSessionBudget();
    const volatileStores = input.volatile
        ? createVolatileALInboundRuntimeStores({ namespace: `${INBOUND_NAMESPACE}-volatile` }, budget)
        : undefined;
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({ namespace: INBOUND_NAMESPACE, storage: 'indexeddb', observer }),
        volatileStores,
        effectWorkerId: INBOUND_WORKER_ID
    });
    await fixture.runtime.ready();
    observer.reset();

    const admitted = await fixture.runtime.admitIncomingMessage(
        createInboundTestMessage({ msgId: 'admit-to-deliver', durability: input.durability }),
        INBOUND_TEST_SOURCE
    );
    if (volatileStores === undefined || input.durability === 'local-inbox') {
        await runInboundRotationUntilSettled(fixture, fixture.stores.workQueue);
    }
    else {
        // The memory lane's own commit runs the batch that delivers. An engine round would also run
        // the idle IndexedDB rotation's batch -- 1 work-page and 1 work-probe per batch, measured
        // with no message at all -- which is that idle owner's cost, not this message's.
        await vi.waitFor(async () => expect(await readSettledInboundWork(volatileStores.workQueue)).toBe(true));
    }

    const counts = observer.getCounts();
    return {
        acceptance: admitted.right,
        delivered: fixture.delivered,
        admissionOperations: counts.byOwner['al-admission'],
        nonProbeWorkOperations: computeNonProbeWorkOperations(counts),
        budgetAdmissions: budget.readUsage(Date.now()).admissions
    };
}

/**
 * Stops on the settled work row rather than on the dispatch: a claimed row is RESERVED, and a
 * rotation that scanned it there would read its readiness a second time inside the measured window.
 */
async function runInboundRotationUntilSettled(
    fixture: InboundTestRuntime,
    workQueue: QueueBoxResourceEntryRepository
): Promise<void> {
    for (let round = 0; round < INBOUND_ROTATION_ROUND_LIMIT; round += 1) {
        if (await readSettledInboundWork(workQueue)) {
            return;
        }
        await fixture.queueEngine.executeOnce();
        // A batch a commit scheduled for itself is not awaited by its caller: let it reach storage.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function readSettledInboundWork(workQueue: QueueBoxResourceEntryRepository): Promise<boolean> {
    const keys = await workQueue.getAllKeys();
    const rows = await Promise.all(keys.map(async (key) => await workQueue.getItem(key)));
    return rows.length > 0 && rows.every((row) => row?.status === EntityStatus.COMPLETED);
}

/** The production bound over one session's memory pairs (D74). */
function createDefaultSessionBudget(): ALVolatileSessionBudget {
    return new ALVolatileSessionBudget({
        maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
}

/** The durable owners' idle probes (`work-page`, `work-probe`) are reported beside the zero, never in it. */
function computeNonProbeWorkOperations(counts: IndexedDbOperationCounts): number {
    return counts.byOwner['al-work'] - (counts.byKind['work-page'] ?? 0) - (counts.byKind['work-probe'] ?? 0);
}

function createOutboundWorkPort(observer: IndexedDbOperationObserver): ALWorkQueuePort {
    return createALWorkQueuePort({
        queue: new IndexedDbQueueBox({
            dbName: `al-work-counts-${crypto.randomUUID()}`,
            storeName: IndexedDbQueueBox.DEFAULT_STORE_NAME,
            observer,
            now: () => Temporal.Instant.fromEpochMilliseconds(NOW_MS)
        }),
        workTypes: new Set(WORK_TYPES),
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        nowMs: () => NOW_MS,
        random: () => 0.5
    });
}

/** A retained row whose readiness the frozen clock owns, so a probe's answer is a fixed timestamp. */
function newOutboundWorkEntry(typeId: string, effectId: string): ResourceEntry {
    const entry = toResourceEntryWithKey(
        { topicId: 'AL_OUTBOUND', resourceId: 'ns', contextId: effectId },
        typeId,
        { effectId },
        Temporal.Instant.fromEpochMilliseconds(NOW_MS + 600_000)
    );
    const createdAt = Temporal.Instant.fromEpochMilliseconds(NOW_MS).toZonedDateTimeISO('UTC');
    return {
        ...entry,
        audit: { ...entry.audit, createdTs: createdAt.toPlainDateTime(), date: createdAt.toPlainTime() },
        dequeueAudit: { ...entry.dequeueAudit, nextTs: Temporal.Instant.fromEpochMilliseconds(NOW_MS) }
    };
}

/** Counts the readonly transactions one probe opens; one per probe is the contract. */
function countReadonlyTransactions(): { count(): number; } {
    let opened = 0;
    const openTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
    ) {
        if (mode === undefined || mode === 'readonly') {
            opened += 1;
        }
        return openTransaction.call(this, storeNames, mode, options);
    });
    return { count: () => opened };
}
