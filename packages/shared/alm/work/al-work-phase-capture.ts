import type {
    ALWorkAttemptResult,
    ALWorkBatchDiagnostics,
    ALWorkReadinessProbeDiagnostics
} from './al-work-handler.ts';

const SUMMARY_RESERVE_BYTES = 4096;

export namespace ALWorkPhaseCapture {
    export interface Clock {
        readonly nowEpochMs: () => number;
        readonly nowMonotonicMs: () => number;
    }

    export interface ClockSample {
        readonly epochMs: number;
        readonly monotonicMs: number;
    }

    export interface Input {
        readonly serverPeerId: string;
        readonly clock: Clock;
        readonly maxRecords: number;
        readonly maxBytes: number;
        readonly writeObservation: (observation: Observation, remainingBytes: number) => WriteResult;
    }

    export type WriteResult =
        | { readonly status: 'emitted'; readonly bytes: number; }
        | { readonly status: 'overflow' | 'failed'; };

    export interface ClaimIdentity {
        readonly workerId: string;
        readonly workLocator: string;
        readonly attempts: number;
        readonly storedClaimStartedAtMs: number | undefined;
        readonly batchStartedAtMs: number;
    }

    export interface Claim extends ClaimIdentity {
        readonly claimSequence: number;
        readonly batchSequence: number | undefined;
        readonly started: ClockSample;
    }

    export interface ClaimEnd {
        readonly claim: Claim;
        readonly lookupReturned: ClockSample | undefined;
        readonly lookupOutcome: 'returned' | 'threw' | 'expired';
        readonly callbackOutcome: ALWorkAttemptResult['status'] | 'threw';
        readonly effectKind: string | undefined;
        readonly effectLocator: string | undefined;
    }

    export interface BatchObservation extends Omit<ALWorkBatchDiagnostics, 'kind' | 'queueWaitMs'> {
        readonly kind: 'outbound-work-batch';
        readonly serverPeerId: string;
        readonly batchSequence: number | undefined;
        readonly batchStartedAtMs: number;
        readonly batchEndedAtMs: number;
        readonly durationClock: 'api-epoch';
        readonly dueWait: 'uncaptured';
    }

    export interface ReadinessObservation extends Omit<ALWorkReadinessProbeDiagnostics, 'kind'> {
        readonly kind: 'outbound-readiness-probe';
        readonly serverPeerId: string;
        readonly probeStartedAtMs: number;
        readonly probeEndedAtMs: number;
        readonly durationClock: 'api-epoch';
    }

    export interface ClaimObservation extends ClaimIdentity {
        readonly kind: 'outbound-claim-phases';
        readonly serverPeerId: string;
        readonly claimSequence: number;
        readonly batchSequence: number | undefined;
        readonly callbackStartedAtMs: number;
        readonly lookupReturnedAtMs: number | undefined;
        readonly callbackEndedAtMs: number;
        readonly lookupDurationMs: number | undefined;
        readonly callbackDurationMs: number | undefined;
        readonly lookupOutcome: ClaimEnd['lookupOutcome'];
        readonly callbackOutcome: ClaimEnd['callbackOutcome'];
        readonly effectKind: string | undefined;
        readonly effectLocator: string | undefined;
        readonly durationClock: 'api-monotonic';
        readonly reservationClock: 'store';
    }

    export interface FlushObservation {
        readonly kind: 'outbound-phase-flush';
        readonly serverPeerId: string;
        readonly flushedRecordCount: number;
        readonly durationMs: number | undefined;
        readonly durationClock: 'api-monotonic';
    }

    export interface Summary {
        readonly kind: 'outbound-phase-summary';
        readonly serverPeerId: string;
        readonly closed: true;
        readonly attemptedRecords: number;
        readonly emittedRecords: number;
        readonly emittedBytes: number;
        readonly overflowRecords: number;
        readonly sinkFailures: number;
        readonly clockFailures: number;
        readonly unfinishedBatches: number;
        readonly abandonedBatches: number;
        readonly maxRecords: number;
        readonly maxBytes: number;
    }

