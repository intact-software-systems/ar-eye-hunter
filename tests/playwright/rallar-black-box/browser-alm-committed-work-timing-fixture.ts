import { Temporal } from '@js-temporal/polyfill';

import { newALUnicastMessage, type ALMessage } from '../../../packages/shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../../../packages/shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '../../../packages/shared/al-contracts/al-policy.ts';
import { normalizeALRuntimeStoreRetention } from '../../../packages/shared/alm/ALStoreRetention.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionStore,
    type ALInboundCommitBundle,
    type ALInboundDurableEffect
} from '../../../packages/shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageAdmission } from '../../../packages/shared/alm/inbound/al-inbound-message-admission.ts';
import {
    ALInboundMessageRuntime,
    type ALInboundRuntimeStores
} from '../../../packages/shared/alm/inbound/al-inbound-message-runtime.ts';
import {
    decodeALInboundWorkEntry,
    resolveALInboundWorkDueAtMs,
    toALInboundWorkType
} from '../../../packages/shared/alm/inbound/al-inbound-work-entry.ts';
import { AL_INBOUND_WORK_LEASE_MS } from '../../../packages/shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '../../../packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { IndexedDbAdmissionBackend } from '../../../packages/shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '../../../packages/shared/alm/open-indexed-db-admission-database.ts';
import {
    computeALWorkLeaseUntilMs,
    createALWorkQueuePort
} from '../../../packages/shared/alm/work/al-work-queue-port.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationCounts
} from '../../../packages/shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '../../../packages/shared/persistence/indexed-db-string-persistence-provider.ts';
import { IndexedDbQueueBox } from '../../../packages/shared/queuebox/indexed-db-queue-box.ts';
import type {
    ResourceInboxFinalizationReservationOptions,
    ResourceInboxReservationRequest,
    ResourceInboxTimeoutReservationRequest,
    ResourceInboxWorkPage
} from '../../../packages/shared/queuebox/queue-box-types.ts';
import { EntityStatus, type ResourceEntry } from '../../../packages/shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '../../../packages/shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '../../../packages/shared/services/queue-box-utilities.ts';
import {
    NativeIndexedDbTimingRecorder,
    type NativeIndexedDbTimingSnapshot
} from './browser-native-indexeddb-timing-recorder.ts';

export type NativeAlmTimingWorkload =
    | 'sparse'
    | 'full-page'
    | 'excess-fanout'
    | 'finite-backlog'
    | 'shared-contention';

export type NativeAlmOperation = 'admission' | 'commit' | 'work-page' | 'reservation' | 'release';

export type NativeAlmCausalPhase =
    | 'pending-admission-retained'
    | 'parent-reserved'
    | 'effects-committed'
    | 'parent-released'
    | 'successor-reserved'
    | 'callback-start'
    | 'callback-end'
    | 'effect-released';

export interface NativeAlmOperationSample {
    readonly operation: NativeAlmOperation;
    readonly outcome: string;
    readonly startedAtMs: number;
    readonly durationMs: number;
}

export interface NativeAlmCausalSample {
    readonly identity: string;
    readonly phase: NativeAlmCausalPhase;
    readonly atMs: number;
    readonly queueAgeMs: number | null;
    readonly leaseMarginMs: number | null;
    readonly deadlineMarginMs: number | null;
}

export interface NativeAlmCausalCoverage {
    readonly identity: string;
    readonly capturedPhases: readonly NativeAlmCausalPhase[];
    readonly uncapturedPhases: readonly NativeAlmCausalPhase[];
}

export interface NativeAlmOperationSummary {
    readonly operation: NativeAlmOperation;
    readonly sampleCount: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
    readonly maxMs: number;
}

export interface NativeAlmTimingProbe {
    readonly workload: NativeAlmTimingWorkload;
    readonly actorId: string;
    readonly databaseId: string;
    readonly measuredTree: 'runtime-base-plus-measurement-instrumentation';
    readonly environment: Readonly<{
        userAgent: string;
        hardwareConcurrency: number;
        performanceTimeOriginMs: number;
    }>;
    readonly durationMs: number;
    readonly failure: string | null;
    readonly throughputPerSecond: number;
    readonly deliveredCount: number;
    readonly observedCommittedEffectIdentityCount: number;
    readonly commitConflictCount: number;
    readonly retryReservationCount: number;
    readonly oldestEligibleAgeMs: number;
    readonly minimumLeaseMarginMs: number | null;
    readonly minimumDeadlineMarginMs: number | null;
    readonly completeCausalIdentityCount: number;
    readonly maximumSuccessorsBeyondRemainingPageCapacity: number;
    readonly recoveredKinds: readonly ('new' | 'retry' | 'expired-reserved')[];
    readonly boundedCommitCount: number;
    readonly waitingEntryCount: number;
    readonly durableCompletedIdentityCount: number;
    readonly logicalOperationCounts: IndexedDbOperationCounts;
    readonly operationSamples: readonly NativeAlmOperationSample[];
    readonly causalSamples: readonly NativeAlmCausalSample[];
    readonly causalCoverage: readonly NativeAlmCausalCoverage[];
    readonly operationSummaries: readonly NativeAlmOperationSummary[];
    readonly nativeTiming: NativeIndexedDbTimingSnapshot;
    readonly operationSampleCapacity: number;
    readonly droppedOperationSampleCount: number;
    readonly causalSampleCapacity: number;
    readonly droppedCausalSampleCount: number;
    readonly methodsRestored: boolean;
}

