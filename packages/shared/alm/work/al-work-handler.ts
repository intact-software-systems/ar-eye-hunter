import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { toError } from '../../resilience/to-error.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort } from './al-work-queue-port.ts';

export type ALWorkAttemptResult =
    | ALWorkOutcome
    | Readonly<{ status: 'retained'; settled: Promise<ALWorkOutcome>; }>;

export interface ALWorkReadySelection {
    readonly claims: readonly ALWorkClaim[];
    /** A non-negative safe integer (epoch ms) or undefined; `wakeAt` throws `RangeError` on anything else — never clamped here. */
    readonly nextReadyAtMs: number | undefined;
}

export interface ALWorkHandlerDependencies {
    readonly workerId: string;
    readonly port: ALWorkQueuePort;
    readonly queueEngine: InboxOutboxEngine;
    readonly ownsQueueEngine: boolean;
    readonly clock: { nowMs(): number; };
    readonly pageSize: number;
    /**
     * Decides when the engine should run a batch. A non-negative safe integer (epoch ms) at or before
     * `clock.nowMs()` starts one; a later value only reschedules; undefined means no work. Owners whose
     * eligibility rules defer rows pass their own probe so deferred rows never advertise as due.
     */
    readonly readNextReadyAtMs: (port: ALWorkQueuePort) => Promise<number | undefined>;
    /** Reads eligible work; the port owns reservation. */
    readonly selectReady: (
        port: ALWorkQueuePort,
        pageSize: number
    ) => Promise<ALWorkReadySelection>;
    readonly runClaim: (claim: ALWorkClaim) => Promise<ALWorkAttemptResult>;
    readonly diagnostics: ((event: ALWorkBatchDiagnostics) => void) | undefined;
}

export interface ALWorkBatchDiagnostics {
    readonly kind: 'work-batch';
    readonly workerId: string;
    readonly durationMs: number;
    readonly claimedCount: number;
    readonly completedCount: number;
    readonly rescheduledCount: number;
    readonly rejectedCount: number;
}

interface ALWorkCounts {
    claimedCount: number;
    completedCount: number;
    rescheduledCount: number;
    rejectedCount: number;
}

/** Generic ALM work loop: the port owns reservation and retry policy, this owns the engine task and batch lifecycle. */
export class ALWorkHandler {
    private readonly dependencies: ALWorkHandlerDependencies;
    private batch: Promise<void> | undefined;
    private bootstrapped = false;
    /** Set when committed() lands while a batch is running; drained by one follow-up batch at that batch's end. */
    private commitPending = false;
    private readonly shutdown = new AbortController();

    constructor(dependencies: ALWorkHandlerDependencies) {
        this.dependencies = dependencies;
        dependencies.queueEngine.includeTask(dependencies.workerId, {
            name: dependencies.workerId,
            maxConcurrency: () => 1,
            isWork: () => this.hasReadyWork(),
            runnable: () => this.runBatch().catch((error) => this.reportBatchFailure(toError(error))),
            ongoingTasks: []
        });
    }

    async ready(): Promise<void> {
        if (this.bootstrapped || this.shutdown.signal.aborted) {
            return;
        }
        await this.runBatch();
        this.bootstrapped = true;
        if (!this.shutdown.signal.aborted && this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.start();
        }
    }

    dispose(): void {
        this.shutdown.abort();
        this.dependencies.queueEngine.excludeTask(this.dependencies.workerId);
        if (this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.stop();
        }
    }

    /** After a commit: wakes the engine and runs one batch if idle; never blocks on delivery of unrelated work. */
    committed(): void {
        this.dependencies.queueEngine.wake();
        if (this.batch === undefined) {
            void this.runBatch().catch((error) => this.reportBatchFailure(toError(error)));
        }
        else {
            this.commitPending = true;
        }
    }

    private async hasReadyWork(): Promise<boolean> {
        if (this.shutdown.signal.aborted || this.batch !== undefined) {
            return false;
        }
        const next = await this.dependencies.readNextReadyAtMs(this.dependencies.port);
        this.dependencies.queueEngine.wakeAt(this.dependencies.workerId, next);
        return next !== undefined && next <= this.dependencies.clock.nowMs();
    }

