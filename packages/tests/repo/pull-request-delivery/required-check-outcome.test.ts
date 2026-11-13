import {
    describe,
    expect,
    it
} from 'vitest';

import { readPullRequest } from '../../../../scripts/pull-request-delivery/read-pull-request.mjs';

interface RequiredCheck {
    readonly __typename: 'CheckRun';
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly startedAt: string | null;
}

describe('handoff check acceptance', () => {
    it.each([
        ['SUCCESS', 'PASSING'],
        ['FAILURE', 'FAILING'],
        ['CANCELLED', 'FAILING'],
        ['SKIPPED', 'FAILING'],
        ['NEUTRAL', 'FAILING'],
        ['UNRECOGNIZED', 'FAILING'],
        ['', 'PENDING'],
        [null, 'PENDING']
    ])('interprets a completed %s release result as %s', (conclusion, expected) => {
        expect(readChecks([{
            __typename: 'CheckRun',
            name: 'Branch Release Gate result',
            status: 'COMPLETED',
            conclusion,
            startedAt: '2026-11-13T10:00:00Z'
        }])).toBe(expected);
    });

    it('waits for the current revision when it has no required result', () => {
        expect(readChecks([])).toBe('PENDING');
    });

    it('waits for a newer handoff result instead of accepting an older successful result', () => {
        expect(readChecks([
            {
                __typename: 'CheckRun',
                name: 'Branch Release Gate result',
                status: 'IN_PROGRESS',
                conclusion: null,
                startedAt: '2026-11-13T11:00:00Z'
            },
            {
                __typename: 'CheckRun',
                name: 'Branch Release Gate result',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                startedAt: '2026-11-13T10:00:00Z'
            }
        ])).toBe('PENDING');
    });

    it('waits for a queued handoff without a start time instead of accepting an older result', () => {
        expect(readChecks([
            {
                __typename: 'CheckRun',
                name: 'Branch Release Gate result',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                startedAt: '2026-11-13T10:00:00Z'
            },
            {
                __typename: 'CheckRun',
                name: 'Branch Release Gate result',
                status: 'QUEUED',
                conclusion: null,
                startedAt: null
            }
        ])).toBe('PENDING');
    });
});

function readChecks(checks: readonly RequiredCheck[]): string {
    const pullRequest = readPullRequest({
        defaultBranch: 'main',
        execFile: (command: string, arguments_: readonly string[]) => {
            if (command !== 'gh' || arguments_[0] !== 'pr' || arguments_[1] !== 'view') {
                throw new Error('Only the current PR read is expected');
            }
            return JSON.stringify({
                number: 42,
                url: 'https://github.com/example/repository/pull/42',
                state: 'OPEN',
                mergedAt: null,
                isDraft: false,
                baseRefName: 'main',
                mergeable: 'MERGEABLE',
                mergeStateStatus: 'BLOCKED',
                statusCheckRollup: checks,
                reviewDecision: 'REVIEW_REQUIRED',
                autoMergeRequest: null
            });
        }
    });
    if (pullRequest === undefined) {
        throw new Error('The current pull request must be available');
    }
    return pullRequest.checks;
}