    export type Observation = BatchObservation | ReadinessObservation | ClaimObservation | FlushObservation | Summary;
}

/** Private metadata only; the API composition owns its clocks, writer, bounds and shutdown. */
export class ALWorkPhaseCapture {
    private readonly input: ALWorkPhaseCapture.Input;
    private readonly records: ALWorkPhaseCapture.Observation[] = [];
    private readonly activeBatches = new Map<string, number>();
    private batchSequence = 0;
    private claimSequence = 0;
    private attemptedRecords = 0;
    private admittedRecords = 0;
    private emittedRecords = 0;
    private emittedBytes = 0;
    private overflowRecords = 0;
    private sinkFailures = 0;
    private clockFailures = 0;
    private abandonedBatches = 0;
    private flushing = false;
    private closeRequested = false;
    private closed = false;

    constructor(input: ALWorkPhaseCapture.Input) {
        this.input = input;
    }

    beginBatch(workerId: string): void {
        if (this.closed || this.closeRequested) {
            return;
        }
        if (this.activeBatches.size >= this.input.maxRecords && !this.activeBatches.has(workerId)) {
            this.overflowRecords += 1;
            return;
        }
        this.activeBatches.set(workerId, ++this.batchSequence);
    }

    recordBatch(event: ALWorkBatchDiagnostics, batchStartedAtMs: number, batchEndedAtMs: number): void {
        const { kind: _kind, queueWaitMs: _queueWaitMs, ...facts } = event;
        this.record({
            ...facts,
            kind: 'outbound-work-batch',
            serverPeerId: this.input.serverPeerId,
            batchSequence: this.activeBatches.get(event.workerId),
            batchStartedAtMs,
            batchEndedAtMs,
            durationClock: 'api-epoch',
            dueWait: 'uncaptured'
        });
        this.activeBatches.delete(event.workerId);
    }

    endBatch(workerId: string): void {
        if (this.activeBatches.delete(workerId)) {
            this.abandonedBatches += 1;
        }
    }

    recordReadiness(event: ALWorkReadinessProbeDiagnostics, beganAtMs: number, endedAtMs: number): void {
        this.record({
            ...event,
            kind: 'outbound-readiness-probe',
            serverPeerId: this.input.serverPeerId,
            probeStartedAtMs: beganAtMs,
            probeEndedAtMs: endedAtMs,
            durationClock: 'api-epoch'
        });
    }

    beginClaim(identity: ALWorkPhaseCapture.ClaimIdentity): ALWorkPhaseCapture.Claim | undefined {
        if (this.closed || this.closeRequested) {
            return undefined;
        }
        const started = this.readClock();
        return started === undefined ? undefined : Object.freeze({
            ...identity,
            started,
            claimSequence: ++this.claimSequence,
            batchSequence: this.activeBatches.get(identity.workerId)
        });
    }

    /** Clock failure loses optional facts and never escapes to the business callback. */
    readClock(): ALWorkPhaseCapture.ClockSample | undefined {
        try {
            const epochMs = this.input.clock.nowEpochMs();
            const monotonicMs = this.input.clock.nowMonotonicMs();
            if (!Number.isFinite(epochMs) || epochMs < 0 || !Number.isFinite(monotonicMs) || monotonicMs < 0) {
                this.clockFailures += 1;
                return undefined;
            }
            return Object.freeze({ epochMs, monotonicMs });
        }
        catch {
            this.clockFailures += 1;
            return undefined;
        }
    }

