import { describe, expect, it } from 'vitest';

import type { AlmLaneLedger } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-ledger.ts';
import type { AlmLaneWorkflowRunWindow } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-workflow-runs.ts';
import { toAlmLaneLedgerText } from '@shared-test/rallar-bb-test/conformance/alm/ledger/to-alm-lane-ledger-text.ts';

const ledger: AlmLaneLedger = {
    carriers: [
        {
            carrier: 'ws',
            streak: 1,
            runsRead: 3,
            lastRed: {
                runId: 2,
                commitSha: '2222222aaaaaaa',
                attempt: 1,
                jobConclusion: 'failure',
                planRead: true,
                reason: null,
                failed: ['ws/two-agent/a'],
                notRun: ['ws/three-agent/c']
            },
            unattributed: [],
            uncaused: ['ws/three-agent']
        },
        {
            carrier: 'rtc',
            streak: 0,
            runsRead: 1,
            lastRed: {
                runId: 5,
                commitSha: '5555555bbbbbbb',
                attempt: 2,
                jobConclusion: 'success',
                planRead: false,
                reason: 'rerun',
                failed: [],
                notRun: []
            },
            unattributed: [{ runId: 5, commitSha: '5555555bbbbbbb', reason: 'rerun' }],
            uncaused: ['rtc/run/5']
        },
        { carrier: 'rtc-with-ws-fallback', streak: 0, runsRead: 0, lastRed: null, unattributed: [], uncaused: [] }
    ],
    keys: [
        { key: 'ws/three-agent/c', failedRunIds: [], notRunRunIds: [2], cause: null },
        {
            key: 'ws/two-agent/a',
            failedRunIds: [2, 1],
            notRunRunIds: [],
            cause: { key: 'ws/two-agent/a', cause: 'Known.', fixedByPullRequest: 851 }
        },
        {
            key: 'ws/two-agent/b',
            failedRunIds: [1],
            notRunRunIds: [],
            cause: { key: 'ws/two-agent/b', cause: 'Open.', fixedByPullRequest: null }
        }
    ],
    sideRuns: [
        { runId: 9, event: 'pull_request', carrier: 'ws', green: false },
        { runId: 10, event: 'workflow_dispatch', carrier: 'rtc-with-ws-fallback', green: true }
    ],
    leftOutRuns: [
        { runId: 11, event: 'pull_request', carrier: 'rtc', jobConclusion: 'in-progress' },
        { runId: 11, event: 'pull_request', carrier: 'ws', jobConclusion: 'cancelled' }
    ]
};

const window: AlmLaneWorkflowRunWindow = {
    counts: { push: 2, pullRequest: 1, dispatch: 0 },
    newestPushCommitSha: '9999999ccccccc',
    oldestPushCommitSha: '1111111ddddddd'
};

const noRuns: AlmLaneWorkflowRunWindow = {
    counts: { push: 0, pullRequest: 0, dispatch: 0 },
    newestPushCommitSha: null,
    oldestPushCommitSha: null
};

