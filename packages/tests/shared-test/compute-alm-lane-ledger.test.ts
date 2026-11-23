import { describe, expect, it } from 'vitest';

import type { AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    computeAlmLaneLedger,
    type AlmLaneFlakeCause
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-ledger.ts';
import type { AlmLaneObservedRun } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-run-reading.ts';

import { toFixtureGreenRun, toFixtureResult, toFixtureRunWithTwoAgentResult } from './alm-lane-ledger-fixture.ts';

const twoAgentFailedA = toFixtureResult('ws', 'two-agent', new Map([['a', 'failed'], ['b', 'passed']]));

function toLedger(runs: readonly AlmLaneObservedRun[], causes: readonly AlmLaneFlakeCause[] = []) {
    return computeAlmLaneLedger({ runs, causes });
}

function toCarrierStreak(
    runs: readonly AlmLaneObservedRun[],
    causes: readonly AlmLaneFlakeCause[] = [],
    carrier: AlmConformanceCarrier = 'ws'
) {
    return toLedger(runs, causes).carriers.find((streak) => streak.carrier === carrier);
}

function toCause(key: string, fixedByPullRequest: number | null = null): AlmLaneFlakeCause {
    return { key, cause: 'A settle window raced the relay.', fixedByPullRequest };
}

describe('computeAlmLaneLedger', () => {
    it('counts the green push runs before the newest red one, names that red run, and counts the runs read', () => {
        const red = toFixtureRunWithTwoAgentResult(4, twoAgentFailedA);

        const streak = toCarrierStreak([toFixtureGreenRun(1), toFixtureGreenRun(2), toFixtureGreenRun(3), red, toFixtureGreenRun(5)]);

        expect(streak).toEqual({
            carrier: 'ws',
            streak: 3,
            runsRead: 5,
            lastRed: {
                runId: 4,
                commitSha: 'sha-4',
                attempt: 1,
                jobConclusion: 'failure',
                planRead: true,
                reason: null,
                failed: ['ws/two-agent/a'],
                notRun: []
            },
            unattributed: [],
            uncaused: ['ws/two-agent/a']
        });
    });

    it('reads every carrier, with no counted run as a streak of zero from zero runs', () => {
        expect(toLedger([toFixtureGreenRun(1)]).carriers.map(({ carrier, streak, runsRead }) => ({ carrier, streak, runsRead })))
            .toEqual([
                { carrier: 'ws', streak: 1, runsRead: 1 },
                { carrier: 'rtc', streak: 0, runsRead: 0 },
                { carrier: 'rtc-with-ws-fallback', streak: 0, runsRead: 0 }
            ]);
    });

    it('keeps a streak per carrier', () => {
        const rtcRed: AlmLaneObservedRun = { ...toFixtureGreenRun(2, 'rtc'), jobConclusion: 'failure', plan: null };

        const ledger = toLedger([toFixtureGreenRun(1, 'ws'), rtcRed, toFixtureGreenRun(3, 'rtc'), toFixtureGreenRun(4, 'ws')]);

        expect(ledger.carriers.map((streak) => streak.streak)).toEqual([2, 0, 0]);
    });

    it('lists each carrier its own red runs with nothing to attribute, with their reason', () => {
        const wsDead: AlmLaneObservedRun = { ...toFixtureGreenRun(1, 'ws'), jobConclusion: 'failure', plan: null };
        const rtcDead: AlmLaneObservedRun = { ...toFixtureGreenRun(1, 'rtc'), jobConclusion: 'failure', plan: null };
        const wsRerun: AlmLaneObservedRun = { ...toFixtureGreenRun(2, 'ws'), attempt: 2 };

        const ledger = toLedger([wsRerun, wsDead, rtcDead]);

        expect(ledger.carriers.map(({ carrier, unattributed }) => ({ carrier, unattributed }))).toEqual([
            {
                carrier: 'ws',
                unattributed: [
                    { runId: 2, commitSha: 'sha-2', reason: 'rerun' },
                    { runId: 1, commitSha: 'sha-1', reason: 'no-plan' }
                ]
            },
            { carrier: 'rtc', unattributed: [{ runId: 1, commitSha: 'sha-1', reason: 'no-plan' }] },
            { carrier: 'rtc-with-ws-fallback', unattributed: [] }
        ]);
        expect(ledger.carriers[0]?.lastRed).toMatchObject({ runId: 2, attempt: 2, reason: 'rerun', planRead: true });
    });

    it('counts a red run with nothing to attribute as a failure without a cause until its run key has a cause', () => {
        const dead: AlmLaneObservedRun = { ...toFixtureGreenRun(7), jobConclusion: 'failure', plan: null };

        expect(toCarrierStreak([dead])?.uncaused).toEqual(['ws/run/7']);
        expect(toCarrierStreak([dead], [toCause('ws/run/7')])?.uncaused).toEqual([]);
    });

    it('counts every failed key without a cause, and none that has one', () => {
        const failedBoth = toFixtureResult('ws', 'two-agent', new Map([['a', 'failed'], ['b', 'failed']]));

        expect(toCarrierStreak([toFixtureRunWithTwoAgentResult(1, failedBoth)], [toCause('ws/two-agent/a')])?.uncaused)
            .toEqual(['ws/two-agent/b']);
    });

    it('never counts an unrun scenario by itself: a cut-off family counts its family key once', () => {
        const cutOff = toFixtureResult('ws', 'two-agent', new Map([['a', 'passed']]), 'not-finished');
        const runs = [toFixtureRunWithTwoAgentResult(2, cutOff), toFixtureRunWithTwoAgentResult(1, cutOff)];

        expect(toCarrierStreak(runs)?.uncaused).toEqual(['ws/two-agent']);
        expect(toCarrierStreak(runs, [toCause('ws/two-agent')])?.uncaused).toEqual([]);
    });

    it('counts a failed key and a never-started family, not the unrun keys after the failure', () => {
        const failedThenUnrun = toFixtureResult('ws', 'two-agent', new Map([['a', 'failed']]), 'failed');
        const run: AlmLaneObservedRun = {
            ...toFixtureRunWithTwoAgentResult(1, failedThenUnrun),
            familyResults: [failedThenUnrun]
        };

        expect(toCarrierStreak([run])?.uncaused).toEqual(['ws/three-agent', 'ws/two-agent/a']);
        expect(toCarrierStreak([run], [toCause('ws/two-agent/a')])?.uncaused).toEqual(['ws/three-agent']);
    });

    it('counts failures without a cause from push runs only', () => {
        const pullRequest: AlmLaneObservedRun = { ...toFixtureRunWithTwoAgentResult(2, twoAgentFailedA), event: 'pull_request' };

        expect(toCarrierStreak([pullRequest, toFixtureGreenRun(1)])?.uncaused).toEqual([]);
    });

    it('changes nothing for a cause whose key never failed', () => {
        const runs = [toFixtureRunWithTwoAgentResult(1, twoAgentFailedA), toFixtureGreenRun(2)];

        expect(toLedger(runs, [toCause('rtc/two-agent/a', 1)])).toEqual(toLedger(runs));
    });

    it.each(['in-progress', 'skipped'] as const)('leaves out a %s job without breaking the streak, and lists it', (jobConclusion) => {
        const ledger = toLedger([{ ...toFixtureGreenRun(1), jobConclusion, plan: null }, toFixtureGreenRun(2)]);

        expect(ledger.carriers[0]).toMatchObject({ streak: 1, runsRead: 1, lastRed: null, unattributed: [] });
        expect(ledger.sideRuns).toEqual([]);
        expect(ledger.leftOutRuns).toEqual([{ runId: 1, event: 'push', carrier: 'ws', jobConclusion }]);
    });

    it('reads a cancelled push job as red', () => {
        const ledger = toLedger([{ ...toFixtureGreenRun(1), jobConclusion: 'cancelled', plan: null }, toFixtureGreenRun(2)]);

        expect(ledger.carriers[0]).toMatchObject({ streak: 0, unattributed: [{ runId: 1, commitSha: 'sha-1', reason: 'cancelled' }] });
    });

    it('reads a cancelled dispatched job as red beside the streak', () => {
        const ledger = toLedger([{ ...toFixtureGreenRun(1), event: 'workflow_dispatch', jobConclusion: 'cancelled', plan: null }]);

        expect(ledger.sideRuns).toEqual([{ runId: 1, event: 'workflow_dispatch', carrier: 'ws', green: false }]);
        expect(ledger.leftOutRuns).toEqual([]);
    });

    it('leaves out a cancelled pull-request job, and lists it', () => {
        const ledger = toLedger([{ ...toFixtureGreenRun(1), event: 'pull_request', jobConclusion: 'cancelled', plan: null }]);

        expect(ledger.sideRuns).toEqual([]);
        expect(ledger.leftOutRuns).toEqual([{ runId: 1, event: 'pull_request', carrier: 'ws', jobConclusion: 'cancelled' }]);
    });

    it('shows pull-request and dispatched runs only beside the streak', () => {
        const pullRequest: AlmLaneObservedRun = { ...toFixtureRunWithTwoAgentResult(2, twoAgentFailedA), event: 'pull_request' };
        const dispatched: AlmLaneObservedRun = { ...toFixtureGreenRun(3, 'rtc'), event: 'workflow_dispatch' };

        const ledger = toLedger([pullRequest, dispatched, toFixtureGreenRun(1)]);

        expect(ledger.sideRuns).toEqual([
            { runId: 2, event: 'pull_request', carrier: 'ws', green: false },
            { runId: 3, event: 'workflow_dispatch', carrier: 'rtc', green: true }
        ]);
        expect(ledger.carriers.map((streak) => streak.streak)).toEqual([1, 0, 0]);
        expect(ledger.keys).toEqual([]);
    });

    it('collects each key across the push runs that failed it or did not run it, with its cause entry', () => {
        const failedThenUnrun = toFixtureResult('ws', 'two-agent', new Map([['a', 'failed']]), 'failed');
        const cause = toCause('ws/two-agent/a', 851);

        const ledger = toLedger([
            toFixtureRunWithTwoAgentResult(3, failedThenUnrun),
            toFixtureGreenRun(2),
            toFixtureRunWithTwoAgentResult(1, twoAgentFailedA)
        ], [cause]);

        expect(ledger.keys).toEqual([
            { key: 'ws/two-agent/a', failedRunIds: [3, 1], notRunRunIds: [], cause },
            { key: 'ws/two-agent/b', failedRunIds: [], notRunRunIds: [3], cause: null }
        ]);
    });
});
