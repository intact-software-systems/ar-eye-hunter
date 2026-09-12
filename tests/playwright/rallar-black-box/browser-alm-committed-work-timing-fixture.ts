import { Temporal } from '@js-temporal/polyfill';

import { newALUnicastMessage, type ALMessage } from '../../../packages/shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../../../packages/shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '../../../packages/shared/al-contracts/al-policy.ts';
import { normalizeALRuntimeStoreRetention } from '../../../packages/shared/alm/ALStoreRetention.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionStore,
    type ALInboundPlanner
} from '../../../packages/shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageAdmission } from '../../../packages/shared/alm/inbound/al-inbound-message-admission.ts';
import {
    ALInboundMessageRuntime,
    type ALInboundRuntimeStores
} from '../../../packages/shared/alm/inbound/al-inbound-message-runtime.ts';
import {
    computeALInboundWorkEntry,
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '../../../packages/shared/alm/inbound/al-inbound-work-entry.ts';
import { AL_INBOUND_WORK_LEASE_MS } from '../../../packages/shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '../../../packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { IndexedDbAdmissionBackend } from '../../../packages/shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '../../../packages/shared/alm/open-indexed-db-admission-database.ts';
import { createALWorkQueuePort } from '../../../packages/shared/alm/work/al-work-queue-port.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationCounts
} from '../../../packages/shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '../../../packages/shared/persistence/indexed-db-string-persistence-provider.ts';
import { IndexedDbQueueBox } from '../../../packages/shared/queuebox/indexed-db-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '../../../packages/shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '../../../packages/shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '../../../packages/shared/services/queue-box-utilities.ts';
import {
    isNativeAlmParent,
    NATIVE_ALM_CAUSAL_SAMPLE_CAPACITY,
    NATIVE_ALM_OPERATION_SAMPLE_CAPACITY,
    NativeAlmOwnerInstrumentation,
    NativeAlmTimingRecorder,
    toNativeAlmEffectIdentity,
    type NativeAlmCausalCoverage,
    type NativeAlmCausalSample,
    type NativeAlmOperationSample,
    type NativeAlmOperationSummary
} from './browser-alm-committed-work-observer.ts';
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

export interface NativeAlmRetryReleaseSemanticsProbe {
    readonly callbackDelivered: boolean;
    readonly returnedReleasePhaseCaptured: boolean;
    readonly durableCompletionObserved: boolean;
}

export interface NativeAlmTimingProbe {
    readonly workload: NativeAlmTimingWorkload;
    readonly actorId: string;
    readonly databaseId: string;
    readonly measuredTree: 'runtime-base-plus-measurement-instrumentation';
    readonly measurementPurpose: 'performance-comparison' | 'semantic-contention';
    readonly environment: Readonly<{
        userAgent: string;
        hardwareConcurrency: number;
        performanceTimeOriginMs: number;
    }>;
    readonly durationMs: number;
    readonly measurementStartedAtMs: number;
    readonly measurementEndedAtMs: number;
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
    readonly durableCompletedIdentities: readonly string[];
    readonly logicalOperationCounts: IndexedDbOperationCounts;
    readonly terminalVerification: Readonly<{
        startedAtMs: number;
        endedAtMs: number;
        logicalOperationCounts: IndexedDbOperationCounts;
    }>;
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

const NATIVE_INDEXED_DB_SAMPLE_CAPACITY = 50_000;
const ALM_PAGE_SIZE = 16;
const ALM_SELF_PEER_ID = 'native-timing-receiver';
const ALM_SENDER_PEER_ID = 'native-timing-sender';
const ALM_SOURCE: ALInboundMessageRuntime.Source = { kind: 'ws-client', peerId: ALM_SENDER_PEER_ID };
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
    readonly measurement: NativeAlmMeasurementWindow;
    readonly instrumentation: NativeAlmOwnerInstrumentation;
    readonly deliveredIdentities: string[];
}

interface NativeAlmCompletedMeasurement {
    readonly startedAtMs: number;
    readonly endedAtMs: number;
    readonly durationMs: number;
    readonly logicalOperationCounts: IndexedDbOperationCounts;
    readonly nativeTiming: NativeIndexedDbTimingSnapshot;
}

