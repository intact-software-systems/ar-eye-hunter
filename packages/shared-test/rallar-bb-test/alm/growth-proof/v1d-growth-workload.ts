/** How the manifest runner ended: it passed, failed, or still ran when the window closed and was stopped. */
export type V1dGrowthRunnerOutcome = 'passed' | 'failed' | 'outlasted-window';

/** The workload's outcome, recorded by the run script when the window closes. */
export interface V1dGrowthWorkload {
    readonly runner: V1dGrowthRunnerOutcome;
    /** Null when the control server never started the distributed run. */
    readonly manifestStartedAtEpochMs: number | null;
    /** Null while the distributed run had not completed when the window closed. */
    readonly manifestCompletedAtEpochMs: number | null;
    /** The agents the manifest drives; the script registers one account for each. */
    readonly manifestAgents: number;
    /** The most events the manifest lets each page's test runtime retain. */
    readonly eventHistoryMaxEvents: number;
    /** Every churn iteration the loop began, including one the drain bound stopped before it finished. */
    readonly churnStarted: number;
    readonly churnPassed: number;
    readonly churnFailedRunIds: readonly string[];
}

/**
 * The growth predicates pass most easily without traffic, so the verdict needs the workload: a recorded outcome, a
 * manifest that ran to a pass, no failed churn iteration and at least one that passed.
 */
export function computeV1dGrowthWorkloadIssues(workload: V1dGrowthWorkload | null): readonly string[] {
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
