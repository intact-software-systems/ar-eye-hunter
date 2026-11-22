/** The fields of a GitHub workflow run that order and select it. */
export interface AlmLaneListedWorkflowRun {
    readonly id: number;
    readonly run_number: number;
    readonly head_sha: string;
    /** Null while the run is in progress. */
    readonly conclusion: string | null;
}

export interface AlmLaneWorkflowRunCounts {
    readonly push: number;
    readonly pullRequest: number;
    readonly dispatch: number;
}

/** What was read: how many runs of each kind, and the main push runs' own newest and oldest commit. */
export interface AlmLaneWorkflowRunWindow {
    readonly counts: AlmLaneWorkflowRunCounts;
    /** Null when no main push run was read. */
    readonly newestPushCommitSha: string | null;
    readonly oldestPushCommitSha: string | null;
}

/** Each kind is read on its own, so pull-request traffic cannot push the streak's push runs out of the window. */
export interface ComputeAlmLaneWorkflowRunsInput<T extends AlmLaneListedWorkflowRun> {
    /** Newest first. */
    readonly push: readonly T[];
    readonly pullRequest: readonly T[];
    readonly dispatch: readonly T[];
}

export interface AlmLaneWorkflowRunsComputed<T extends AlmLaneListedWorkflowRun> {
    /** Newest first, each run once. */
    readonly runs: readonly T[];
    /** The runs whose jobs and artifacts are worth asking for: a skipped run has none. */
    readonly runsToRead: readonly T[];
    readonly window: AlmLaneWorkflowRunWindow;
}

export function computeAlmLaneWorkflowRuns<T extends AlmLaneListedWorkflowRun>(
    input: ComputeAlmLaneWorkflowRunsInput<T>
): AlmLaneWorkflowRunsComputed<T> {
    const merged = [...input.push, ...input.pullRequest, ...input.dispatch];
    const runs = merged.filter((run, index) => merged.findIndex((other) => other.id === run.id) === index)
        .sort((left, right) => right.run_number - left.run_number || right.id - left.id);
    return {
        runs,
        runsToRead: runs.filter((run) => run.conclusion !== 'skipped'),
        window: {
            counts: { push: input.push.length, pullRequest: input.pullRequest.length, dispatch: input.dispatch.length },
            newestPushCommitSha: input.push[0]?.head_sha ?? null,
            oldestPushCommitSha: input.push.at(-1)?.head_sha ?? null
        }
    };
}