    finishClaim(ended: ALWorkPhaseCapture.ClaimEnd): void {
        const end = this.readClock();
        if (end === undefined) {
            return;
        }
        const { started, ...identity } = ended.claim;
        this.record({
            ...identity,
            kind: 'outbound-claim-phases',
            serverPeerId: this.input.serverPeerId,
            callbackStartedAtMs: started.epochMs,
            lookupReturnedAtMs: ended.lookupReturned?.epochMs,
            callbackEndedAtMs: end.epochMs,
            lookupDurationMs: ended.lookupReturned === undefined
                ? undefined
                : this.computeDuration(started, ended.lookupReturned),
            callbackDurationMs: this.computeDuration(started, end),
            lookupOutcome: ended.lookupOutcome,
            callbackOutcome: ended.callbackOutcome,
            effectKind: ended.effectKind,
            effectLocator: ended.effectLocator,
            durationClock: 'api-monotonic',
            reservationClock: 'store'
        });
    }

    /** Invoked only after the handler's mandatory completion or owned API shutdown. */
    flush(): void {
        if (this.flushing || this.records.length === 0) {
            return;
        }
        this.flushing = true;
        const started = this.readClock();
        const records = this.records.splice(0);
        try {
            for (const record of records) {
                this.write(record, false);
            }
            const ended = this.readClock();
            if (this.admit()) {
                this.write(
                    Object.freeze({
                        kind: 'outbound-phase-flush',
                        serverPeerId: this.input.serverPeerId,
                        flushedRecordCount: records.length,
                        durationMs: started === undefined || ended === undefined
                            ? undefined
                            : this.computeDuration(started, ended),
                        durationClock: 'api-monotonic'
                    }),
                    false
                );
            }
        }
        finally {
            this.flushing = false;
            if (this.closeRequested) {
                this.close();
            }
        }
    }

    close(): void {
        if (this.closed) {
            return;
        }
        if (this.flushing) {
            this.closeRequested = true;
            return;
        }
        this.closeRequested = false;
        this.closed = true;
        this.flush();
        const summary: ALWorkPhaseCapture.Summary = {
            kind: 'outbound-phase-summary',
            serverPeerId: this.input.serverPeerId,
            closed: true,
            attemptedRecords: this.attemptedRecords,
            emittedRecords: this.emittedRecords,
            emittedBytes: this.emittedBytes,
            overflowRecords: this.overflowRecords,
            sinkFailures: this.sinkFailures,
            clockFailures: this.clockFailures,
            unfinishedBatches: this.activeBatches.size,
            abandonedBatches: this.abandonedBatches,
            maxRecords: this.input.maxRecords,
            maxBytes: this.input.maxBytes
        };
        this.activeBatches.clear();
        this.write(Object.freeze(summary), true);
    }

    private computeDuration(
        started: ALWorkPhaseCapture.ClockSample,
        ended: ALWorkPhaseCapture.ClockSample
    ): number | undefined {
        if (ended.monotonicMs < started.monotonicMs) {
            this.clockFailures += 1;
            return undefined;
        }
        return ended.monotonicMs - started.monotonicMs;
    }

    private record(observation: ALWorkPhaseCapture.Observation): void {
        if (!this.closed && !this.closeRequested && this.admit()) {
            this.records.push(Object.freeze(observation));
        }
    }

    private admit(): boolean {
        this.attemptedRecords += 1;
        // The final custody summary uses one slot in the same total emission bound.
        if (this.admittedRecords >= this.input.maxRecords - 1) {
            this.overflowRecords += 1;
            return false;
        }
        this.admittedRecords += 1;
        return true;
    }

    private write(observation: ALWorkPhaseCapture.Observation, summary: boolean): void {
        const reserved = summary ? 0 : SUMMARY_RESERVE_BYTES;
        const remainingBytes = Math.max(0, this.input.maxBytes - this.emittedBytes - reserved);
        try {
            const result = this.input.writeObservation(observation, remainingBytes);
            if (result.status === 'overflow') {
                this.overflowRecords += 1;
            }
            else if (result.status === 'failed') {
                this.sinkFailures += 1;
            }
            else if (result.status === 'emitted') {
                this.emittedRecords += 1;
                this.emittedBytes += result.bytes;
            }
        }
        catch {
            this.sinkFailures += 1;
        }
    }
}