    private runBatch(): Promise<void> {
        if (this.shutdown.signal.aborted) {
            return Promise.resolve();
        }
        if (this.batch !== undefined) {
            return this.batch;
        }
        this.batch = this.runSelectedWork().then((counts) => this.wakeAfterProgress(counts)).catch((error) => {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            this.reportBatchFailure(toError(error));
        }).finally(() => {
            this.batch = undefined;
            this.runPendingCommit();
        });
        return this.batch;
    }

    /**
     * A batch that touched work may have written more the page read before it could not see. A batch
     * that touched none advertised its own next time through `wakeAt` and must not re-enter this tick.
     */
    private wakeAfterProgress(counts: ALWorkCounts): void {
        if (counts.claimedCount > 0 || counts.rejectedCount > 0) {
            this.dependencies.queueEngine.wake();
        }
    }

    /** A commit that landed behind the batch earns the immediate re-run the page read missed. */
    private runPendingCommit(): void {
        if (!this.commitPending || this.shutdown.signal.aborted) {
            return;
        }
        this.commitPending = false;
        this.dependencies.queueEngine.wake();
        void this.runBatch().catch((error) => this.reportBatchFailure(toError(error)));
    }

    private async runSelectedWork(): Promise<ALWorkCounts> {
        const { port, pageSize, selectReady, clock, workerId, queueEngine, diagnostics } = this.dependencies;
        const startedAtMs = clock.nowMs();
        const counts: ALWorkCounts = {
            claimedCount: 0,
            completedCount: 0,
            rescheduledCount: 0,
            rejectedCount: 0
        };
        await this.finalizeExhaustedWork(counts);
        if (this.shutdown.signal.aborted) {
            return counts;
        }
        const selection = await selectReady(port, pageSize);
        counts.claimedCount = selection.claims.length;
        for (const claim of selection.claims) {
            if (this.shutdown.signal.aborted) {
                return counts;
            }
            await this.runOne(claim, counts);
        }
        queueEngine.wakeAt(workerId, selection.nextReadyAtMs);
        diagnostics?.({
            kind: 'work-batch',
            workerId,
            durationMs: Math.max(0, clock.nowMs() - startedAtMs),
            ...counts
        });
        return counts;
    }

    private async finalizeExhaustedWork(counts: ALWorkCounts): Promise<void> {
        const { port, pageSize } = this.dependencies;
        for (const claim of await port.finalizeExhausted(pageSize)) {
            if (this.shutdown.signal.aborted) {
                return;
            }
            await port.release(claim, { status: 'non-retryable' });
            counts.rejectedCount += 1;
        }
    }

    private async runOne(claim: ALWorkClaim, counts: ALWorkCounts): Promise<void> {
        let result: ALWorkAttemptResult;
        try {
            result = await this.dependencies.runClaim(claim);
        }
        catch (error) {
            result = error instanceof ALAdmissionCorruptionError ||
                    error instanceof NonRetryableException
                ? { status: 'non-retryable' }
                : { status: 'retry' };
        }
        if (result.status === 'retained') {
            // A rejected `settled` only logs here: `release` never runs, so the claim is recovered
            // solely by lease expiry (the port's timeout-reservation path), and it is never added to
            // `counts` on this path or on the eventual release.
            void result.settled
                .then((outcome) => this.dependencies.port.release(claim, outcome))
                .catch((error) => console.error('Retained ALM work failed', error))
                .finally(() => this.dependencies.queueEngine.wake());
            return;
        }
        await this.dependencies.port.release(claim, result);
        if (result.status === 'completed') {
            counts.completedCount += 1;
        }
        else if (result.status === 'non-retryable') {
            counts.rejectedCount += 1;
        }
        else {
            counts.rescheduledCount += 1;
        }
    }

    private reportBatchFailure(error: Error): void {
        console.error('ALM work batch failed', error);
    }
}
