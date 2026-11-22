import { describe, expect, it } from 'vitest';

import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    toAlmLaneFamilyResult,
    type AlmLaneFamilyResult,
    type AlmLanePlanRecord
} from '@shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';
import { computeAlmLaneLedger } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-ledger.ts';
import { computeAlmLaneRunReading } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-run-reading.ts';
import type { AlmLaneResultFile } from '@shared-test/rallar-bb-test/conformance/alm/ledger/decode-alm-lane-result-file.ts';
import type { AlmLaneReportedJob } from '@shared-test/rallar-bb-test/conformance/alm/ledger/to-alm-lane-job-conclusion.ts';
import {
    resolveAlmLaneResultArtifacts,
    toAlmLaneObservedRuns,
    type AlmLaneResultArtifact,
    type ToAlmLaneObservedRunsInput
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/to-alm-lane-observed-runs.ts';

import { toFixturePlan, toFixtureResult } from './alm-lane-ledger-fixture.ts';

function toPlan(carrier: AlmConformanceCarrier, scope: 'full' | 'smoke' = 'full'): AlmLanePlanRecord {
    return { carrier, scope, backend: 'postgres', families: [{ family: 'two-agent', scenarioKeys: ['a'] }] };
}

function toResult(carrier: AlmConformanceCarrier, scope: 'full' | 'smoke' = 'full'): AlmLaneFamilyResult {
    return toAlmLaneFamilyResult({
        identity: { carrier, scope, backend: 'postgres' },
        family: 'two-agent',
        scenarioKeys: ['a'],
        settled: new Map([['a', 'passed']]),
        familyOutcome: 'passed'
    });
}

function toFile(fileName: string, value: object): AlmLaneResultFile {
    return { fileName, text: JSON.stringify(value) };
}

function toLaneJob(carrier: string, conclusion: string | null = 'success'): AlmLaneReportedJob {
    return { name: `ALM conformance observation (${carrier})`, status: 'completed', conclusion };
}

function toArtifact(carrier: AlmConformanceCarrier, files: readonly AlmLaneResultFile[]): AlmLaneResultArtifact {
    return { name: `alm-lane-result-${carrier}-full-merge-sha`, expired: false, files };
}

const wsArtifact = toArtifact('ws', [
    toFile('ws-full-plan.json', toPlan('ws')),
    toFile('ws-full-two-agent.json', toResult('ws'))
]);

function toInput(overrides: Partial<ToAlmLaneObservedRunsInput>): ToAlmLaneObservedRunsInput {
    return {
        runId: 7,
        commitSha: 'abcdef1234567',
        event: 'pull_request',
        attempt: 1,
        status: 'completed',
        conclusion: 'success',
        jobs: [toLaneJob('ws')],
        artifacts: [wsArtifact],
        ...overrides
    };
}

describe('toAlmLaneObservedRuns', () => {
    it('reads one lane job with its plan and family results, taking the carrier from the job name', () => {
        expect(toAlmLaneObservedRuns(toInput({}))).toEqual({
            runs: [{
                runId: 7,
                commitSha: 'abcdef1234567',
                event: 'pull_request',
                attempt: 1,
                carrier: 'ws',
                jobConclusion: 'success',
                plan: toPlan('ws'),
                familyResults: [toResult('ws')]
            }],
            issues: []
        });
    });

    it('skips a job that is not a lane job, and a skipped matrix job whose name was never expanded', () => {
        const reading = toAlmLaneObservedRuns(toInput({
            jobs: [
                { name: 'Detect ALM lane changes', status: 'completed', conclusion: 'success' },
                toLaneJob('${{ matrix.carrier }}', 'skipped')
            ],
            artifacts: []
        }));

        expect(reading).toEqual({ runs: [], issues: [] });
    });

    it('names a lane job for a carrier it does not know that was not skipped', () => {
        const reading = toAlmLaneObservedRuns(toInput({ jobs: [toLaneJob('tcp', 'failure')], artifacts: [] }));

        expect(reading.runs).toEqual([]);
        expect(reading.issues).toEqual(['run 7: job "ALM conformance observation (tcp)" names no known carrier.']);
    });

    it('maps the job conclusion and gives each carrier only its own artifact', () => {
        const rtcArtifact = toArtifact('rtc', [toFile('rtc-full-plan.json', toPlan('rtc'))]);
        const reading = toAlmLaneObservedRuns(toInput({
            jobs: [toLaneJob('ws', 'timed_out'), toLaneJob('rtc-with-ws-fallback', 'cancelled'), toLaneJob('rtc')],
            artifacts: [wsArtifact, rtcArtifact]
        }));

        expect(reading.runs.map(({ carrier, jobConclusion, plan }) => ({ carrier, jobConclusion, plan }))).toEqual([
            { carrier: 'ws', jobConclusion: 'failure', plan: toPlan('ws') },
            { carrier: 'rtc-with-ws-fallback', jobConclusion: 'cancelled', plan: null },
            { carrier: 'rtc', jobConclusion: 'success', plan: toPlan('rtc') }
        ]);
        expect(reading.issues).toEqual([]);
    });

    it('refuses a plan and a result whose carrier or scope disagrees with the job, and treats them as absent', () => {
        const reading = toAlmLaneObservedRuns(toInput({
            artifacts: [toArtifact('ws', [
                toFile('ws-full-plan.json', toPlan('rtc')),
                toFile('ws-full-two-agent.json', toResult('ws', 'smoke'))
            ])]
        }));

        expect(reading.runs[0]?.plan).toBeNull();
        expect(reading.runs[0]?.familyResults).toEqual([]);
        expect(reading.issues).toEqual([
            'run 7 ws: ws-full-plan.json is for carrier rtc, scope full and backend postgres; the job is for carrier ws,' +
            ' scope full and backend postgres.',
            'run 7 ws: ws-full-two-agent.json is for carrier ws, scope smoke and backend postgres; the job is for carrier' +
            ' ws, scope full and backend postgres.'
        ]);
    });

    it('names a file that is not JSON or does not decode, and treats it as absent', () => {
        const reading = toAlmLaneObservedRuns(toInput({
            artifacts: [toArtifact('ws', [
                { fileName: 'ws-full-plan.json', text: '{"carrier":' },
                toFile('ws-full-two-agent.json', { ...toResult('ws'), familyOutcome: 'skipped' })
            ])]
        }));

        expect(reading.runs[0]?.plan).toBeNull();
        expect(reading.runs[0]?.familyResults).toEqual([]);
        expect(reading.issues).toEqual([
            'run 7 ws: ws-full-plan.json is not JSON.',
            'run 7 ws: ws-full-two-agent.json: familyOutcome is "skipped"; expected one of passed, failed, not-finished.'
        ]);
    });

    it('names a second result for one family and keeps both, so the ledger reads the family red', () => {
        const reading = toAlmLaneObservedRuns(toInput({
            artifacts: [toArtifact('ws', [
                toFile('ws-full-plan.json', toPlan('ws')),
                toFile('ws-full-two-agent.json', toResult('ws')),
                toFile('ws-full-two-agent-copy.json', toResult('ws'))
            ])]
        }));

        expect(reading.runs[0]?.familyResults).toEqual([toResult('ws'), toResult('ws')]);
        expect(reading.issues).toEqual(['run 7 ws: ws-full-two-agent-copy.json is a second result for family two-agent.']);
    });

    it('names a second plan and keeps the first', () => {
        const reading = toAlmLaneObservedRuns(toInput({
            artifacts: [toArtifact('ws', [
                toFile('ws-full-plan.json', toPlan('ws')),
                toFile('copy-ws-full-plan.json', { ...toPlan('ws'), families: [] })
            ])]
        }));

        expect(reading.runs[0]?.plan).toEqual(toPlan('ws'));
        expect(reading.issues).toEqual(['run 7 ws: copy-ws-full-plan.json is a second plan.']);
    });

    it('names an artifact that could not be downloaded and reads the job as having no files', () => {
        const reading = toAlmLaneObservedRuns(toInput({ artifacts: [{ ...wsArtifact, files: null }] }));

        expect(reading.runs[0]?.plan).toBeNull();
        expect(reading.issues).toEqual(['run 7 ws: artifact alm-lane-result-ws-full-merge-sha could not be downloaded.']);
    });

    it('names an expired artifact and reads the job as having no plan', () => {
        const reading = toAlmLaneObservedRuns(toInput({ artifacts: [{ ...wsArtifact, expired: true, files: null }] }));

        expect(reading.runs[0]?.plan).toBeNull();
        expect(reading.issues).toEqual([
            'run 7 ws: artifact alm-lane-result-ws-full-merge-sha has expired; history ends at artifact retention.'
        ]);
    });

    it('refuses a file whose backend is not postgres', () => {
        const reading = toAlmLaneObservedRuns(toInput({
            artifacts: [toArtifact('ws', [toFile('ws-full-plan.json', { ...toPlan('ws'), backend: 'memory' })])]
        }));

        expect(reading.runs[0]?.plan).toBeNull();
        expect(reading.issues).toEqual([
            'run 7 ws: ws-full-plan.json is for carrier ws, scope full and backend memory; the job is for carrier ws,' +
            ' scope full and backend postgres.'
        ]);
    });

    it.each(['push', 'workflow_dispatch'])(
        'reads each carrier of a completed %s run with no job of its own as not read, and names it',
        (event) => {
            const reading = toAlmLaneObservedRuns(toInput({ event }));

            expect(reading.runs.map(({ carrier, jobConclusion, plan }) => ({ carrier, jobConclusion, plan }))).toEqual([
                { carrier: 'ws', jobConclusion: 'success', plan: toPlan('ws') },
                { carrier: 'rtc', jobConclusion: 'not-read', plan: null },
                { carrier: 'rtc-with-ws-fallback', jobConclusion: 'not-read', plan: null }
            ]);
            expect(reading.issues).toEqual([
                'run 7 rtc: no job of this carrier was read.',
                'run 7 rtc-with-ws-fallback: no job of this carrier was read.'
            ]);
        }
    );

    it('gives every carrier of a rerun push run that attempt, so the ledger reads all three red as a rerun', () => {
        const toCarrierArtifact = (carrier: AlmConformanceCarrier) =>
            toArtifact(carrier, [
                toFile(`${carrier}-full-plan.json`, toPlan(carrier)),
                toFile(`${carrier}-full-two-agent.json`, toResult(carrier))
            ]);
        const reading = toAlmLaneObservedRuns(toInput({
            event: 'push',
            attempt: 2,
            jobs: ALM_CONFORMANCE_CARRIERS.map((carrier) => toLaneJob(carrier)),
            artifacts: ALM_CONFORMANCE_CARRIERS.map(toCarrierArtifact)
        }));

        const ledger = computeAlmLaneLedger({ runs: reading.runs, causes: [] });

        expect(reading.runs.map((run) => run.attempt)).toEqual([2, 2, 2]);
        expect(ledger.carriers.map(({ carrier, unattributed }) => ({ carrier, unattributed }))).toEqual(
            ALM_CONFORMANCE_CARRIERS.map((carrier) => ({
                carrier,
                unattributed: [{ runId: 7, commitSha: 'abcdef1234567', reason: 'rerun' }]
            }))
        );
    });

    it('reads nothing missing of a pull-request run, or of a push run still in progress', () => {
        expect(toAlmLaneObservedRuns(toInput({ jobs: [] }))).toEqual({ runs: [], issues: [] });
        expect(toAlmLaneObservedRuns(toInput({ event: 'push', status: 'in_progress', conclusion: null, jobs: [] })))
            .toEqual({ runs: [], issues: [] });
    });

    it('reads nothing of a run that was skipped', () => {
        const skipped = toInput({ event: 'push', conclusion: 'skipped', jobs: [toLaneJob('ws', 'skipped')], artifacts: [] });

        expect(toAlmLaneObservedRuns(skipped)).toEqual({ runs: [], issues: [] });
    });

    it('reads no run for an event the ledger does not read', () => {
        const reading = toAlmLaneObservedRuns(toInput({ event: 'schedule' }));

        expect(reading).toEqual({ runs: [], issues: ['run 7: event schedule is not one the ledger reads.'] });
    });
});

const FIRST_FAMILIES = 'two-agent,addressed,same-context';
const SECOND_FAMILIES = 'three-agent,same-principal,four-role';
const rtcTwoAgent = toFixtureResult('rtc', 'two-agent', new Map([['a', 'passed'], ['b', 'passed']]));
const rtcThreeAgent = toFixtureResult('rtc', 'three-agent', new Map([['c', 'passed']]));

function toSplitJob(families: string, conclusion: string | null = 'success'): AlmLaneReportedJob {
    return {
        name: `ALM conformance observation (rtc, ${families})`,
        status: conclusion === null ? 'in_progress' : 'completed',
        conclusion
    };
}

function toSplitArtifact(families: string, files: readonly AlmLaneResultFile[]): AlmLaneResultArtifact {
    return { name: `alm-lane-result-rtc-full-merge-sha-${families}`, expired: false, files };
}

const firstArtifact = toSplitArtifact(FIRST_FAMILIES, [
    toFile('rtc-full-plan.json', toFixturePlan('rtc')),
    toFile('rtc-full-two-agent.json', rtcTwoAgent)
]);
const secondArtifact = toSplitArtifact(SECOND_FAMILIES, [
    toFile('rtc-full-plan.json', toFixturePlan('rtc')),
    toFile('rtc-full-three-agent.json', rtcThreeAgent)
]);

function toSplitInput(overrides: Partial<ToAlmLaneObservedRunsInput>): ToAlmLaneObservedRunsInput {
    return toInput({
        jobs: [toSplitJob(FIRST_FAMILIES), toSplitJob(SECOND_FAMILIES)],
        artifacts: [firstArtifact, secondArtifact],
        ...overrides
    });
}

describe('toAlmLaneObservedRuns over a carrier split across jobs', () => {
    it('reads the two jobs of a carrier as one run, with their one plan and the results of both artifacts', () => {
        const reading = toAlmLaneObservedRuns(toSplitInput({}));

        expect(reading).toEqual({
            runs: [{
                runId: 7,
                commitSha: 'abcdef1234567',
                event: 'pull_request',
                attempt: 1,
                carrier: 'rtc',
                jobConclusion: 'success',
                plan: toFixturePlan('rtc'),
                familyResults: [rtcTwoAgent, rtcThreeAgent]
            }],
            issues: []
        });
        expect(computeAlmLaneRunReading(reading.runs[0]!).green).toBe(true);
    });

    it.each(
        [
            [['success', 'timed_out'], 'failure'],
            [['skipped', 'success'], 'failure'],
            [['failure', 'cancelled'], 'cancelled'],
            [['cancelled', null], 'in-progress']
        ] as const
    )('combines jobs that concluded %j into one %s', (conclusions, expected) => {
        const reading = toAlmLaneObservedRuns(toSplitInput({
            jobs: [toSplitJob(FIRST_FAMILIES, conclusions[0]), toSplitJob(SECOND_FAMILIES, conclusions[1])]
        }));

        expect(reading.runs.map((run) => run.jobConclusion)).toEqual([expected]);
    });

    it.each(
        [
            ['has expired', { expired: true, files: null }, 'has expired; history ends at artifact retention.'],
            ['could not be downloaded', { files: null }, 'could not be downloaded.']
        ] as const
    )('names a job artifact that %s and reads the other job artifact', (_, unread, issue) => {
        const reading = toAlmLaneObservedRuns(toSplitInput({ artifacts: [firstArtifact, { ...secondArtifact, ...unread }] }));

        expect(reading.runs.map(({ plan, familyResults }) => ({ plan, familyResults }))).toEqual([
            { plan: toFixturePlan('rtc'), familyResults: [rtcTwoAgent] }
        ]);
        expect(reading.issues).toEqual([`run 7 rtc: artifact ${secondArtifact.name} ${issue}`]);
    });

    it.each(
        [
            ['plan another order of scenario keys', [{ family: 'two-agent', scenarioKeys: ['b', 'a'] }]],
            ['plan another set of families', [{ family: 'two-agent', scenarioKeys: ['a', 'b'] }]]
        ] as const
    )('names jobs whose plans %s and reads the first plan', (_, families) => {
        const otherPlan = { ...toFixturePlan('rtc'), families };
        const reading = toAlmLaneObservedRuns(toSplitInput({
            artifacts: [firstArtifact, toSplitArtifact(SECOND_FAMILIES, [toFile('rtc-full-plan.json', otherPlan)])]
        }));

        expect(reading.runs[0]?.plan).toEqual(toFixturePlan('rtc'));
        expect(reading.issues).toEqual(['run 7 rtc: plans of 2 jobs differ; read the first.']);
    });

    it('names a second result for one family across the jobs and keeps both, so the ledger reads the family red', () => {
        const reading = toAlmLaneObservedRuns(toSplitInput({
            artifacts: [firstArtifact, toSplitArtifact(SECOND_FAMILIES, [toFile('rtc-full-two-agent.json', rtcTwoAgent)])]
        }));

        expect(reading.runs[0]?.familyResults).toEqual([rtcTwoAgent, rtcTwoAgent]);
        expect(reading.issues).toEqual(['run 7 rtc: rtc-full-two-agent.json is a second result for family two-agent.']);
    });

    it('reads a carrier whose second job never uploaded as red, its families not run', () => {
        const reading = toAlmLaneObservedRuns(toSplitInput({ artifacts: [firstArtifact] }));

        expect(reading.issues).toEqual([]);
        expect(reading.runs.map(computeAlmLaneRunReading)).toMatchObject([{
            green: false,
            failed: [],
            notRun: ['rtc/three-agent/c'],
            candidates: ['rtc/three-agent'],
            unattributedReason: null
        }]);
    });

    it('still reads a completed push run with no job of the split carrier as no job read', () => {
        const reading = toAlmLaneObservedRuns(toInput({
            event: 'push',
            jobs: [toLaneJob('ws'), toLaneJob('rtc-with-ws-fallback')],
            artifacts: [wsArtifact]
        }));

        const ledger = computeAlmLaneLedger({ runs: reading.runs, causes: [] });

        expect(ledger.carriers.find((streak) => streak.carrier === 'rtc')?.unattributed).toEqual([
            { runId: 7, commitSha: 'abcdef1234567', reason: 'no-job-read' }
        ]);
    });
});

describe('resolveAlmLaneResultArtifacts', () => {
    it('selects the full-scope lane result artifacts of every carrier, expired ones included', () => {
        const toListed = (name: string, expired = false) => ({ name, expired });

        expect(resolveAlmLaneResultArtifacts([
            toListed('alm-lane-result-ws-full-abc'),
            toListed('alm-lane-result-rtc-with-ws-fallback-full-abc', true),
            toListed('alm-lane-result-rtc-smoke-abc'),
            toListed('alm-conformance-lane-ws-full-abc'),
            toListed('validation-evidence-v2')
        ])).toEqual([
            toListed('alm-lane-result-ws-full-abc'),
            toListed('alm-lane-result-rtc-with-ws-fallback-full-abc', true)
        ]);
    });
});