class NativeAlmMeasurementWindow {
    readonly #observer: ReturnType<typeof createCountingIndexedDbOperationObserver>;
    readonly #recorder: NativeAlmTimingRecorder;
    readonly #nativeRecorder: NativeIndexedDbTimingRecorder;
    #startedAtMs: number | undefined;

    constructor(
        input: Readonly<{
            observer: ReturnType<typeof createCountingIndexedDbOperationObserver>;
            recorder: NativeAlmTimingRecorder;
            nativeRecorder: NativeIndexedDbTimingRecorder;
        }>
    ) {
        this.#observer = input.observer;
        this.#recorder = input.recorder;
        this.#nativeRecorder = input.nativeRecorder;
    }

    begin(): void {
        this.#recorder.resetMeasurements();
        this.#observer.reset();
        this.#nativeRecorder.start();
        this.#startedAtMs = performance.now();
    }

    finish(): NativeAlmCompletedMeasurement {
        const endedAtMs = performance.now();
        this.#nativeRecorder.stop();
        const startedAtMs = this.#startedAtMs ?? endedAtMs;
        return {
            startedAtMs,
            endedAtMs,
            durationMs: endedAtMs - startedAtMs,
            logicalOperationCounts: this.#observer.getCounts(),
            nativeTiming: this.#nativeRecorder.snapshot()
        };
    }
}

export function runNativeAlmRetryReleaseSemanticsProbe(): NativeAlmRetryReleaseSemanticsProbe {
    const namespace = 'native-alm-retry-release-semantics';
    const identity = 'returned-retry';
    const nowMs = Date.now();
    const write = computeALInboundWorkEntry({
        namespace,
        effectId: 'returned-retry-effect',
        payload: { kind: 'dispatch-local', message: { senderId: ALM_SENDER_PEER_ID, msgId: identity } },
        observedAtMs: nowMs,
        expireAtTimestamp: nowMs + 60_000
    });
    const returnedRetry: ResourceEntry = {
        ...write.entry,
        status: EntityStatus.RETRY,
        dequeueAudit: { attempts: 1, nextTs: Temporal.Instant.fromEpochMilliseconds(nowMs + 100) }
    };
    const recorder = new NativeAlmTimingRecorder();
    recorder.observeCallback(identity, 'callback-start');
    recorder.observeCallback(identity, 'callback-end');
    recorder.observeReturnedReleaseEntry(returnedRetry, namespace);
    const phases = recorder.snapshot().causalSamples.map((sample) => sample.phase);
    return {
        callbackDelivered: phases.includes('callback-end'),
        returnedReleasePhaseCaptured: phases.includes('effect-released'),
        durableCompletionObserved: recorder.hasObservedCompletedEffectRelease(identity)
    };
}

export async function runNativeAlmTimingProbe(
    input: Readonly<{
        workload: NativeAlmTimingWorkload;
        databaseId: string;
        actorId: string;
    }>
): Promise<NativeAlmTimingProbe> {
    const session = await createNativeAlmSession(input);
    const execution = await executeNativeAlmMeasurement(session, input.workload);
    const verification = await verifyNativeAlmDurableState(session);
    return toNativeAlmTimingProbe({ input, session, execution, verification });
}

interface NativeAlmMeasuredExecution {
    readonly workloadEvidence: NativeAlmWorkloadEvidence;
    readonly failure: string | null;
    readonly measurement: NativeAlmCompletedMeasurement;
    readonly recorded: ReturnType<NativeAlmTimingRecorder['snapshot']>;
}

async function executeNativeAlmMeasurement(
    session: NativeAlmSession,
    workload: NativeAlmTimingWorkload
): Promise<NativeAlmMeasuredExecution> {
    let workloadEvidence = emptyNativeAlmWorkloadEvidence();
    let failure: string | null = null;
    let measurement: NativeAlmCompletedMeasurement;
    try {
        workloadEvidence = await runNativeAlmWorkload(session, workload);
    }
    catch (error) {
        failure = error instanceof Error ? error.message : String(error);
    }
    finally {
        measurement = session.measurement.finish();
        session.queueEngine.stop();
        session.runtime.dispose();
        session.admission.dispose();
        session.instrumentation.restore();
    }
    return { workloadEvidence, failure, measurement, recorded: session.recorder.snapshot() };
}

