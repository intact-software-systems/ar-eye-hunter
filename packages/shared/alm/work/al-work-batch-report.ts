import type {
    ALWorkBatchEndKind,
    ALWorkDiagnostics,
    ALWorkReadySelection
} from './al-work-handler.ts';

export namespace ALWorkBatchReport {
    export interface Dependencies {
        readonly clock: { nowMs(): number; };
        readonly workerId: string;
        readonly diagnostics: ((event: ALWorkDiagnostics) => void) | undefined;
    }

    /** What a running batch has accumulated: its outcome counts and the two phases the handler itself times. */
    export interface Progress {
        claimedCount: number;
        completedCount: number;
        rescheduledCount: number;
        rejectedCount: number;
        /** The rows `expedite()` named that the batch claimed after its selection. */
        expeditedCount: number;
        runDurationMs: number;
        releaseDurationMs: number;
    }

    /** A batch once its selection is reserved, with the progress its end reads when the batch ends. */
    export interface Start {
        /** Source-process start before exhaustion, selection and claim. */
        readonly batchStartedAtMs: number;
        readonly selection: ALWorkReadySelection;
        /** The instant the run loop started, after the selection and the reservation. */
        readonly runStartedAtMs: number;
        readonly progress: Progress;
    }
}

/**
 * One batch's diagnostics: its start, stated once its selection is reserved and before its first claim runs, and
 * exactly one end for a batch that started. A batch that disposal stopped before its selection, or whose selection
 * threw, states neither.
 */
export class ALWorkBatchReport {
    private readonly dependencies: ALWorkBatchReport.Dependencies;
    private started: ALWorkBatchReport.Start | undefined;

    constructor(dependencies: ALWorkBatchReport.Dependencies) {
        this.dependencies = dependencies;
    }

    start(started: ALWorkBatchReport.Start): void {
        this.started = started;
        const { diagnostics, workerId } = this.dependencies;
        try {
            diagnostics?.({
                kind: 'work-batch-started',
                workerId,
                startedAtMs: started.runStartedAtMs,
                claimedCount: started.progress.claimedCount
            });
        }
        catch (error) {
            // Thrown here, it would strand the claims the batch reserved but has not run until their leases expire.
            console.error('ALM work batch start diagnostics failed', error);
        }
    }

    /** States the batch's end once; nothing for a batch that never started or already ended. */
    end(end: ALWorkBatchEndKind): void {
        const started = this.started;
        if (started === undefined) {
            return;
        }
        this.started = undefined;
        const { batchStartedAtMs, selection, runStartedAtMs, progress } = started;
        const { clock, workerId, diagnostics } = this.dependencies;
        diagnostics?.({
            kind: 'work-batch',
            batchStartedAtMs,
            workerId,
            durationMs: computeALWorkElapsedMs(batchStartedAtMs, clock.nowMs()),
            ...progress,
            selectionDurationMs: selection.selectionDurationMs,
            claimDurationMs: selection.claimDurationMs,
            queueWaitMs: computeALWorkQueueWaitMs(selection.earliestDueAtMs, batchStartedAtMs),
            startedAtMs: runStartedAtMs,
            end
        });
    }
}

/** A clock that steps backwards under a system time change must never report a negative phase. */
export function computeALWorkElapsedMs(startedAtMs: number, endedAtMs: number): number {
    return Math.max(0, endedAtMs - startedAtMs);
}

/** A batch that claimed nothing waited on nothing, so it reports no wait rather than a made-up one. */
function computeALWorkQueueWaitMs(
    earliestDueAtMs: number | undefined,
    batchStartedAtMs: number
): number {
    return earliestDueAtMs === undefined ? 0 : computeALWorkElapsedMs(earliestDueAtMs, batchStartedAtMs);
}
