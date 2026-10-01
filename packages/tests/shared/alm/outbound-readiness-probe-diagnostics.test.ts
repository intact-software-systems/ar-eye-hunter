import { Temporal } from '@js-temporal/polyfill';
import { expect, it } from 'vitest';

import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AL_WORK_READINESS_MEMORY_MS } from '@shared/alm/work/al-work-handler.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import '../../setup-browser-indexeddb.ts';
import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

type ReadinessProbeEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'readiness-probe'; }>;
type EffectDrainEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'effect-drain'; }>;

const CLOCK_START_MS = 1_760_000_000_000;
const ACK_TIMEOUT_MS = 1_000;

function createStores(kind: 'memory' | 'indexeddb', nowMs: () => number) {
    const backend = kind === 'memory'
        ? new InMemoryAdmissionBackend(
            createInMemoryALAdmissionState(
                new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(nowMs()))
            ),
            nowMs
        )
        : new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `outbound-readiness-probe-${crypto.randomUUID()}`,
            storeName: 'entries',
            nowMs,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
    const admissionStore = createALOutboundAdmissionStore({
        nowMs,
        canonicalScope: 'outbound-readiness-probe',
        decodePrepared: decodeOutboundTestPayload,
        namespace: 'outbound-readiness-probe',
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { admissionStore, workQueue: backend.workQueue };
}

function probesOf(
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]
): readonly ReadinessProbeEvent[] {
    return diagnostics.filter((event): event is ReadinessProbeEvent => event.kind === 'readiness-probe');
}

function drainsOf(
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]
): readonly EffectDrainEvent[] {
    return diagnostics.filter((event): event is EffectDrainEvent => event.kind === 'effect-drain');
}

/** Runs engine rounds until the owner spends the probe the last invalidation owed it. */
async function runProbedRound(
    engine: InboxOutboxEngine,
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]
): Promise<void> {
    const observed = probesOf(diagnostics).length;
    await expect.poll(async () => {
        await engine.executeOnce();
        return probesOf(diagnostics).length;
    }).toBeGreaterThan(observed);
}

/** Sends one message and waits for the batch its commit runs to report its drain. */
async function sendThroughOwnBatch(
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>,
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[],
    resourceId: string
): Promise<EffectDrainEvent | undefined> {
    const drained = drainsOf(diagnostics).length;
    const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage(resourceId));
    expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: true });
    await expect.poll(() => drainsOf(diagnostics).length).toBeGreaterThan(drained);
    return drainsOf(diagnostics)[drained];
}

interface ProbedRuntimeInput {
    readonly kind: 'memory' | 'indexeddb';
    readonly engine: InboxOutboxEngine;
    readonly clock: { atMs: number; };
    readonly diagnostics: ALOutboundRuntimeDiagnosticsEvent[];
    readonly ackTracking: ALOutboundAckTrackingPlan | undefined;
    /** How far the clock moves while a send's commit runs, before the batch it starts. */
    readonly sendCommitLatencyMs: number;
}

function createProbedRuntime(input: ProbedRuntimeInput): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores: createStores(input.kind, () => input.clock.atMs),
        queueEngine: input.engine,
        nowMs: () => input.clock.atMs,
        diagnostics: (event) => {
            input.diagnostics.push(event);
            if (event.kind === 'commit-phases' && event.origin === 'send') {
                input.clock.atMs += input.sendCommitLatencyMs;
            }
        },
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [{ kind: 'send' }],
            ackTracking: input.ackTracking
        }),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
    });
}