interface NativeAlmVerificationEvidence {
    readonly completedIdentities: readonly string[];
    readonly completedIdentityCount: number;
    readonly waitingEntryCount: number;
    readonly startedAtMs: number;
    readonly endedAtMs: number;
    readonly logicalOperationCounts: IndexedDbOperationCounts;
}

async function verifyNativeAlmDurableState(session: NativeAlmSession): Promise<NativeAlmVerificationEvidence> {
    session.observer.reset();
    const startedAtMs = performance.now();
    const durable = await auditNativeAlmDurableState(session);
    const endedAtMs = performance.now();
    return { ...durable, startedAtMs, endedAtMs, logicalOperationCounts: session.observer.getCounts() };
}

function toNativeAlmTimingProbe(
    context: Readonly<{
        input: Readonly<{ workload: NativeAlmTimingWorkload; databaseId: string; actorId: string; }>;
        session: NativeAlmSession;
        execution: NativeAlmMeasuredExecution;
        verification: NativeAlmVerificationEvidence;
    }>
): NativeAlmTimingProbe {
    const { input, session, execution, verification } = context;
    const { measurement, recorded, workloadEvidence, failure } = execution;
    return {
        workload: input.workload,
        actorId: input.actorId,
        databaseId: input.databaseId,
        measuredTree: 'runtime-base-plus-measurement-instrumentation',
        measurementPurpose: input.workload === 'shared-contention'
            ? 'semantic-contention'
            : 'performance-comparison',
        environment: {
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
            performanceTimeOriginMs: performance.timeOrigin
        },
        durationMs: measurement.durationMs,
        measurementStartedAtMs: measurement.startedAtMs,
        measurementEndedAtMs: measurement.endedAtMs,
        failure,
        throughputPerSecond: measurement.durationMs === 0
            ? 0
            : session.deliveredIdentities.length / (measurement.durationMs / 1_000),
        deliveredCount: session.deliveredIdentities.length,
        observedCommittedEffectIdentityCount: recorded.observedCommittedEffectIdentityCount,
        commitConflictCount: recorded.commitConflictCount,
        retryReservationCount: recorded.retryReservationCount,
        oldestEligibleAgeMs: recorded.oldestEligibleAgeMs,
        minimumLeaseMarginMs: recorded.minimumLeaseMarginMs,
        minimumDeadlineMarginMs: recorded.minimumDeadlineMarginMs,
        completeCausalIdentityCount: recorded.completeCausalIdentityCount,
        durableCompletedIdentities: verification.completedIdentities,
        durableCompletedIdentityCount: verification.completedIdentityCount,
        waitingEntryCount: verification.waitingEntryCount,
        logicalOperationCounts: measurement.logicalOperationCounts,
        terminalVerification: {
            startedAtMs: verification.startedAtMs,
            endedAtMs: verification.endedAtMs,
            logicalOperationCounts: verification.logicalOperationCounts
        },
        operationSamples: recorded.operationSamples,
        causalSamples: recorded.causalSamples,
        causalCoverage: recorded.causalCoverage,
        operationSummaries: recorded.operationSummaries,
        nativeTiming: measurement.nativeTiming,
        operationSampleCapacity: NATIVE_ALM_OPERATION_SAMPLE_CAPACITY,
        droppedOperationSampleCount: recorded.droppedOperationSampleCount,
        causalSampleCapacity: NATIVE_ALM_CAUSAL_SAMPLE_CAPACITY,
        droppedCausalSampleCount: recorded.droppedCausalSampleCount,
        methodsRestored: session.nativeRecorder.methodsRestored && session.instrumentation.restored,
        ...workloadEvidence
    };
}

