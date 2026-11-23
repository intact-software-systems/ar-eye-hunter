import { describe, expect, it } from 'vitest';

import {
    readWorkflowRunsEnvelope,
    toGithubArtifacts,
    toGithubWorkflowRunJobs,
    toGithubWorkflowRunsEndpoint
} from '../../../../scripts/github-actions/read-github-workflow-runs.mjs';

describe('GitHub workflow run reading', () => {
    it('asks for every page of the successful pull-request runs of a branch, as the evidence reuse does', () => {
        expect(toGithubWorkflowRunsEndpoint({
            repository: 'owner/name',
            workflowPath: '.github/workflows/branch-release-gate.yml',
            branch: 'feature/x',
            event: 'pull_request',
            status: 'success'
        })).toBe(
            '/repos/owner/name/actions/workflows/branch-release-gate.yml/runs' +
                '?branch=feature%2Fx&event=pull_request&status=success&per_page=100'
        );
    });

    it('leaves out the filters it is not given and asks for one page of a limited count', () => {
        expect(toGithubWorkflowRunsEndpoint({
            repository: 'owner/name',
            workflowPath: '.github/workflows/alm-conformance-observation.yml',
            limit: 30
        })).toBe('/repos/owner/name/actions/workflows/alm-conformance-observation.yml/runs?per_page=30');
    });

    it('reads the runs of every page', () => {
        const pages = [{ workflow_runs: [{ id: 1 }] }, { workflow_runs: [{ id: 2 }] }];

        expect(readWorkflowRunsEnvelope(JSON.stringify(pages))).toEqual([{ id: 1 }, { id: 2 }]);
        expect(readWorkflowRunsEnvelope(JSON.stringify(pages[0]))).toEqual([{ id: 1 }]);
        expect(() => readWorkflowRunsEnvelope('{}')).toThrow('workflow runs response must contain workflow_runs pages');
        expect(() => readWorkflowRunsEnvelope('not json')).toThrow('workflow runs response must contain JSON');
    });

    it('reads each job name, status and conclusion of every page', () => {
        const pages = [
            { jobs: [{ id: 7, name: 'ALM conformance observation (ws)', status: 'completed', conclusion: 'cancelled' }] },
            { jobs: [{ id: 8, name: 'ALM conformance observation (rtc)', status: 'in_progress', conclusion: null }] }
        ];

        expect(toGithubWorkflowRunJobs(JSON.stringify(pages))).toEqual([
            { name: 'ALM conformance observation (ws)', status: 'completed', conclusion: 'cancelled' },
            { name: 'ALM conformance observation (rtc)', status: 'in_progress', conclusion: null }
        ]);
        expect(() => toGithubWorkflowRunJobs('[{}]')).toThrow('workflow run jobs response must contain jobs pages');
    });

    it('reads the name of every artifact and whether it has expired', () => {
        const pages = [{
            artifacts: [
                { id: 1, name: 'alm-lane-result-ws-full-abc', expired: false },
                { id: 2, name: 'alm-lane-result-rtc-full-abc', expired: true }
            ]
        }];

        expect(toGithubArtifacts(JSON.stringify(pages))).toEqual([
            { name: 'alm-lane-result-ws-full-abc', expired: false },
            { name: 'alm-lane-result-rtc-full-abc', expired: true }
        ]);
    });
});
