import { describe, expect, it } from 'vitest';

import {
    decodeRtcBaselineFailureOutcome,
    findRtcBaselineAttemptFailureOwner,
    resolveRtcBaselineAcceptedArtifactPath
} from '../../../baseline/acceptance/rtc-baseline-failure-accounting.ts';
import {
    buildRtcBaselineJobBudgetNotStartedSequence,
    isRtcBaselineJobBudgetOutcome,
    RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ID
} from '../../../baseline/acceptance/rtc-baseline-job-budget-not-started.ts';
import {
    computeRtcBaselineExpectedSampleIdentities,
    deriveRtcBaselineCaptureManifest
} from '../../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import { validateRtcBaselineCompleteAccounting } from '../../../baseline/contracts/rtc-baseline-artifact-validation.ts';
import { projectRtcBaselineArtifactOutcomes } from '../../../baseline/evidence/rtc-baseline-artifact-projection.ts';

const manifest = deriveRtcBaselineCaptureManifest({
    schema: 'rallar.rtc-baseline.capture-request.v1',
    baselineId: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3',
    workloadIds: ['RTC-B06'],
    environmentId: 'E3-memory',
    retainedSampleMultiplier: 1,
    repeatLink: null,
    conditionalEnvironmentDecisions: []
});

function notStartedFrom(locator: Parameters<typeof findRtcBaselineAttemptFailureOwner>[1]) {
    const owner = findRtcBaselineAttemptFailureOwner(manifest, locator);
    if (!owner) {
        throw new Error('The locator names no declared attempt.');
    }
    return buildRtcBaselineJobBudgetNotStartedSequence(manifest, owner);
}

const retentionWarmup = {
    workloadId: 'RTC-B06' as const,
    caseId: 'retention-100',
    inputKey: 'e3-memory-retention-100',
    intendedPhase: 'warmup' as const,
    outerOrdinal: 1
};

describe('RTC baseline job budget not-started receipts', () => {
    it('records the first unstarted attempt and every later one, and the cohort they leave unasserted', () => {
        const sequence = notStartedFrom(retentionWarmup);

        expect(sequence.map((artifact) => [artifact.artifactKind, artifact.outcome, artifact.issues[0]?.code])).toEqual([
            ['not-run', 'not-run', 'not-started-job-budget'],
            ['not-run', 'not-run', 'not-started-job-budget'],
            ['not-run', 'not-run', 'not-started-job-budget'],
            ['not-run', 'not-run', 'not-started-job-budget'],
            ['failure', 'failed', 'cohort-members-not-started-job-budget']
        ]);
        expect(sequence.slice(0, 4).map((artifact) => artifact.causalFailureId)).toEqual(
            Array(4).fill(RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ID)
        );
        expect(sequence[4]?.rawEvidence).toEqual({
            causalFailureId: RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ID,
            blockedMemberSampleIds: manifest.expectedCohorts[0]?.memberSampleIds
        });
    });

    it('decodes from its stored paths and completes the accounting beside the attempts that passed', () => {
        const sequence = notStartedFrom(retentionWarmup);
        const decoded = sequence.map((artifact) => {
            const path = resolveRtcBaselineAcceptedArtifactPath(artifact);
            return path.ok ? decodeRtcBaselineFailureOutcome(JSON.parse(JSON.stringify(artifact)), path.value) : path;
        });
        expect(decoded.every((result) => result.ok)).toBe(true);
        const notStartedSampleIds = new Set(sequence.flatMap((artifact) => 'sampleId' in artifact.identity ? [artifact.identity.sampleId] : []));
        const passed = computeRtcBaselineExpectedSampleIdentities(manifest)
            .filter((identity) => !notStartedSampleIds.has(identity.sampleId))
            .map((identity) => ({ identity, outcome: 'passed' as const, issues: [] }));
        const outcomes = projectRtcBaselineArtifactOutcomes({
            sampleOutcomes: passed,
            cohortOutcomes: [],
            failures: sequence.map(({ identity, outcome, issues }) => ({ identity, outcome, issues }))
        });

        expect(validateRtcBaselineCompleteAccounting({
            expectedSamples: computeRtcBaselineExpectedSampleIdentities(manifest),
            expectedCohorts: manifest.expectedCohorts,
            ...outcomes
        })).toEqual([]);
        expect(
            [...outcomes.sampleOutcomes, ...outcomes.cohortOutcomes].filter((outcome) => outcome.outcome !== 'passed')
                .every(isRtcBaselineJobBudgetOutcome)
        ).toBe(true);
    });

    it('tells a job budget outcome apart from a failed one', () => {
        expect(isRtcBaselineJobBudgetOutcome({ issues: [] })).toBe(false);
        expect(isRtcBaselineJobBudgetOutcome({
            issues: [{ path: '$.producerExitStatus', code: 'producer-exit-status', message: 'Producer exited with status 1.' }]
        })).toBe(false);
    });
});