export interface NativeIndexedDbTimingSemanticsProbe extends NativeIndexedDbTimingSnapshot {
    readonly durableCommittedValue: string | undefined;
    readonly durableAbortedValue: string | undefined;
    readonly methodsRestored: boolean;
}

const ALM_OPERATION_SAMPLE_CAPACITY = 20_000;
const ALM_CAUSAL_SAMPLE_CAPACITY = 20_000;
const NATIVE_INDEXED_DB_SAMPLE_CAPACITY = 50_000;
const ALM_PAGE_SIZE = 16;
const ALM_SELF_PEER_ID = 'native-timing-receiver';
const ALM_SENDER_PEER_ID = 'native-timing-sender';
const ALM_SOURCE: ALInboundMessageRuntime.Source = { kind: 'ws-client', peerId: ALM_SENDER_PEER_ID };
const COMPLETE_CAUSAL_PHASES: readonly NativeAlmCausalPhase[] = [
    'pending-admission-retained',
    'parent-reserved',
    'effects-committed',
    'parent-released',
    'successor-reserved',
    'callback-start',
    'callback-end',
    'effect-released'
];

class NativeAlmTimingRecorder {
    readonly #operationSamples: NativeAlmOperationSample[] = [];
    readonly #causalSamples: NativeAlmCausalSample[] = [];
    readonly #deadlineByIdentity = new Map<string, number>();
    readonly #committedEffectIdentities = new Set<string>();
    #droppedOperationSampleCount = 0;
    #droppedCausalSampleCount = 0;
    #commitConflictCount = 0;
    #retryReservationCount = 0;
    #oldestEligibleAgeMs = 0;

    resetMeasurements(): void {
        this.#operationSamples.length = 0;
        this.#causalSamples.length = 0;
        this.#committedEffectIdentities.clear();
        this.#droppedOperationSampleCount = 0;
        this.#droppedCausalSampleCount = 0;
        this.#commitConflictCount = 0;
        this.#retryReservationCount = 0;
        this.#oldestEligibleAgeMs = 0;
    }

    registerMessage(message: ALMessage): void {
        const deadline = message.constraints.expiresAtMs;
        if (deadline !== undefined) {
            this.#deadlineByIdentity.set(message.id.msgId, deadline);
        }
    }

    async measure<T>(
        operation: NativeAlmOperation,
        run: () => Promise<T>,
        toOutcome: (result: T) => string = () => 'success'
    ): Promise<T> {
        const startedAtMs = performance.now();
        try {
            const result = await run();
            this.recordOperation({
                operation,
                outcome: toOutcome(result),
                startedAtMs,
                durationMs: performance.now() - startedAtMs
            });
            return result;
        }
        catch (error) {
            this.recordOperation({
                operation,
                outcome: 'error',
                startedAtMs,
                durationMs: performance.now() - startedAtMs
            });
            throw error;
        }
    }

    observeCommittedBundle(bundle: ALInboundCommitBundle, outcome: 'committed' | 'conflict' | 'expired'): void {
        if (outcome === 'conflict') {
            this.#commitConflictCount += 1;
            return;
        }
        if (outcome !== 'committed') {
            return;
        }
        for (const effect of bundle.durableEffects) {
            const identity = toNativeAlmEffectIdentity(effect.payload, effect.effectId);
            if (this.#committedEffectIdentities.has(identity)) {
                continue;
            }
            this.#committedEffectIdentities.add(identity);
            this.recordPhase(identity, 'effects-committed');
        }
    }

    observeRetainedEntry(entry: ResourceEntry, namespace: string): void {
        const effect = decodeALInboundWorkEntry(entry, namespace);
        if (isNativeAlmParent(effect.payload)) {
            this.recordPhase(toNativeAlmEffectIdentity(effect.payload, effect.effectId), 'pending-admission-retained');
        }
    }

    observeReservedEntry(entry: ResourceEntry, namespace: string): void {
        const effect = decodeALInboundWorkEntry(entry, namespace);
        const identity = toNativeAlmEffectIdentity(effect.payload, effect.effectId);
        const nowEpochMs = Date.now();
        const queueAgeMs = Math.max(0, nowEpochMs - resolveALInboundWorkDueAtMs(entry));
        const leaseMarginMs = computeALWorkLeaseUntilMs(entry, AL_INBOUND_WORK_LEASE_MS) - nowEpochMs;
        this.#oldestEligibleAgeMs = Math.max(this.#oldestEligibleAgeMs, queueAgeMs);
        if (entry.dequeueAudit.attempts > 1) {
            this.#retryReservationCount += 1;
        }
        this.recordPhase(
            identity,
            isNativeAlmParent(effect.payload) ? 'parent-reserved' : 'successor-reserved',
            queueAgeMs,
            leaseMarginMs
        );
    }

    observeReleasedEntry(entry: ResourceEntry, namespace: string): void {
        const effect = decodeALInboundWorkEntry(entry, namespace);
        this.recordPhase(
            toNativeAlmEffectIdentity(effect.payload, effect.effectId),
            isNativeAlmParent(effect.payload) ? 'parent-released' : 'effect-released'
        );
    }

