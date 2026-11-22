import { describe, expect, it } from 'vitest';

import { computeAlmLaneWorkflowRuns } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-workflow-runs.ts';

function toRun(id: number, runNumber: number, event: string) {
    return { id, run_number: runNumber, event };
}

describe('computeAlmLaneWorkflowRuns', () => {
    it('merges the push, pull-request and dispatched runs newest first and counts each kind', () => {
        const computed = computeAlmLaneWorkflowRuns({
            push: [toRun(30, 12, 'push'), toRun(10, 4, 'push')],
            pullRequest: [toRun(40, 15, 'pull_request'), toRun(20, 9, 'pull_request')],
            dispatch: [toRun(25, 11, 'workflow_dispatch')]
        });

        expect(computed.runs.map((run) => run.id)).toEqual([40, 30, 25, 20, 10]);
        expect(computed.counts).toEqual({ push: 2, pullRequest: 2, dispatch: 1 });
    });

    it('reads a run listed twice once', () => {
        const run = toRun(30, 12, 'push');

        expect(computeAlmLaneWorkflowRuns({ push: [run], pullRequest: [run], dispatch: [] }).runs).toEqual([run]);
    });

    it('keeps every push run however many pull-request runs there are', () => {
        const pullRequests = Array.from({ length: 100 }, (_, index) => toRun(1000 + index, 1000 + index, 'pull_request'));
        const pushes = Array.from({ length: 10 }, (_, index) => toRun(index, index, 'push'));

        const computed = computeAlmLaneWorkflowRuns({ push: pushes, pullRequest: pullRequests, dispatch: [] });

        expect(computed.runs.filter((run) => run.event === 'push')).toHaveLength(10);
        expect(computed.runs).toHaveLength(110);
    });
});