describe('toAlmLaneLedgerText', () => {
    it('prints the window, each carrier, the key table, the side and left-out runs, and the issues', () => {
        const text = toAlmLaneLedgerText({ ledger, window, issues: ['run 9 ws: ws-full-plan.json is not JSON.'] });

        expect(text.split('\n')).toEqual([
            'ALM lane ledger: read 2 main push, 1 pull-request and 0 dispatched runs; main push runs from 9999999' +
            ' (newest) to 1111111 (oldest).',
            '',
            'Streak of green main-push runs, per carrier:',
            'ws: streak 1/10 of 3 runs read',
            '  last red: run 2 at 2222222, attempt 1, job failure, plan read',
            '    failed:',
            '      ws/two-agent/a',
            '    not run:',
            '      ws/three-agent/c',
            '  red runs with nothing to attribute: none',
            '  failures without a cause: 1',
            'rtc: streak 0/10 of 1 run read',
            '  last red: run 5 at 5555555, attempt 2, job success, no plan read, nothing to attribute: rerun',
            '    failed: none',
            '    not run: none',
            '  red runs with nothing to attribute:',
            '    run 5 at 5555555: rerun',
            '  failures without a cause: 1',
            'rtc-with-ws-fallback: streak 0/10 of 0 runs read',
            '  red runs with nothing to attribute: none',
            '  failures without a cause: 0',
            '',
            'Keys failed or not run in main-push runs:',
            '  key               failed in  not run in  cause',
            '  ws/three-agent/c  -          2           none',
            '  ws/two-agent/a    2, 1       -           #851',
            '  ws/two-agent/b    1          -           open',
            '',
            'Pull-request and dispatched runs:',
            '  run  event              carrier               result',
            '  9    pull_request       ws                    red',
            '  10   workflow_dispatch  rtc-with-ws-fallback  green',
            '',
            'Jobs left out (running, skipped, or a cancelled pull-request job):',
            '  run  event         carrier  job',
            '  11   pull_request  rtc      in-progress',
            '  11   pull_request  ws       cancelled',
            '',
            'Issues met while reading:',
            '  run 9 ws: ws-full-plan.json is not JSON.',
            ''
        ]);
    });

    it('prints one line for each empty section, and a header with no main push run', () => {
        const empty: AlmLaneLedger = {
            carriers: [{ carrier: 'ws', streak: 0, runsRead: 0, lastRed: null, unattributed: [], uncaused: [] }],
            keys: [],
            sideRuns: [],
            leftOutRuns: []
        };

        expect(toAlmLaneLedgerText({ ledger: empty, window: noRuns, issues: [] }).split('\n')).toEqual([
            'ALM lane ledger: read 0 main push, 0 pull-request and 0 dispatched runs; no main push run read.',
            '',
            'Streak of green main-push runs, per carrier:',
            'ws: streak 0/10 of 0 runs read',
            '  red runs with nothing to attribute: none',
            '  failures without a cause: 0',
            '',
            'Keys failed or not run in main-push runs: none.',
            '',
            'Pull-request and dispatched runs: none.',
            '',
            'Jobs left out (running, skipped, or a cancelled pull-request job): none.',
            '',
            'Issues met while reading: none.',
            ''
        ]);
    });

    it('prints at most ten keys of a list, then how many more there are', () => {
        const failed = Array.from({ length: 12 }, (_, index) => `ws/two-agent/s${String(index).padStart(2, '0')}`);
        const red: AlmLaneLedger = {
            ...ledger,
            carriers: [{
                carrier: 'ws',
                streak: 0,
                runsRead: 1,
                lastRed: {
                    runId: 3,
                    commitSha: '3333333',
                    attempt: 1,
                    jobConclusion: 'failure',
                    planRead: true,
                    reason: null,
                    failed,
                    notRun: []
                },
                unattributed: [],
                uncaused: failed
            }]
        };

        const lines = toAlmLaneLedgerText({ ledger: red, window, issues: [] }).split('\n');

        expect(lines.slice(3, 20)).toEqual([
            'ws: streak 0/10 of 1 run read',
            '  last red: run 3 at 3333333, attempt 1, job failure, plan read',
            '    failed:',
            ...failed.slice(0, 10).map((key) => `      ${key}`),
            '      and 2 more',
            '    not run: none',
            '  red runs with nothing to attribute: none',
            '  failures without a cause: 12'
        ]);
    });

    it('prints at most ten issues, then how many more there are', () => {
        const issues = Array.from({ length: 13 }, (_, index) => `issue ${index}`);

        const lines = toAlmLaneLedgerText({ ledger, window, issues }).split('\n');

        expect(lines.slice(lines.indexOf('Issues met while reading:'))).toEqual([
            'Issues met while reading:',
            ...issues.slice(0, 10).map((issue) => `  ${issue}`),
            '  and 3 more',
            ''
        ]);
    });
});
