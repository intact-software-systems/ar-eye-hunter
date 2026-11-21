import { describe, expect, it } from 'vitest';

import type { AlmLaneLedger } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-ledger.ts';
import { toAlmLaneLedgerText } from '@shared-test/rallar-bb-test/conformance/alm/ledger/to-alm-lane-ledger-text.ts';

const ledger: AlmLaneLedger = {
    carriers: [
        {
            carrier: 'ws',
            streak: 1,
            lastRed: {
                runId: 2,
                commitSha: '2222222aaaaaaa',
                failed: ['ws/two-agent/a'],
                notRun: ['ws/three-agent/c']
            },
            uncaused: ['ws/three-agent/c']
        },
        { carrier: 'rtc', streak: 0, lastRed: { runId: 5, commitSha: '5555555bbbbbbb', failed: [], notRun: [] }, uncaused: [] },
        { carrier: 'rtc-with-ws-fallback', streak: 0, lastRed: null, uncaused: [] }
    ],
    scenarios: [
        { scenario: 'ws/three-agent/c', failedRunIds: [], notRunRunIds: [2], hasCause: false },
        { scenario: 'ws/two-agent/a', failedRunIds: [2, 1], notRunRunIds: [], hasCause: true }
    ],
    unattributedRedRunIds: [5],
    sideRuns: [
        { runId: 9, event: 'pull_request', carrier: 'ws', green: false },
        { runId: 10, event: 'workflow_dispatch', carrier: 'rtc-with-ws-fallback', green: true }
    ]
};

describe('toAlmLaneLedgerText', () => {
    it('prints the streaks, the scenario table, the unattributed and side runs, and the issues', () => {
        const text = toAlmLaneLedgerText({
            ledger,
            commitShas: ['9999999ccccccc', '5555555bbbbbbb', '1111111ddddddd'],
            issues: ['run 9 ws: ws-full-plan.json is not JSON.']
        });

        expect(text.split('\n')).toEqual([
            'ALM lane ledger: 3 workflow runs read, newest commit 9999999, oldest commit 1111111.',
            '',
            'Streak of green main-push runs, per carrier:',
            'ws: streak 1/10',
            '  last red: run 2 at 2222222',
            '    failed:',
            '      ws/two-agent/a',
            '    not run:',
            '      ws/three-agent/c',
            '  failures without a cause: 1',
            'rtc: streak 0/10',
            '  last red: run 5 at 5555555',
            '    failed: none',
            '    not run: none',
            '  failures without a cause: 0',
            'rtc-with-ws-fallback: streak 0/10',
            '  failures without a cause: 0',
            '',
            'Scenarios failed or not run in main-push runs:',
            '  scenario          failed in  not run in  cause',
            '  ws/three-agent/c  -          2           no',
            '  ws/two-agent/a    2, 1       -           yes',
            '',
            'Red main-push runs with nothing to attribute:',
            '  run 5',
            '',
            'Pull-request and dispatched runs:',
            '  run  event              carrier               result',
            '  9    pull_request       ws                    red',
            '  10   workflow_dispatch  rtc-with-ws-fallback  green',
            '',
            'Issues met while reading:',
            '  run 9 ws: ws-full-plan.json is not JSON.',
            ''
        ]);
    });

    it('prints one line for each empty section', () => {
        const empty: AlmLaneLedger = {
            carriers: [{ carrier: 'ws', streak: 0, lastRed: null, uncaused: [] }],
            scenarios: [],
            unattributedRedRunIds: [],
            sideRuns: []
        };

        expect(toAlmLaneLedgerText({ ledger: empty, commitShas: [], issues: [] }).split('\n')).toEqual([
            'ALM lane ledger: 0 workflow runs read.',
            '',
            'Streak of green main-push runs, per carrier:',
            'ws: streak 0/10',
            '  failures without a cause: 0',
            '',
            'Scenarios failed or not run in main-push runs: none.',
            '',
            'Red main-push runs with nothing to attribute: none.',
            '',
            'Pull-request and dispatched runs: none.',
            '',
            'Issues met while reading: none.',
            ''
        ]);
    });

    it('prints at most ten keys of a list, then how many more there are', () => {
        const failed = Array.from({ length: 12 }, (_, index) => `ws/two-agent/s${String(index).padStart(2, '0')}`);
        const red: AlmLaneLedger = {
            ...ledger,
            carriers: [{ carrier: 'ws', streak: 0, lastRed: { runId: 3, commitSha: '3333333', failed, notRun: [] }, uncaused: failed }]
        };

        const lines = toAlmLaneLedgerText({ ledger: red, commitShas: ['3333333'], issues: [] }).split('\n');

        expect(lines.slice(3, 19)).toEqual([
            'ws: streak 0/10',
            '  last red: run 3 at 3333333',
            '    failed:',
            ...failed.slice(0, 10).map((key) => `      ${key}`),
            '      and 2 more',
            '    not run: none',
            '  failures without a cause: 12'
        ]);
    });
});
