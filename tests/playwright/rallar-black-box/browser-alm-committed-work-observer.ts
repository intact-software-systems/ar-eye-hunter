import type { ALMessage } from '../../../packages/shared/al-contracts/al-contract.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle,
    ALInboundDurableEffect
} from '../../../packages/shared/alm/inbound/al-inbound-admission-store.ts';
import {
    decodeALInboundWorkEntry,
    resolveALInboundWorkReadyAt
} from '../../../packages/shared/alm/inbound/al-inbound-work-entry.ts';
import { AL_INBOUND_WORK_LEASE_MS } from '../../../packages/shared/alm/inbound/al-inbound-work-entry.ts';
import { computeALWorkLeaseUntilMs } from '../../../packages/shared/alm/work/al-work-queue-port.ts';
import { IndexedDbQueueBox } from '../../../packages/shared/queuebox/indexed-db-queue-box.ts';
import type {
    ResourceInboxReservationRequest,
    ResourceInboxTimeoutReservationRequest,
    ResourceInboxWorkPage
} from '../../../packages/shared/queuebox/queue-box-types.ts';
import {
    EntityStatus,
    toKeyAsString,
    type Key,
    type ResourceEntry
} from '../../../packages/shared/queuebox/ResourceEntry.ts';

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

export const NATIVE_ALM_OPERATION_SAMPLE_CAPACITY = 20_000;
export const NATIVE_ALM_CAUSAL_SAMPLE_CAPACITY = 20_000;

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

export class NativeAlmTimingRecorder {
    readonly #operationSamples: NativeAlmOperationSample[] = [];
    readonly #causalSamples: NativeAlmCausalSample[] = [];
    readonly #deadlineByIdentity = new Map<string, number>();
    readonly #leaseUntilByIdentity = new Map<string, number>();
    readonly #committedEffectIdentities = new Set<string>();
    readonly #completedEffectReleaseIdentities = new Set<string>();
    #droppedOperationSampleCount = 0;
    #droppedCausalSampleCount = 0;
    #commitConflictCount = 0;
    #retryReservationCount = 0;
    #oldestEligibleAgeMs = 0;

    resetMeasurements(): void {
        this.#operationSamples.length = 0;
        this.#causalSamples.length = 0;
        this.#committedEffectIdentities.clear();
        this.#leaseUntilByIdentity.clear();
        this.#completedEffectReleaseIdentities.clear();
        this.#droppedOperationSampleCount = 0;
        this.#droppedCausalSampleCount = 0;
        this.#commitConflictCount = 0;
        this.#retryReservationCount = 0;
        this.#oldestEligibleAgeMs = 0;
    }