interface NativeAlmWorkloadEvidence {
    readonly maximumSuccessorsBeyondRemainingPageCapacity: number;
    readonly recoveredKinds: readonly ('new' | 'retry' | 'expired-reserved')[];
    readonly boundedCommitCount: number;
}

interface NativeAlmPersistenceOwners {
    readonly namespace: string;
    readonly observer: ReturnType<typeof createCountingIndexedDbOperationObserver>;
    readonly backend: IndexedDbAdmissionBackend;
    readonly admissionStore: ALInboundAdmissionStore;
    readonly recorder: NativeAlmTimingRecorder;
    readonly instrumentation: NativeAlmOwnerInstrumentation;
}

interface NativeAlmRuntimeOwners {
    readonly queueEngine: InboxOutboxEngine;
    readonly deliveredIdentities: string[];
    readonly stores: ALInboundRuntimeStores;
    readonly runtime: ALInboundMessageRuntime;
    readonly admission: ALInboundMessageAdmission;
}

async function createNativeAlmSession(
    input: Readonly<{
        workload: NativeAlmTimingWorkload;
        databaseId: string;
        actorId: string;
    }>
): Promise<NativeAlmSession> {
    const persistence = createNativeAlmPersistenceOwners(input);
    const runtimeOwners = createNativeAlmRuntimeOwners({ input, persistence });
    await runtimeOwners.runtime.ready();
    persistence.observer.reset();
    const nativeRecorder = new NativeIndexedDbTimingRecorder(NATIVE_INDEXED_DB_SAMPLE_CAPACITY);
    const measurement = new NativeAlmMeasurementWindow({
        observer: persistence.observer,
        recorder: persistence.recorder,
        nativeRecorder
    });
    return {
        actorId: input.actorId,
        databaseId: input.databaseId,
        namespace: persistence.namespace,
        runtime: runtimeOwners.runtime,
        admission: runtimeOwners.admission,
        stores: runtimeOwners.stores,
        queue: persistence.backend.workQueue,
        queueEngine: runtimeOwners.queueEngine,
        observer: persistence.observer,
        recorder: persistence.recorder,
        nativeRecorder,
        measurement,
        instrumentation: persistence.instrumentation,
        deliveredIdentities: runtimeOwners.deliveredIdentities
    };
}

function createNativeAlmPersistenceOwners(
    input: Readonly<{
        workload: NativeAlmTimingWorkload;
        databaseId: string;
        actorId: string;
    }>
): NativeAlmPersistenceOwners {
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
    const instrumentation = new NativeAlmOwnerInstrumentation({
        admissionStore,
        queue: backend.workQueue,
        namespace,
        recorder,
        beforeFirstCommit: input.workload === 'shared-contention'
            ? createNativeAlmFirstCommitBarrier(input)
            : undefined
    });
    return { namespace, observer, backend, admissionStore, recorder, instrumentation };
}

function createNativeAlmRuntimeOwners(
    owners: Readonly<{
        input: Readonly<{ actorId: string; }>;
        persistence: NativeAlmPersistenceOwners;
    }>
): NativeAlmRuntimeOwners {
    const { persistence } = owners;
    const queueEngine = new InboxOutboxEngine();
    const deliveredIdentities: string[] = [];
    const stores = { admissionStore: persistence.admissionStore, workQueue: persistence.backend.workQueue };
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
            persistence.recorder.observeCallback(identity, 'callback-start');
            deliveredIdentities.push(identity);
            persistence.recorder.observeCallback(identity, 'callback-end');
        },
        sendControlMessage: async () => {},
        diagnostics: undefined,
        effectWorkerId: `native-alm:${owners.input.actorId}`
    });
    const admission = new ALInboundMessageAdmission({
        ...resources,
        planIncomingMessage,
        workPort: createALWorkQueuePort({
            queue: persistence.backend.workQueue,
            workTypes: new Set([toALInboundWorkType(persistence.namespace)]),
            leaseMs: AL_INBOUND_WORK_LEASE_MS,
            nowMs: Date.now,
            random: () => 0.5
        })
    });
    return { queueEngine, deliveredIdentities, stores, runtime, admission };
}

