import { describe, expect, it } from 'vitest';

import type { AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    toAlmLaneFamilyResult,
    type AlmLaneFamilyResult,
    type AlmLanePlanRecord
} from '@shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';
import type { AlmLaneReportedJob } from '@shared-test/rallar-bb-test/conformance/alm/ledger/to-alm-lane-job-conclusion.ts';
import {
    resolveAlmLaneResultArtifactNames,
    toAlmLaneObservedRuns,
    type AlmLaneResultArtifact,
    type AlmLaneResultFile,
    type ToAlmLaneObservedRunsInput
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/to-alm-lane-observed-runs.ts';

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
    return { name: `alm-lane-result-${carrier}-full-merge-sha`, files };
}

const wsArtifact = toArtifact('ws', [
    toFile('ws-full-plan.json', toPlan('ws')),
    toFile('ws-full-two-agent.json', toResult('ws'))
]);

function toInput(overrides: Partial<ToAlmLaneObservedRunsInput>): ToAlmLaneObservedRunsInput {
    return {
        runId: 7,
        commitSha: 'abcdef1234567',
        event: 'push',
        attempt: 1,
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
                event: 'push',
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
            'run 7 ws: ws-full-plan.json is for carrier rtc and scope full; the job is for carrier ws and scope full.',
            'run 7 ws: ws-full-two-agent.json is for carrier ws and scope smoke; the job is for carrier ws and scope full.'
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

    it('names a carrier that has two result artifacts and reads the first', () => {
        const second = { ...wsArtifact, name: 'alm-lane-result-ws-full-other-sha', files: [] };

        const reading = toAlmLaneObservedRuns(toInput({ artifacts: [wsArtifact, second] }));

        expect(reading.runs[0]?.plan).toEqual(toPlan('ws'));
        expect(reading.issues).toEqual([
            'run 7 ws: 2 result artifacts (alm-lane-result-ws-full-merge-sha, alm-lane-result-ws-full-other-sha); read the first.'
        ]);
    });

    it('reads no run for an event the ledger does not read', () => {
        const reading = toAlmLaneObservedRuns(toInput({ event: 'schedule' }));

        expect(reading).toEqual({ runs: [], issues: ['run 7: event schedule is not one the ledger reads.'] });
    });
});

describe('resolveAlmLaneResultArtifactNames', () => {
    it('selects the full-scope lane result artifacts of every carrier', () => {
        expect(resolveAlmLaneResultArtifactNames([
            'alm-lane-result-ws-full-abc',
            'alm-lane-result-rtc-with-ws-fallback-full-abc',
            'alm-lane-result-rtc-smoke-abc',
            'alm-conformance-lane-ws-full-abc',
            'validation-evidence-v2'
        ])).toEqual(['alm-lane-result-ws-full-abc', 'alm-lane-result-rtc-with-ws-fallback-full-abc']);
    });
});
