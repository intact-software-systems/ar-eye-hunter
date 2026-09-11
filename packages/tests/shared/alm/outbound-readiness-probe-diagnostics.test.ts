import { expect, it } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AL_WORK_READINESS_MEMORY_MS } from '@shared/alm/work/al-work-handler.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import '../../setup-browser-indexeddb.ts';
import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

type ReadinessProbeEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'readiness-probe'; }>;

const CLOCK_START_MS = 1_760_000_000_000;

function createStores(kind: 'memory' | 'indexeddb', nowMs: () => number) {
    const backend = kind === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), nowMs)
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

function probesOf(diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]): readonly ReadinessProbeEvent[] {
    return diagnostics.filter((event): event is ReadinessProbeEvent => event.kind === 'readiness-probe');
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

it.each(['memory', 'indexeddb'] as const)(
    'names the invalidation behind every storage probe the outbound owner spends over %s',
    async (kind) => {
        let clockMs = CLOCK_START_MS;
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const engine = new InboxOutboxEngine();
        const runtime = createDefaultOutboundTestRuntime({
            stores: createStores(kind, () => clockMs),
            queueEngine: engine,
            nowMs: () => clockMs,
            diagnostics: (event) => diagnostics.push(event),
            planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ kind: 'send' }] }),
            sendPreparedMessage: async () => ({ status: 'sent' as const })
        });

        await runtime.ready();
        await runProbedRound(engine, diagnostics);

        // The commit runs a batch of its own, and that batch's invalidation must not take its credit.
        const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage('msg-readiness-probe'));
        await runProbedRound(engine, diagnostics);

        // The announcement another writer makes to every owner on the engine, not this owner's work.
        engine.wakeAfterExternalWrite();
        await runProbedRound(engine, diagnostics);

        clockMs += AL_WORK_READINESS_MEMORY_MS;
        await runProbedRound(engine, diagnostics);

        expect(enqueued.status).toBe('enqueued');
        const probes = probesOf(diagnostics);
        expect(probes.map((probe) => probe.cause)).toEqual([
            'no-memory',
            'own-commit',
            'external-wake',
            'age-bound'
        ]);
        // Each of those is one storage read the page charges to `work-page`, and the drained owner's
        // answer is the same every time: the reads are the invalidations, not the work.
        expect(probes.map((probe) => probe.readyAtMs)).toEqual(['none', 'none', 'none', 'none']);
        expect(new Set(probes.map((probe) => probe.workerId)).size).toBe(1);
        expect(probes[0]?.workerId).toMatch(/^al-outbound:/);
        runtime.dispose();
    }
);

it('reports the idle owner\'s probes even where its batch has nothing to report', async () => {
    let clockMs = CLOCK_START_MS;
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const engine = new InboxOutboxEngine();
    const runtime = createDefaultOutboundTestRuntime({
        stores: createStores('memory', () => clockMs),
        queueEngine: engine,
        nowMs: () => clockMs,
        diagnostics: (event) => diagnostics.push(event),
        planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ kind: 'send' }] }),
        sendPreparedMessage: async () => ({ status: 'sent' as const })
    });

    await runtime.ready();
    for (let round = 0; round < 3; round += 1) {
        await runProbedRound(engine, diagnostics);
        clockMs += AL_WORK_READINESS_MEMORY_MS;
    }

    // An owner with nothing to do still reads storage once per aged-out answer, and no batch runs to
    // report it: without the probe those reads are invisible to every consumer of this topic.
    expect(probesOf(diagnostics).map((probe) => probe.cause)).toEqual(['no-memory', 'age-bound', 'age-bound']);
    expect(diagnostics.filter((event) => event.kind === 'effect-drain').length).toBe(1);
    runtime.dispose();
});