    registerMessage(message: ALMessage): void {
        const deadline = message.constraints?.expiresAtMs;
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
            this.recordPhase({ identity, phase: 'effects-committed' });
        }
    }

    observeRetainedEntry(entry: ResourceEntry, namespace: string): void {
        const effect = decodeALInboundWorkEntry(entry, namespace);
        if (isNativeAlmParent(effect.payload)) {
            this.recordPhase({
                identity: toNativeAlmEffectIdentity(effect.payload, effect.effectId),
                phase: 'pending-admission-retained'
            });
        }
    }

    observeReservedEntry(
        input: Readonly<{
            reservedEntry: ResourceEntry;
            observedEntry: ResourceEntry | undefined;
            namespace: string;
        }>
    ): void {
        const effect = decodeALInboundWorkEntry(input.reservedEntry, input.namespace);
        const identity = toNativeAlmEffectIdentity(effect.payload, effect.effectId);
        const nowEpochMs = Date.now();
        const queueAgeMs = input.observedEntry === undefined
            ? null
            : Math.max(0, nowEpochMs - resolveALInboundWorkReadyAt(input.observedEntry));
        const leaseMarginMs = computeALWorkLeaseUntilMs(input.reservedEntry, AL_INBOUND_WORK_LEASE_MS) - nowEpochMs;
        this.#leaseUntilByIdentity.set(identity, nowEpochMs + leaseMarginMs);
        if (queueAgeMs !== null) {
            this.#oldestEligibleAgeMs = Math.max(this.#oldestEligibleAgeMs, queueAgeMs);
        }
        if (input.reservedEntry.dequeueAudit.attempts > 1) {
            this.#retryReservationCount += 1;
        }
        this.recordPhase({
            identity,
            phase: isNativeAlmParent(effect.payload) ? 'parent-reserved' : 'successor-reserved',
            queueAgeMs,
            leaseMarginMs
        });
    }

    observeReturnedReleaseEntry(entry: ResourceEntry, namespace: string): void {
        const effect = decodeALInboundWorkEntry(entry, namespace);
        const identity = toNativeAlmEffectIdentity(effect.payload, effect.effectId);
        const parent = isNativeAlmParent(effect.payload);
        this.recordPhase({ identity, phase: parent ? 'parent-released' : 'effect-released' });
        this.#leaseUntilByIdentity.delete(identity);
        if (!parent && entry.status === EntityStatus.COMPLETED) {
            this.#completedEffectReleaseIdentities.add(identity);
        }
    }

    observeCallback(identity: string, phase: 'callback-start' | 'callback-end'): void {
        this.recordPhase({ identity, phase });
    }

    hasObservedCompletedEffectRelease(identity: string): boolean {
        return this.#completedEffectReleaseIdentities.has(identity);
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
        if (this.#operationSamples.length < NATIVE_ALM_OPERATION_SAMPLE_CAPACITY) {
            this.#operationSamples.push(sample);
        }
        else {
            this.#droppedOperationSampleCount += 1;
        }
    }

    private recordPhase(
        observation: Readonly<{
            identity: string;
            phase: NativeAlmCausalPhase;
            queueAgeMs?: number | null;
            leaseMarginMs?: number | null;
        }>
    ): void {
        const { identity, phase } = observation;
        const leaseUntilMs = this.#leaseUntilByIdentity.get(identity);
        const deadline = this.#deadlineByIdentity.get(identity);
        const sample: NativeAlmCausalSample = {
            identity,
            phase,
            atMs: performance.now(),
            queueAgeMs: observation.queueAgeMs ?? null,
            leaseMarginMs: observation.leaseMarginMs ??
                (leaseUntilMs === undefined ? null : leaseUntilMs - Date.now()),
            deadlineMarginMs: deadline === undefined ? null : deadline - Date.now()
        };
        if (this.#causalSamples.length < NATIVE_ALM_CAUSAL_SAMPLE_CAPACITY) {
            this.#causalSamples.push(sample);
        }
        else {
            this.#droppedCausalSampleCount += 1;
        }
    }
}

export namespace NativeAlmOwnerInstrumentation {
    export interface Dependencies {
        readonly admissionStore: ALInboundAdmissionStore;
        readonly queue: IndexedDbQueueBox;
        readonly namespace: string;
        readonly recorder: NativeAlmTimingRecorder;
        readonly beforeFirstCommit: (() => Promise<void>) | undefined;
    }
}

export class NativeAlmOwnerInstrumentation {
    readonly #dependencies: NativeAlmOwnerInstrumentation.Dependencies;
    readonly #originalCommitBundle: ALInboundAdmissionStore['commitBundle'];
    readonly #originalReadWorkPage: IndexedDbQueueBox['readWorkPage'];
    readonly #originalReadWorkPages: IndexedDbQueueBox['readWorkPages'];
    readonly #originalReserveEntries: IndexedDbQueueBox['reserveEntries'];
    readonly #originalReserveTimeoutEntries: IndexedDbQueueBox['reserveTimeoutEntries'];
    readonly #originalReserveRetryExhaustionFinalizations: IndexedDbQueueBox['reserveRetryExhaustionFinalizations'];
    readonly #originalReleaseEntries: IndexedDbQueueBox['releaseEntries'];
    readonly #originalEnqueueIfAbsent: IndexedDbQueueBox['enqueueIfAbsent'];
    #firstCommit = true;

    constructor(dependencies: NativeAlmOwnerInstrumentation.Dependencies) {
        this.#dependencies = dependencies;
        this.#originalCommitBundle = dependencies.admissionStore.commitBundle;
        this.#originalReadWorkPage = dependencies.queue.readWorkPage;
        this.#originalReadWorkPages = dependencies.queue.readWorkPages;
        this.#originalReserveEntries = dependencies.queue.reserveEntries;
        this.#originalReserveTimeoutEntries = dependencies.queue.reserveTimeoutEntries;
        this.#originalReserveRetryExhaustionFinalizations = dependencies.queue.reserveRetryExhaustionFinalizations;
        this.#originalReleaseEntries = dependencies.queue.releaseEntries;
        this.#originalEnqueueIfAbsent = dependencies.queue.enqueueIfAbsent;
        this.installCommitObservation();
        this.installWorkReadObservation();
        this.installReservationObservation();
        this.installReleaseObservation();
    }