function createNativeAlmFirstCommitBarrier(
    input: Readonly<{ databaseId: string; actorId: string; }>
): () => Promise<void> {
    return async () => {
        const barrierPrefix = `native-alm-contention:${input.databaseId}:commit:`;
        localStorage.setItem(`${barrierPrefix}${input.actorId}`, 'entered');
        await waitForNativeAlmCondition(
            () =>
                localStorage.getItem(`${barrierPrefix}first`) === 'entered' &&
                localStorage.getItem(`${barrierPrefix}second`) === 'entered',
            'both native ALM contention commits to enter'
        );
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
    await waitForDeliveredAndCompletedIdentities(session, new Set([message.id.msgId]));
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
    await waitForDeliveredAndCompletedIdentities(session, identities);
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
    await waitForDeliveredAndCompletedIdentities(
        session,
        new Set([...eligibleIdentities, ...producerIdentities])
    );
    return {
        maximumSuccessorsBeyondRemainingPageCapacity: 0,
        recoveredKinds: ['new', 'retry', 'expired-reserved'],
        boundedCommitCount: producerIdentities.size
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
    localStorage.setItem(`${barrierPrefix}${session.actorId}:admission`, 'settled');
    await waitForNativeAlmCondition(
        () =>
            localStorage.getItem(`${barrierPrefix}first:admission`) === 'settled' &&
            localStorage.getItem(`${barrierPrefix}second:admission`) === 'settled',
        'both native ALM contention admissions to settle'
    );
    if (session.actorId === 'first') {
        session.queueEngine.start();
        await waitForDeliveredAndCompletedIdentities(session, new Set([message.id.msgId]));
        localStorage.setItem(`${barrierPrefix}completion`, 'completed');
    }
    else {
        await waitForNativeAlmCondition(
            () => localStorage.getItem(`${barrierPrefix}completion`) === 'completed',
            'native ALM contention completed effect release'
        );
    }
    return emptyNativeAlmWorkloadEvidence();
}

function beginNativeAlmMeasurement(session: NativeAlmSession): void {
    session.measurement.begin();
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
    status: typeof EntityStatus.RETRY | typeof EntityStatus.RESERVED
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

async function waitForDeliveredAndCompletedIdentities(
    session: NativeAlmSession,
    expected: ReadonlySet<string>
): Promise<void> {
    await waitForDeliveredIdentities(session, expected);
    await waitForNativeAlmCondition(
        () => [...expected].every((identity) => session.recorder.hasObservedCompletedEffectRelease(identity)),
        `returned COMPLETED effect releases ${[...expected].join(', ')}`
    );
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

async function auditNativeAlmDurableState(
    session: NativeAlmSession
): Promise<
    Readonly<{
        completedIdentities: readonly string[];
        completedIdentityCount: number;
        waitingEntryCount: number;
    }>
> {
    const identities = new Set<string>();
    let waitingEntryCount = 0;
    for (const key of await session.queue.getAllKeys()) {
        const entry = await session.queue.getItem(key);
        if (entry === undefined) {
            continue;
        }
        const effect = decodeALInboundWorkEntry(entry, session.namespace);
        const identity = toNativeAlmEffectIdentity(effect.payload, effect.effectId);
        if (entry.status !== EntityStatus.COMPLETED) {
            if (identity.startsWith('waiting-')) {
                waitingEntryCount += 1;
            }
            continue;
        }
        if (!isNativeAlmParent(effect.payload)) {
            identities.add(identity);
        }
    }
    return {
        completedIdentities: [...identities].sort(),
        completedIdentityCount: identities.size,
        waitingEntryCount
    };
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

const createNativeAlmPlan: ALInboundPlanner = (message, _source, observations) => {
    return planALMessageHandling(message, {
        ...observations,
        selfPeerId: ALM_SELF_PEER_ID,
        fromPeerId: ALM_SENDER_PEER_ID
    });
};

function emptyNativeAlmWorkloadEvidence(): NativeAlmWorkloadEvidence {
    return {
        maximumSuccessorsBeyondRemainingPageCapacity: 0,
        recoveredKinds: [],
        boundedCommitCount: 0
    };
}
