/** How the manifest runner ended: it passed, failed, or still ran when the window closed and was stopped. */
export type GrowthRunnerOutcome = 'passed' | 'failed' | 'outlasted-window';

/** The workload's outcome, recorded by the run script when the window closes. */
export interface GrowthWorkload {
    readonly runner: GrowthRunnerOutcome;
    /** Null when the control server never started the distributed run. */
    readonly manifestStartedAtEpochMs: number | null;
    /** Null while the distributed run had not completed when the window closed. */
    readonly manifestCompletedAtEpochMs: number | null;
    /** The agents the manifest drives; the script registers one account for each. */
    readonly manifestAgents: number;
    /** The most events the manifest lets each page's test runtime retain. */
    readonly eventHistoryMaxEvents: number;
    /** The current group snapshots the script let each API process keep. */
    readonly groupCurrentSnapshotCacheMaxEntries: number;
    /** The API processes the script started; each one's heap samples are expected in `api-heap.jsonl`. */
    readonly apiProcesses: number;
    /** Every churn iteration the loop began, including one the drain bound stopped before it finished. */
    readonly churnStarted: number;
    readonly churnPassed: number;
    readonly churnFailedRunIds: readonly string[];
}

/**
 * The growth predicates pass most easily without traffic, so the verdict needs the workload: a recorded outcome, a
 * manifest that ran to a pass, no failed churn iteration and at least one that passed.
 */
export function computeGrowthWorkloadIssues(workload: GrowthWorkload | null): readonly string[] {
    if (workload === null) {
        return ['the run recorded no workload outcome'];
    }
    return [
        ...(workload.runner === 'passed' ? [] : [`the manifest runner ended ${workload.runner}, not passed`]),
        ...(workload.churnFailedRunIds.length === 0
            ? []
            : [`churn iterations failed: ${workload.churnFailedRunIds.join(', ')}`]),
        ...(workload.churnPassed > 0 ? [] : ['no churn iteration passed'])
    ];
}