    observeCallback(identity: string, phase: 'callback-start' | 'callback-end'): void {
        this.recordPhase(identity, phase);
    }

    snapshot(): Readonly<{
        operationSamples: readonly NativeAlmOperationSample[];
        causalSamples: readonly NativeAlmCausalSample[];
        causalCoverage: readonly NativeAlmCausalCoverage[];
        operationSummaries: readonly NativeAlmOperationSummary[];
        observedCommittedEffectIdentityCount: number;
        commitConflictCount: number;
        retryReservationCount: number;
        oldestEligibleAgeMs: number;
        minimumLeaseMarginMs: number | null;
        minimumDeadlineMarginMs: number | null;
        completeCausalIdentityCount: number;
        droppedOperationSampleCount: number;
        droppedCausalSampleCount: number;
    }> {
        return {
            operationSamples: [...this.#operationSamples],
            causalSamples: [...this.#causalSamples],
            causalCoverage: computeNativeAlmCausalCoverage(this.#causalSamples),
            operationSummaries: computeNativeAlmOperationSummaries(this.#operationSamples),
            observedCommittedEffectIdentityCount: this.#committedEffectIdentities.size,
            commitConflictCount: this.#commitConflictCount,
            retryReservationCount: this.#retryReservationCount,
            oldestEligibleAgeMs: this.#oldestEligibleAgeMs,
            minimumLeaseMarginMs: minimumCapturedMargin(this.#causalSamples, 'leaseMarginMs'),
            minimumDeadlineMarginMs: minimumCapturedMargin(this.#causalSamples, 'deadlineMarginMs'),
            completeCausalIdentityCount: countCompleteCausalIdentities(this.#causalSamples),
            droppedOperationSampleCount: this.#droppedOperationSampleCount,
            droppedCausalSampleCount: this.#droppedCausalSampleCount
        };
    }

    private recordOperation(sample: NativeAlmOperationSample): void {
        if (this.#operationSamples.length < ALM_OPERATION_SAMPLE_CAPACITY) {
            this.#operationSamples.push(sample);
        }
        else {
            this.#droppedOperationSampleCount += 1;
        }
    }

    private recordPhase(
        identity: string,
        phase: NativeAlmCausalPhase,
        queueAgeMs: number | null = null,
        leaseMarginMs: number | null = null
    ): void {
        const deadline = this.#deadlineByIdentity.get(identity);
        const sample: NativeAlmCausalSample = {
            identity,
            phase,
            atMs: performance.now(),
            queueAgeMs,
            leaseMarginMs,
            deadlineMarginMs: deadline === undefined ? null : deadline - Date.now()
        };
        if (this.#causalSamples.length < ALM_CAUSAL_SAMPLE_CAPACITY) {
            this.#causalSamples.push(sample);
        }
        else {
            this.#droppedCausalSampleCount += 1;
        }
    }
}

interface NativeAlmInstrumentation {
    readonly restored: boolean;
    restore(): void;
}

interface NativeAlmSession {
    readonly actorId: string;
    readonly databaseId: string;
    readonly namespace: string;
    readonly runtime: ALInboundMessageRuntime;
    readonly admission: ALInboundMessageAdmission;
    readonly stores: ALInboundRuntimeStores;
    readonly queue: IndexedDbQueueBox;
    readonly queueEngine: InboxOutboxEngine;
    readonly observer: ReturnType<typeof createCountingIndexedDbOperationObserver>;
    readonly recorder: NativeAlmTimingRecorder;
    readonly nativeRecorder: NativeIndexedDbTimingRecorder;
    readonly instrumentation: NativeAlmInstrumentation;
    readonly deliveredIdentities: string[];
}

export async function runNativeAlmTimingProbe(
    input: Readonly<{
        workload: NativeAlmTimingWorkload;
        databaseId: string;
        actorId: string;
    }>
): Promise<NativeAlmTimingProbe> {
    const session = await createNativeAlmSession(input);
    const startedAtMs = performance.now();
    let workloadEvidence = emptyNativeAlmWorkloadEvidence();
    let failure: string | null = null;
    try {
        workloadEvidence = await runNativeAlmWorkload(session, input.workload);
    }
    catch (error) {
        failure = error instanceof Error ? error.message : String(error);
    }
    finally {
        session.queueEngine.stop();
        session.runtime.dispose();
        session.admission.dispose();
        session.nativeRecorder.stop();
        session.instrumentation.restore();
    }
    const durationMs = performance.now() - startedAtMs;
    const measured = session.recorder.snapshot();
    const logicalOperationCounts = session.observer.getCounts();
    const durableCompletedIdentityCount = await countDurableCompletedIdentities(session);
    return {
        workload: input.workload,
        actorId: input.actorId,
        databaseId: input.databaseId,
        measuredTree: 'runtime-base-plus-measurement-instrumentation',
        environment: {
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
            performanceTimeOriginMs: performance.timeOrigin
        },
        durationMs,
        failure,
        throughputPerSecond: durationMs === 0 ? 0 : session.deliveredIdentities.length / (durationMs / 1_000),
        deliveredCount: session.deliveredIdentities.length,
        observedCommittedEffectIdentityCount: measured.observedCommittedEffectIdentityCount,
        commitConflictCount: measured.commitConflictCount,
        retryReservationCount: measured.retryReservationCount,
        oldestEligibleAgeMs: measured.oldestEligibleAgeMs,
        minimumLeaseMarginMs: measured.minimumLeaseMarginMs,
        minimumDeadlineMarginMs: measured.minimumDeadlineMarginMs,
        completeCausalIdentityCount: measured.completeCausalIdentityCount,
        durableCompletedIdentityCount,
        logicalOperationCounts,
        operationSamples: measured.operationSamples,
        causalSamples: measured.causalSamples,
        causalCoverage: measured.causalCoverage,
        operationSummaries: measured.operationSummaries,
        nativeTiming: session.nativeRecorder.snapshot(),
        operationSampleCapacity: ALM_OPERATION_SAMPLE_CAPACITY,
        droppedOperationSampleCount: measured.droppedOperationSampleCount,
        causalSampleCapacity: ALM_CAUSAL_SAMPLE_CAPACITY,
        droppedCausalSampleCount: measured.droppedCausalSampleCount,
        methodsRestored: session.nativeRecorder.methodsRestored && session.instrumentation.restored,
        ...workloadEvidence
    };
}

interface NativeAlmWorkloadEvidence {
    readonly maximumSuccessorsBeyondRemainingPageCapacity: number;
    readonly recoveredKinds: readonly ('new' | 'retry' | 'expired-reserved')[];
    readonly boundedCommitCount: number;
    readonly waitingEntryCount: number;
}

async function createNativeAlmSession(
    input: Readonly<{
        workload: NativeAlmTimingWorkload;
        databaseId: string;
        actorId: string;
    }>
): Promise<NativeAlmSession> {
    const namespace = input.workload === 'shared-contention' ? 'native-contention' : `native-${input.workload}`;
    const observer = createCountingIndexedDbOperationObserver();
    const backend = new IndexedDbAdmissionBackend({
        dbName: `playwright-native-alm-${input.databaseId}`,
        storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer,
        onStorageReset: () => {}
    });
    const admissionStore = createALInboundAdmissionStore({
        nowMs: Date.now,
        namespace,
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const recorder = new NativeAlmTimingRecorder();
    const instrumentation = instrumentNativeAlmOwners({
        admissionStore,
        queue: backend.workQueue,
        namespace,
        recorder
    });
    const queueEngine = new InboxOutboxEngine();
    const deliveredIdentities: string[] = [];
    const stores = { admissionStore, workQueue: backend.workQueue };
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: ALM_SELF_PEER_ID,
        stores,
        queueEngine,
        nowMs: Date.now,
        random: () => 0.5,
        newControlId: crypto.randomUUID.bind(crypto),
        toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
    });
    const planIncomingMessage = createNativeAlmPlan;
    const runtime = new ALInboundMessageRuntime({
        ...resources,
        planIncomingMessage,
        canDispatchMessage: (message) => !message.id.msgId.startsWith('waiting-'),
        dispatchInboxEntry: async (entry) => {
            const identity = decodePersistedALMessage(entry.resource).id.msgId;
            recorder.observeCallback(identity, 'callback-start');
            deliveredIdentities.push(identity);
            recorder.observeCallback(identity, 'callback-end');
        },
        sendControlMessage: async () => {},
        diagnostics: undefined,
        effectWorkerId: `native-alm:${input.actorId}`
    });
    const admission = new ALInboundMessageAdmission({
        ...resources,
        planIncomingMessage,
        workPort: createALWorkQueuePort({
            queue: backend.workQueue,
            workTypes: new Set([toALInboundWorkType(namespace)]),
            leaseMs: AL_INBOUND_WORK_LEASE_MS,
            nowMs: Date.now,
            random: () => 0.5
        })
    });
    await runtime.ready();
    observer.reset();
    const nativeRecorder = new NativeIndexedDbTimingRecorder(NATIVE_INDEXED_DB_SAMPLE_CAPACITY);
    return {
        actorId: input.actorId,
        namespace,
        runtime,
        admission,
        stores,
        queue: backend.workQueue,
        queueEngine,
        observer,
        recorder,
        nativeRecorder,
        instrumentation,
        deliveredIdentities
    };
}

function instrumentNativeAlmOwners(
    input: Readonly<{
        admissionStore: ALInboundAdmissionStore;
        queue: IndexedDbQueueBox;
        namespace: string;
        recorder: NativeAlmTimingRecorder;
    }>
): NativeAlmInstrumentation {
    const { admissionStore, queue, namespace, recorder } = input;
    const originalCommitBundle = admissionStore.commitBundle;
    const originalReadWorkPage = queue.readWorkPage;
    const originalReadWorkPages = queue.readWorkPages;
    const originalReserveEntries = queue.reserveEntries;
    const originalReserveTimeoutEntries = queue.reserveTimeoutEntries;
    const originalReserveRetryExhaustionFinalizations = queue.reserveRetryExhaustionFinalizations;
    const originalReleaseEntries = queue.releaseEntries;
    const originalEnqueueIfAbsent = queue.enqueueIfAbsent;
    let restored = false;

    admissionStore.commitBundle = async (bundle) => {
        const outcome = await recorder.measure(
            'commit',
            () => originalCommitBundle.call(admissionStore, bundle),
            (result) => result
        );
        recorder.observeCommittedBundle(bundle, outcome);
        return outcome;
    };
    queue.readWorkPage = async (request: ResourceInboxWorkPage.Request) =>
        await recorder.measure('work-page', () => originalReadWorkPage.call(queue, request));
    queue.readWorkPages = async (requests: readonly ResourceInboxWorkPage.Request[]) =>
        await recorder.measure('work-page', () => originalReadWorkPages.call(queue, requests));
    queue.reserveEntries = async (request: ResourceInboxReservationRequest) => {
        const reserved = await recorder.measure('reservation', () => originalReserveEntries.call(queue, request));
        for (const entry of reserved.values()) {
            recorder.observeReservedEntry(entry, namespace);
        }
        return reserved;
    };
    queue.reserveTimeoutEntries = async (request: ResourceInboxTimeoutReservationRequest) => {
        const reserved = await recorder.measure(
            'reservation',
            () => originalReserveTimeoutEntries.call(queue, request)
        );
        for (const entry of reserved.values()) {
            recorder.observeReservedEntry(entry, namespace);
        }
        return reserved;
    };
    queue.reserveRetryExhaustionFinalizations = async (
        typeIds: Set<string>,
        request: ResourceInboxFinalizationReservationOptions
    ) => await recorder.measure(
        'reservation',
        () => originalReserveRetryExhaustionFinalizations.call(queue, typeIds, request)
    );
    queue.releaseEntries = async (entries, disposition) => {
        const released = await recorder.measure(
            'release',
            () => originalReleaseEntries.call(queue, entries, disposition)
        );
        for (const entry of released.values()) {
            recorder.observeReleasedEntry(entry, namespace);
        }
        return released;
    };
    queue.enqueueIfAbsent = async (entry) => {
        const retained = await originalEnqueueIfAbsent.call(queue, entry);
        recorder.observeRetainedEntry(retained, namespace);
        return retained;
    };

    return {
        get restored() {
            return restored;
        },
        restore() {
            admissionStore.commitBundle = originalCommitBundle;
            queue.readWorkPage = originalReadWorkPage;
            queue.readWorkPages = originalReadWorkPages;
            queue.reserveEntries = originalReserveEntries;
            queue.reserveTimeoutEntries = originalReserveTimeoutEntries;
            queue.reserveRetryExhaustionFinalizations = originalReserveRetryExhaustionFinalizations;
            queue.releaseEntries = originalReleaseEntries;
            queue.enqueueIfAbsent = originalEnqueueIfAbsent;
            restored = admissionStore.commitBundle === originalCommitBundle &&
                queue.readWorkPage === originalReadWorkPage &&
                queue.readWorkPages === originalReadWorkPages &&
                queue.reserveEntries === originalReserveEntries &&
                queue.reserveTimeoutEntries === originalReserveTimeoutEntries &&
                queue.reserveRetryExhaustionFinalizations === originalReserveRetryExhaustionFinalizations &&
                queue.releaseEntries === originalReleaseEntries &&
                queue.enqueueIfAbsent === originalEnqueueIfAbsent;
        }
    };
}

async function runNativeAlmWorkload(
    session: NativeAlmSession,
    workload: NativeAlmTimingWorkload
): Promise<NativeAlmWorkloadEvidence> {
    switch (workload) {
        case 'sparse':
            return await runSparseNativeAlmWorkload(session);
        case 'full-page':
            return await runPendingParentWorkload(session, 16);
        case 'excess-fanout':
            return await runPendingParentWorkload(session, 13);
        case 'finite-backlog':
            return await runFiniteBacklogWorkload(session);
        case 'shared-contention':
            return await runSharedContentionWorkload(session);
    }
}

async function runSparseNativeAlmWorkload(session: NativeAlmSession): Promise<NativeAlmWorkloadEvidence> {
    beginNativeAlmMeasurement(session);
    session.queueEngine.start();
    const message = createNativeAlmMessage('sparse');
    await admitNativeAlmMessage(session, message);
    await waitForDeliveredAndDurablyCompletedIdentities(session, new Set([message.id.msgId]));
    return emptyNativeAlmWorkloadEvidence();
}

async function runPendingParentWorkload(
    session: NativeAlmSession,
    parentCount: number
): Promise<NativeAlmWorkloadEvidence> {
    beginNativeAlmMeasurement(session);
    const identities = new Set<string>();
    for (let index = 0; index < parentCount; index += 1) {
        const message = createNativeAlmMessage(`parent-${String(index).padStart(2, '0')}`);
        identities.add(message.id.msgId);
        session.recorder.registerMessage(message);
        const acceptance = await session.recorder.measure(
            'admission',
            () => session.admission.retainPending({ kind: 'admit-message', msg: message, source: ALM_SOURCE }),
            (result) => result.kind
        );
        if (acceptance.kind !== 'pending-admission') {
            throw new Error(`Pending parent ${message.id.msgId} was not retained: ${acceptance.kind}`);
        }
    }
    session.queueEngine.start();
    await waitForDeliveredAndDurablyCompletedIdentities(session, identities);
    return {
        ...emptyNativeAlmWorkloadEvidence(),
        maximumSuccessorsBeyondRemainingPageCapacity: Math.max(0, parentCount - (ALM_PAGE_SIZE - parentCount))
    };
}

async function runFiniteBacklogWorkload(session: NativeAlmSession): Promise<NativeAlmWorkloadEvidence> {
    const waitingIdentities = Array.from({ length: 32 }, (_, index) => `waiting-${String(index).padStart(2, '0')}`);
    const eligibleIdentities = ['eligible-new', 'eligible-retry', 'eligible-expired-reserved'] as const;
    for (const identity of [...waitingIdentities, ...eligibleIdentities]) {
        await seedNativeAlmSuccessor(session, createNativeAlmMessage(identity));
    }
    await setNativeAlmEntryStatus(session, 'eligible-retry', EntityStatus.RETRY);
    await setNativeAlmEntryStatus(session, 'eligible-expired-reserved', EntityStatus.RESERVED);

    beginNativeAlmMeasurement(session);
    session.queueEngine.start();
    const producerIdentities = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
        const message = createNativeAlmMessage(`producer-${String(index).padStart(2, '0')}`);
        producerIdentities.add(message.id.msgId);
        await admitNativeAlmMessage(session, message);
    }
    await waitForDeliveredAndDurablyCompletedIdentities(
        session,
        new Set([...eligibleIdentities, ...producerIdentities])
    );
    const waitingEntryCount = await countNativeAlmEntries(session, (entry) => {
        const effect = decodeALInboundWorkEntry(entry, session.namespace);
        return toNativeAlmEffectIdentity(effect.payload, effect.effectId).startsWith('waiting-') &&
            entry.status !== EntityStatus.COMPLETED;
    });
    return {
        maximumSuccessorsBeyondRemainingPageCapacity: 0,
        recoveredKinds: ['new', 'retry', 'expired-reserved'],
        boundedCommitCount: producerIdentities.size,
        waitingEntryCount
    };
}

async function runSharedContentionWorkload(session: NativeAlmSession): Promise<NativeAlmWorkloadEvidence> {
    beginNativeAlmMeasurement(session);
    const message = createNativeAlmMessage('shared-contention');
    session.recorder.registerMessage(message);
    await session.recorder.measure(
        'admission',
        () => session.admission.attempt(message, ALM_SOURCE, createNativeAlmPlan),
        (attempt) => attempt.fold((rejection) => rejection.code, (value) => value.kind)
    );
    const barrierPrefix = `native-alm-contention:${session.databaseId}:`;
    localStorage.setItem(`${barrierPrefix}${session.actorId}`, 'ready');
    await waitForNativeAlmCondition(
        () =>
            localStorage.getItem(`${barrierPrefix}first`) === 'ready' &&
            localStorage.getItem(`${barrierPrefix}second`) === 'ready',
        'both native ALM contention writers'
    );
    if (session.actorId === 'first') {
        session.queueEngine.start();
    }
    await waitForDurableCompletion(session, message.id.msgId);
    return emptyNativeAlmWorkloadEvidence();
}

function beginNativeAlmMeasurement(session: NativeAlmSession): void {
    session.recorder.resetMeasurements();
    session.observer.reset();
    session.nativeRecorder.start();
}

async function admitNativeAlmMessage(session: NativeAlmSession, message: ALMessage): Promise<void> {
    session.recorder.registerMessage(message);
    const result = await session.recorder.measure(
        'admission',
        () => session.runtime.admitIncomingMessage(message, ALM_SOURCE),
        (acceptance) => acceptance.fold((rejection) => rejection.code, (value) => value.kind)
    );
    if (result.left !== undefined) {
        throw new Error(`Native ALM admission rejected ${message.id.msgId}: ${result.left.code}`);
    }
    const acceptance = result.right;
    if (acceptance === undefined || !['admitted', 'duplicate', 'pending-admission'].includes(acceptance.kind)) {
        throw new Error(`Native ALM admission did not retain ${message.id.msgId}: ${acceptance?.kind ?? 'missing'}`);
    }
}

async function seedNativeAlmSuccessor(session: NativeAlmSession, message: ALMessage): Promise<void> {
    session.recorder.registerMessage(message);
    const attempt = await session.admission.attempt(message, ALM_SOURCE, createNativeAlmPlan);
    if (attempt.left !== undefined) {
        throw new Error(`Native ALM seed rejected ${message.id.msgId}: ${attempt.left.code}`);
    }
    if (attempt.right?.kind !== 'completed' || !attempt.right.wroteWork) {
        throw new Error(`Native ALM seed did not commit successor ${message.id.msgId}`);
    }
}

async function setNativeAlmEntryStatus(
    session: NativeAlmSession,
    identity: string,
    status: EntityStatus.RETRY | EntityStatus.RESERVED
): Promise<void> {
    const entry = await readNativeAlmEntry(session, identity);
    if (entry === undefined) {
        throw new Error(`Native ALM seed entry is missing: ${identity}`);
    }
    const nowMs = Date.now();
    const replacement: ResourceEntry = {
        ...entry,
        status,
        dequeueAudit: status === EntityStatus.RETRY
            ? {
                attempts: 1,
                nextTs: Temporal.Instant.fromEpochMilliseconds(nowMs - 1_000)
            }
            : {
                attempts: 1,
                startTs: Temporal.Instant.fromEpochMilliseconds(nowMs - AL_INBOUND_WORK_LEASE_MS - 1_000)
            }
    };
    await session.queue.enqueue(replacement);
}

async function waitForDeliveredIdentities(session: NativeAlmSession, expected: ReadonlySet<string>): Promise<void> {
    await waitForNativeAlmCondition(() => {
        const delivered = new Set(session.deliveredIdentities);
        return [...expected].every((identity) => delivered.has(identity));
    }, `delivered identities ${[...expected].join(', ')}`);
}

async function waitForDeliveredAndDurablyCompletedIdentities(
    session: NativeAlmSession,
    expected: ReadonlySet<string>
): Promise<void> {
    await waitForDeliveredIdentities(session, expected);
    await Promise.all([...expected].map(async (identity) => await waitForDurableCompletion(session, identity)));
}

async function waitForDurableCompletion(session: NativeAlmSession, identity: string): Promise<void> {
    await waitForNativeAlmCondition(async () => {
        const entry = await readNativeAlmEntry(session, identity);
        return entry?.status === EntityStatus.COMPLETED;
    }, `durable completion for ${identity}`);
}

async function waitForNativeAlmCondition(
    readCondition: () => boolean | Promise<boolean>,
    description: string
): Promise<void> {
    const deadline = performance.now() + 25_000;
    while (performance.now() < deadline) {
        if (await readCondition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}`);
}

async function readNativeAlmEntry(session: NativeAlmSession, identity: string): Promise<ResourceEntry | undefined> {
    for (const key of await session.queue.getAllKeys()) {
        const entry = await session.queue.getItem(key);
        if (entry === undefined) {
            continue;
        }
        const effect = decodeALInboundWorkEntry(entry, session.namespace);
        if (
            toNativeAlmEffectIdentity(effect.payload, effect.effectId) === identity &&
            !isNativeAlmParent(effect.payload)
        ) {
            return entry;
        }
    }
    return undefined;
}

async function countDurableCompletedIdentities(session: NativeAlmSession): Promise<number> {
    const identities = new Set<string>();
    await countNativeAlmEntries(session, (entry) => {
        if (entry.status !== EntityStatus.COMPLETED) {
            return false;
        }
        const effect = decodeALInboundWorkEntry(entry, session.namespace);
        if (!isNativeAlmParent(effect.payload)) {
            identities.add(toNativeAlmEffectIdentity(effect.payload, effect.effectId));
        }
        return false;
    });
    return identities.size;
}

async function countNativeAlmEntries(
    session: NativeAlmSession,
    predicate: (entry: ResourceEntry) => boolean
): Promise<number> {
    let count = 0;
    for (const key of await session.queue.getAllKeys()) {
        const entry = await session.queue.getItem(key);
        if (entry !== undefined && predicate(entry)) {
            count += 1;
        }
    }
    return count;
}

function createNativeAlmMessage(identity: string): ReturnType<typeof toNativeAlmDeadlinedMessage> {
    const message = newALUnicastMessage(
        ALM_SENDER_PEER_ID,
        { topicId: 'native-timing', resourceId: identity, contextId: 'native-timing-room' },
        ALM_SELF_PEER_ID,
        'chat.private-text.v1',
        { text: identity },
        { ttlMs: 60_000 }
    );
    return toNativeAlmDeadlinedMessage({ ...message, id: { ...message.id, msgId: identity } });
}

function toNativeAlmDeadlinedMessage(message: ALMessage) {
    return {
        ...message,
        constraints: {
            ...message.constraints,
            expiresAtMs: Date.now() + 60_000
        }
    };
}

function createNativeAlmPlan(
    message: ALMessage,
    _source: ALInboundMessageRuntime.Source,
    observations: Parameters<typeof planALMessageHandling>[1]
) {
    return planALMessageHandling(message, {
        ...observations,
        selfPeerId: ALM_SELF_PEER_ID,
        fromPeerId: ALM_SENDER_PEER_ID
    });
}

function emptyNativeAlmWorkloadEvidence(): NativeAlmWorkloadEvidence {
    return {
        maximumSuccessorsBeyondRemainingPageCapacity: 0,
        recoveredKinds: [],
        boundedCommitCount: 0,
        waitingEntryCount: 0
    };
}

function isNativeAlmParent(effect: ALInboundDurableEffect): boolean {
    return effect.kind === 'admit-message' || effect.kind === 'admit-control';
}

function toNativeAlmEffectIdentity(effect: ALInboundDurableEffect, effectId: string): string {
    switch (effect.kind) {
        case 'admit-message':
        case 'admit-control':
        case 'send-control':
            return effect.msg.id.msgId;
        case 'dispatch-local':
        case 'forward-message':
            return effect.message.msgId;
        case 'release-buffered':
            return `effect:${effectId}`;
    }
}

function computeNativeAlmOperationSummaries(
    samples: readonly NativeAlmOperationSample[]
): readonly NativeAlmOperationSummary[] {
    const operations: readonly NativeAlmOperation[] = ['admission', 'commit', 'work-page', 'reservation', 'release'];
    return operations.flatMap((operation) => {
        const durations = samples
            .filter((sample) => sample.operation === operation)
            .map((sample) => sample.durationMs)
            .sort((left, right) => left - right);
        return durations.length === 0
            ? []
            : [{
                operation,
                sampleCount: durations.length,
                p50Ms: percentile(durations, 0.5),
                p95Ms: percentile(durations, 0.95),
                p99Ms: percentile(durations, 0.99),
                maxMs: durations[durations.length - 1]
            }];
    });
}

function percentile(sortedValues: readonly number[], fraction: number): number {
    return sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)];
}

function minimumCapturedMargin(
    samples: readonly NativeAlmCausalSample[],
    key: 'leaseMarginMs' | 'deadlineMarginMs'
): number | null {
    const margins = samples.flatMap((sample) => sample[key] === null ? [] : [sample[key]]);
    return margins.length === 0 ? null : Math.min(...margins);
}

function countCompleteCausalIdentities(samples: readonly NativeAlmCausalSample[]): number {
    return computeNativeAlmCausalCoverage(samples).filter((coverage) => coverage.uncapturedPhases.length === 0).length;
}

function computeNativeAlmCausalCoverage(
    samples: readonly NativeAlmCausalSample[]
): readonly NativeAlmCausalCoverage[] {
    const phasesByIdentity = new Map<string, Set<NativeAlmCausalPhase>>();
    for (const sample of samples) {
        const phases = phasesByIdentity.get(sample.identity) ?? new Set<NativeAlmCausalPhase>();
        phases.add(sample.phase);
        phasesByIdentity.set(sample.identity, phases);
    }
    return [...phasesByIdentity].map(([identity, phases]) => ({
        identity,
        capturedPhases: COMPLETE_CAUSAL_PHASES.filter((phase) => phases.has(phase)),
        uncapturedPhases: COMPLETE_CAUSAL_PHASES.filter((phase) => !phases.has(phase))
    }));
}

export async function runNativeIndexedDbTimingSemanticsProbe(
    databaseId: string
): Promise<NativeIndexedDbTimingSemanticsProbe> {
    const database = await openProbeDatabase(`playwright-indexeddb-timing-${databaseId}`);
    const recorder = new NativeIndexedDbTimingRecorder(3);
    recorder.start();
    try {
        await writeProbeValue(database, 'committed', 'committed');
        await writeThenAbortProbeValue(database, 'aborted', 'aborted');
        await readFirstProbeCursor(database);
        await exerciseProbeRequestInventory(database);
    }
    finally {
        recorder.stop();
    }
    try {
        return {
            ...recorder.snapshot(),
            durableCommittedValue: await readProbeValue(database, 'committed'),
            durableAbortedValue: await readProbeValue(database, 'aborted'),
            methodsRestored: recorder.methodsRestored
        };
    }
    finally {
        database.close();
    }
}

async function openProbeDatabase(dbName: string): Promise<IDBDatabase> {
    const request = indexedDB.open(dbName, 1);
    request.addEventListener('upgradeneeded', () => {
        const store = request.result.createObjectStore('entries');
        store.createIndex('by-value', 'value');
    });
    return await readRequest(request);
}

async function writeProbeValue(database: IDBDatabase, key: string, value: string): Promise<void> {
    const transaction = database.transaction('entries', 'readwrite');
    await readRequest(transaction.objectStore('entries').put({ value }, key));
    await readTransaction(transaction);
}

async function writeThenAbortProbeValue(database: IDBDatabase, key: string, value: string): Promise<void> {
    const transaction = database.transaction('entries', 'readwrite');
    await readRequest(transaction.objectStore('entries').put({ value }, key));
    const aborted = readTransactionAbort(transaction);
    transaction.abort();
    await aborted;
}

async function readFirstProbeCursor(database: IDBDatabase): Promise<void> {
    const transaction = database.transaction('entries', 'readonly');
    const request = transaction.objectStore('entries').openCursor();
    await new Promise<void>((resolve, reject) => {
        request.addEventListener('success', () => resolve(), { once: true });
        request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB cursor failed')), {
            once: true
        });
    });
    await readTransaction(transaction);
}

async function exerciseProbeRequestInventory(database: IDBDatabase): Promise<void> {
    const transaction = database.transaction('entries', 'readwrite');
    const store = transaction.objectStore('entries');
    await Promise.all([
        readRequest(store.get('committed')),
        readRequest(store.getAll()),
        readRequest(store.delete('absent')),
        readFirstCursorResult(store.index('by-value').openCursor())
    ]);
    await readTransaction(transaction);
}

async function readFirstCursorResult(request: IDBRequest<IDBCursorWithValue | null>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        request.addEventListener('success', () => resolve(), { once: true });
        request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB cursor failed')), {
            once: true
        });
    });
}

async function readProbeValue(database: IDBDatabase, key: string): Promise<string | undefined> {
    const transaction = database.transaction('entries', 'readonly');
    const row = await readRequest<{ readonly value: string; } | undefined>(transaction.objectStore('entries').get(key));
    await readTransaction(transaction);
    return row?.value;
}

async function readRequest<T>(request: IDBRequest<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')), {
            once: true
        });
    });
}

async function readTransaction(transaction: IDBTransaction): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        transaction.addEventListener('complete', () => resolve(), { once: true });
        transaction.addEventListener(
            'abort',
            () => reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
            {
                once: true
            }
        );
        transaction.addEventListener(
            'error',
            () => reject(transaction.error ?? new Error('IndexedDB transaction failed')),
            {
                once: true
            }
        );
    });
}

async function readTransactionAbort(transaction: IDBTransaction): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        transaction.addEventListener('abort', () => resolve(), { once: true });
        transaction.addEventListener(
            'complete',
            () => reject(new Error('IndexedDB transaction unexpectedly committed')),
            {
                once: true
            }
        );
    });
}
