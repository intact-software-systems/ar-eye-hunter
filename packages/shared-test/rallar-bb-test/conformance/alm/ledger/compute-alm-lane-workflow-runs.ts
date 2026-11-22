/** The fields of a GitHub workflow run that order it: its id, and its number within the workflow. */
export interface AlmLaneWorkflowRunOrder {
    readonly id: number;
    readonly run_number: number;
}

export interface AlmLaneWorkflowRunCounts {
    readonly push: number;
    readonly pullRequest: number;
    readonly dispatch: number;
}

/** Each kind is read on its own, so pull-request traffic cannot push the streak's push runs out of the window. */
export interface ComputeAlmLaneWorkflowRunsInput<T extends AlmLaneWorkflowRunOrder> {
    readonly push: readonly T[];
    readonly pullRequest: readonly T[];
    readonly dispatch: readonly T[];
}

export interface AlmLaneWorkflowRunsComputed<T extends AlmLaneWorkflowRunOrder> {
    /** Newest first, each run once. */
    readonly runs: readonly T[];
    readonly counts: AlmLaneWorkflowRunCounts;
}

export function computeAlmLaneWorkflowRuns<T extends AlmLaneWorkflowRunOrder>(
    input: ComputeAlmLaneWorkflowRunsInput<T>
): AlmLaneWorkflowRunsComputed<T> {
    const merged = [...input.push, ...input.pullRequest, ...input.dispatch];
    const runs = merged.filter((run, index) => merged.findIndex((other) => other.id === run.id) === index)
        .sort((left, right) => right.run_number - left.run_number || right.id - left.id);
    return {
        runs,
        counts: { push: input.push.length, pullRequest: input.pullRequest.length, dispatch: input.dispatch.length }
    };
}