it.each(['memory', 'indexeddb'] as const)(
    'names the invalidation behind every storage probe the outbound owner spends over %s',
    async (kind) => {
        const clock = { atMs: CLOCK_START_MS };
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const engine = new InboxOutboxEngine();
        const runtime = createProbedRuntime({
            kind,
            engine,
            clock,
            diagnostics,
            ackTracking: undefined,
            sendCommitLatencyMs: 0
        });

        await runtime.ready();
        await runProbedRound(engine, diagnostics);

        // The send's own batch claims and completes the one row its commit wrote, so the answer the
        // commit set aside describes storage again: no engine round reads it back.
        const drain = await sendThroughOwnBatch(runtime, diagnostics, 'msg-readiness-probe');
        expect(drain).toMatchObject({ lane: 'durable', claimedCount: 1, completedCount: 1 });
        for (let round = 0; round < 25; round += 1) {
            await engine.executeOnce();
        }
        expect(probesOf(diagnostics)).toHaveLength(1);

        // The announcement another writer makes to every owner on the engine, not this owner's work.
        engine.wakeAfterExternalWrite();
        await runProbedRound(engine, diagnostics);

        clock.atMs += AL_WORK_READINESS_MEMORY_MS;
        await runProbedRound(engine, diagnostics);

        const probes = probesOf(diagnostics);
        expect(probes.map((probe) => probe.cause)).toEqual([
            'no-memory',
            'external-wake',
            'age-bound'
        ]);
        // Each of those is one storage read the page charges to `work-page`, and the drained owner's
        // answer is the same every time: the reads are the invalidations, not the work.
        expect(probes.map((probe) => probe.readyAtMs)).toEqual(['none', 'none', 'none']);
        // The clock this owner runs on never moves inside a probe, so every relayed read cost is
        // exactly zero -- a field the relay dropped would read as `undefined` here instead.
        expect(probes.map((probe) => probe.durationMs)).toEqual([0, 0, 0]);
        expect(new Set(probes.map((probe) => probe.workerId)).size).toBe(1);
        expect(probes[0]?.workerId).toMatch(/^al-outbound:/);
        runtime.dispose();
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'probes after a receipted send\'s batch, which never saw the acknowledgement timeout its commit wrote, over %s',
    async (kind) => {
        const clock = { atMs: CLOCK_START_MS };
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const engine = new InboxOutboxEngine();
        const runtime = createProbedRuntime({
            kind,
            engine,
            clock,
            diagnostics,
            ackTracking: {
                enabled: true,
                timeoutMs: ACK_TIMEOUT_MS,
                maxAttempts: 3,
                expectedPeerIds: ['peer-1'],
                nextHopPeerIds: ['peer-1'],
                mode: 'hop'
            },
            sendCommitLatencyMs: 0
        });

        await runtime.ready();
        await runProbedRound(engine, diagnostics);
        await sendThroughOwnBatch(runtime, diagnostics, 'msg-receipted-probe');
        await runProbedRound(engine, diagnostics);

        // The timeout row's due time reaches the engine from this probe, not from the age bound.
        expect(probesOf(diagnostics).map((probe) => [probe.cause, probe.readyAtMs])).toEqual([
            ['no-memory', 'none'],
            ['own-commit', CLOCK_START_MS + ACK_TIMEOUT_MS]
        ]);
        runtime.dispose();
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'finds the repair its acknowledgement timeout wrote at once, though that timeout ran in the send\'s own clean batch, over %s',
    async (kind) => {
        const clock = { atMs: CLOCK_START_MS };
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const engine = new InboxOutboxEngine();
        const runtime = createProbedRuntime({
            kind,
            engine,
            clock,
            diagnostics,
            ackTracking: {
                enabled: true,
                timeoutMs: ACK_TIMEOUT_MS,
                maxAttempts: 3,
                expectedPeerIds: ['peer-1'],
                nextHopPeerIds: ['peer-1'],
                mode: 'hop'
            },
            sendCommitLatencyMs: ACK_TIMEOUT_MS + 1
        });

        await runtime.ready();
        await runProbedRound(engine, diagnostics);

        // The commit outlasts the acknowledgement timeout, so its own batch claims and completes both
        // rows it wrote: the send, and the timeout, whose attempt commits the next timeout and an
        // immediately-due repair hint. No acknowledgement ever arrives, and the clock stops here.
        const drained = drainsOf(diagnostics).length;
        const drain = await sendThroughOwnBatch(runtime, diagnostics, 'msg-unacknowledged');
        expect(drain).toMatchObject({ lane: 'durable', claimedCount: 2, completedCount: 2 });
        // The repair hint, then the retransmission it commits, are claimed without the clock moving.
        await expect.poll(async () => {
            await engine.executeOnce();
            return drainsOf(diagnostics).slice(drained).reduce((claimed, { claimedCount }) => claimed + claimedCount, 0);
        }).toBeGreaterThanOrEqual(4);

        expect(clock.atMs).toBe(CLOCK_START_MS + ACK_TIMEOUT_MS + 1);
        expect(probesOf(diagnostics).map((probe) => probe.cause).slice(0, 2)).toEqual(['no-memory', 'own-commit']);
        runtime.dispose();
    }
);

it('reports the idle owner\'s probes even where its batch has nothing to report', async () => {
    const clock = { atMs: CLOCK_START_MS };
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const engine = new InboxOutboxEngine();
    const runtime = createProbedRuntime({
        kind: 'memory',
        engine,
        clock,
        diagnostics,
        ackTracking: undefined,
        sendCommitLatencyMs: 0
    });

    await runtime.ready();
    for (let round = 0; round < 3; round += 1) {
        await runProbedRound(engine, diagnostics);
        clock.atMs += AL_WORK_READINESS_MEMORY_MS;
    }

    // An owner with nothing to do still reads storage once per aged-out answer, and no batch runs to
    // report it: without the probe those reads are invisible to every consumer of this topic.
    expect(probesOf(diagnostics).map((probe) => probe.cause)).toEqual([
        'no-memory',
        'age-bound',
        'age-bound'
    ]);
    expect(drainsOf(diagnostics)).toHaveLength(1);
    runtime.dispose();
});
