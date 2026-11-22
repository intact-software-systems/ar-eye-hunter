import { describe, expect, it } from 'vitest';

import { computeAlmLaneWorkflowRuns } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-workflow-runs.ts';

function toRun(id: number, runNumber: number, event: string, conclusion: string | null = 'success') {
    return { id, run_number: runNumber, event, head_sha: `sha-${id}`, conclusion };
}

describe('computeAlmLaneWorkflowRuns', () => {
    it('merges the push, pull-request and dispatched runs newest first, and counts each kind', () => {
        const computed = computeAlmLaneWorkflowRuns({
            push: [toRun(30, 12, 'push'), toRun(10, 4, 'push')],
            pullRequest: [toRun(40, 15, 'pull_request'), toRun(20, 9, 'pull_request')],
            dispatch: [toRun(25, 11, 'workflow_dispatch')]
        });

        expect(computed.runs.map((run) => run.id)).toEqual([40, 30, 25, 20, 10]);
        expect(computed.window.counts).toEqual({ push: 2, pullRequest: 2, dispatch: 1 });
    });

    it('states the main push window by its own newest and oldest commit', () => {
        const computed = computeAlmLaneWorkflowRuns({
            push: [toRun(30, 12, 'push'), toRun(10, 4, 'push')],
            pullRequest: [toRun(40, 15, 'pull_request'), toRun(5, 1, 'pull_request')],
            dispatch: []
        });

        expect(computed.window).toMatchObject({ newestPushCommitSha: 'sha-30', oldestPushCommitSha: 'sha-10' });
        expect(computeAlmLaneWorkflowRuns({ push: [], pullRequest: [], dispatch: [] }).window)
            .toMatchObject({ newestPushCommitSha: null, oldestPushCommitSha: null });
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

    it('asks for the jobs and artifacts of every run but the skipped ones', () => {
        const computed = computeAlmLaneWorkflowRuns({
            push: [toRun(3, 3, 'push', null)],
            pullRequest: [toRun(2, 2, 'pull_request', 'skipped'), toRun(1, 1, 'pull_request', 'cancelled')],
            dispatch: []
        });

        expect(computed.runsToRead.map((run) => run.id)).toEqual([3, 1]);
    });
});