    get restored(): boolean {
        const { admissionStore, queue } = this.#dependencies;
        return admissionStore.commitBundle === this.#originalCommitBundle &&
            queue.readWorkPage === this.#originalReadWorkPage &&
            queue.readWorkPages === this.#originalReadWorkPages &&
            queue.reserveEntries === this.#originalReserveEntries &&
            queue.reserveTimeoutEntries === this.#originalReserveTimeoutEntries &&
            queue.reserveRetryExhaustionFinalizations === this.#originalReserveRetryExhaustionFinalizations &&
            queue.releaseEntries === this.#originalReleaseEntries &&
            queue.enqueueIfAbsent === this.#originalEnqueueIfAbsent;
    }

    restore(): void {
        const { admissionStore, queue } = this.#dependencies;
        admissionStore.commitBundle = this.#originalCommitBundle;
        queue.readWorkPage = this.#originalReadWorkPage;
        queue.readWorkPages = this.#originalReadWorkPages;
        queue.reserveEntries = this.#originalReserveEntries;
        queue.reserveTimeoutEntries = this.#originalReserveTimeoutEntries;
        queue.reserveRetryExhaustionFinalizations = this.#originalReserveRetryExhaustionFinalizations;
        queue.releaseEntries = this.#originalReleaseEntries;
        queue.enqueueIfAbsent = this.#originalEnqueueIfAbsent;
    }

    private installCommitObservation(): void {
        const { admissionStore, recorder, beforeFirstCommit } = this.#dependencies;
        admissionStore.commitBundle = async (bundle) => {
            if (this.#firstCommit) {
                this.#firstCommit = false;
                await beforeFirstCommit?.();
            }
            const outcome = await recorder.measure(
                'commit',
                () => this.#originalCommitBundle.call(admissionStore, bundle),
                (result) => result
            );
            recorder.observeCommittedBundle(bundle, outcome);
            return outcome;
        };
    }

    private installWorkReadObservation(): void {
        const { queue, recorder } = this.#dependencies;
        queue.readWorkPage = async (request: ResourceInboxWorkPage.Request) =>
            await recorder.measure('work-page', () => this.#originalReadWorkPage.call(queue, request));
        queue.readWorkPages = async (requests: readonly ResourceInboxWorkPage.Request[]) =>
            await recorder.measure('work-page', () => this.#originalReadWorkPages.call(queue, requests));
    }

    private installReservationObservation(): void {
        const { queue, recorder, namespace } = this.#dependencies;
        queue.reserveEntries = async (request: ResourceInboxReservationRequest) => {
            const reserved = await recorder.measure(
                'reservation',
                () => this.#originalReserveEntries.call(queue, request)
            );
            observeSuccessfulReservations({ recorder, namespace, observedEntries: request.observedEntries, reserved });
            return reserved;
        };
        queue.reserveTimeoutEntries = async (request: ResourceInboxTimeoutReservationRequest) => {
            const reserved = await recorder.measure(
                'reservation',
                () => this.#originalReserveTimeoutEntries.call(queue, request)
            );
            observeSuccessfulReservations({ recorder, namespace, observedEntries: request.observedEntries, reserved });
            return reserved;
        };
        queue.reserveRetryExhaustionFinalizations = async (typeIds, request) =>
            await recorder.measure(
                'reservation',
                () => this.#originalReserveRetryExhaustionFinalizations.call(queue, typeIds, request)
            );
    }

    private installReleaseObservation(): void {
        const { queue, recorder, namespace } = this.#dependencies;
        queue.releaseEntries = async (entries, disposition) => {
            const released = await recorder.measure(
                'release',
                () => this.#originalReleaseEntries.call(queue, entries, disposition)
            );
            for (const entry of released.values()) {
                recorder.observeReturnedReleaseEntry(entry, namespace);
            }
            return released;
        };
        queue.enqueueIfAbsent = async (entry) => {
            const retained = await this.#originalEnqueueIfAbsent.call(queue, entry);
            recorder.observeRetainedEntry(retained, namespace);
            return retained;
        };
    }
}

function observeSuccessfulReservations(
    input: Readonly<{
        recorder: NativeAlmTimingRecorder;
        namespace: string;
        observedEntries: readonly ResourceEntry[] | undefined;
        reserved: ReadonlyMap<Key, ResourceEntry>;
    }>
): void {
    const observations = new Map(
        input.observedEntries?.map((entry) => [toKeyAsString(entry.key), entry]) ?? []
    );
    for (const reservedEntry of input.reserved.values()) {
        input.recorder.observeReservedEntry({
            reservedEntry,
            observedEntry: observations.get(toKeyAsString(reservedEntry.key)),
            namespace: input.namespace
        });
    }
}

export function isNativeAlmParent(effect: ALInboundDurableEffect): boolean {
    return effect.kind === 'admit-message' || effect.kind === 'admit-control';
}

export function toNativeAlmEffectIdentity(effect: ALInboundDurableEffect, effectId: string): string {
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
