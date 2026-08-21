import type {
    RtcBaselineFailureArtifact,
    RtcBaselineNotRunArtifact
} from '../acceptance/rtc-baseline-failure-accounting.ts';
import { decodeRtcBaselineManifest } from '../contracts/rtc-baseline-artifact-decoding.ts';
import type {
    RtcBaselineAttemptLocatorDto,
    RtcBaselineCaptureManifestDto,
    RtcBaselineCaptureRequestDto,
    RtcBaselineConfigurationFieldDescriptorDto,
    RtcBaselineEnvironmentId,
    RtcBaselineExternalCohortDto,
    RtcBaselineIssueDto,
    RtcBaselineJson,
    RtcBaselineOuterAttemptDto,
    RtcBaselineResult,
    RtcBaselineSampleDto,
    RtcBaselineSampleIdentityDto,
    RtcBaselineSampleOutcomeDto,
    RtcBaselineWorkloadId
} from '../contracts/rtc-baseline-contracts.ts';
import {
    canonicalizeRtcBaselineRawReferences,
    type RtcBaselineSummaryArtifactRecord
} from '../evidence/rtc-baseline-evidence-layout.ts';
import type { RtcBaselineMetricObservation } from '../evidence/rtc-baseline-statistics.ts';
import { RTC_BASELINE_WORKLOAD_CATALOG } from './rtc-baseline-workload-catalog.ts';
export function createRtcBaselineExternalAttemptReader(
    readJson: (baselineId: string, path: string) => Promise<RtcBaselineResult<RtcBaselineJson>>
) {
    return async (input: { baselineId: string; workloadId: RtcBaselineWorkloadId; }) => {
        const result = await readJson(input.baselineId, 'manifest.json');
        if (!result.ok) {
            return result;
        }
        const decoded = decodeRtcBaselineManifest(result.value);
        return decoded.ok
            ? {
                ok: true as const,
                value: deriveRtcBaselineExternalAttempts(decoded.value, input.workloadId)
            }
            : decoded;
    };
}
function pad(value: number) {
    return String(value).padStart(3, '0');
}

function innerCount(configuration: readonly RtcBaselineConfigurationFieldDescriptorDto[]) {
    const configured = configuration.find((descriptor) => descriptor.field === 'innerRuns');
    return typeof configured?.defaultValue === 'number' ? configured.defaultValue : 1;
}

function sampleId(
    ...input: readonly [
        workloadId: RtcBaselineWorkloadId,
        caseId: string,
        inputKey: string,
        intendedPhase: 'warmup' | 'retained',
        outerOrdinal: number,
        innerOrdinal: number
    ]
) {
    const [workloadId, caseId, inputKey, intendedPhase, outerOrdinal, innerOrdinal] = input;
    return [
        `rtc-${workloadId.slice(4).toLowerCase()}`,
        caseId,
        inputKey,
        intendedPhase,
        pad(outerOrdinal),
        pad(innerOrdinal)
    ].join('-');
}

function stagedAttemptPath(attempt: RtcBaselineOuterAttemptDto) {
    return [
        `artifacts/staging/rtc-${attempt.workloadId.slice(4).toLowerCase()}`,
        attempt.caseId,
        attempt.inputKey,
        attempt.intendedPhase,
        `${pad(attempt.outerOrdinal)}.json`
    ].join('-');
}

function selectedCases(request: RtcBaselineCaptureRequestDto) {
    return request.workloadIds.flatMap((workloadId) => {
        const workload = RTC_BASELINE_WORKLOAD_CATALOG.find(
            (entry) => entry.workloadId === workloadId
        )!;
        return workload.cases
            .filter((entry) =>
                workloadId === 'RTC-B06'
                    ? entry.inputKey.startsWith(request.environmentId.toLowerCase().replace('-', '-'))
                    : true
            )
            .map((entry) => ({ workload, entry }));
    });
}

export function deriveRtcBaselineCaptureManifest(
    request: RtcBaselineCaptureRequestDto
): RtcBaselineCaptureManifestDto {
    const cases = selectedCases(request);
    const outerAttempts: RtcBaselineOuterAttemptDto[] = [];
    for (const { workload, entry } of cases) {
        const warmups = entry.warmupOuterAttempts ?? workload.warmupOuterAttempts;
        const retained = (entry.retainedOuterAttempts ?? workload.retainedOuterAttempts) *
            request.retainedSampleMultiplier;
        for (
            const [intendedPhase, count] of [
                ['warmup', warmups],
                ['retained', retained]
            ] as const
        ) {
            for (let outerOrdinal = 1; outerOrdinal <= count; outerOrdinal += 1) {
                const sampleIds: string[] = [];
                for (
                    let innerOrdinal = 1;
                    innerOrdinal <= innerCount(entry.configuration);
                    innerOrdinal += 1
                ) {
                    sampleIds.push(
                        sampleId(
                            workload.workloadId,
                            entry.caseId,
                            entry.inputKey,
                            intendedPhase,
                            outerOrdinal,
                            innerOrdinal
                        )
                    );
                }
                outerAttempts.push({
                    workloadId: workload.workloadId,
                    caseId: entry.caseId,
                    inputKey: entry.inputKey,
                    environmentId: request.environmentId,
                    intendedPhase,
                    outerOrdinal,
                    sampleIds
                });
            }
        }
    }
    const expectedCohorts = cases.flatMap(({ workload, entry }) =>
        'cohortId' in entry && entry.cohortId
            ? [
                {
                    cohortId: entry.cohortId,
                    workloadId: workload.workloadId,
                    memberSampleIds: outerAttempts
                        .filter(
                            (attempt) =>
                                attempt.workloadId === workload.workloadId &&
                                attempt.caseId === entry.caseId &&
                                attempt.inputKey === entry.inputKey &&
                                attempt.intendedPhase === 'retained'
                        )
                        .flatMap((attempt) => attempt.sampleIds)
                }
            ]
            : []
    );
    return {
        schema: 'rallar.rtc-baseline.manifest.v1',
        request,
        workloadIds: request.workloadIds,
        cases: cases.map(({ workload, entry }) => ({
            workloadId: workload.workloadId,
            caseId: entry.caseId,
            inputKey: entry.inputKey
        })),
        outerAttempts,
        expectedCohorts,
        repeatLink: request.repeatLink
    };
}

export function deriveRtcBaselineRepeatManifest(
    _primary: RtcBaselineCaptureManifestDto,
    request: RtcBaselineCaptureRequestDto
) {
    return deriveRtcBaselineCaptureManifest(request);
}

export function deriveRtcBaselineOuterAttempts(manifest: RtcBaselineCaptureManifestDto) {
    return manifest.outerAttempts;
}

export function deriveRtcBaselineExternalAttempts(
    manifest: RtcBaselineCaptureManifestDto,
    workloadId: RtcBaselineWorkloadId
) {
    return manifest.outerAttempts
        .filter((attempt) => attempt.workloadId === workloadId)
        .map((attempt) => ({
            workloadId: attempt.workloadId,
            caseId: attempt.caseId,
            inputKey: attempt.inputKey,
            intendedPhase: attempt.intendedPhase,
            outerOrdinal: attempt.outerOrdinal,
            environmentId: attempt.environmentId,
            rawResultRelativePath: stagedAttemptPath(attempt)
        }));
}

export function computeRtcBaselineExpectedSampleIdentities(
    manifest: RtcBaselineCaptureManifestDto
): RtcBaselineSampleIdentityDto[] {
    return manifest.outerAttempts.flatMap((outer) =>
        outer.sampleIds.map((id, index) => ({
            sampleId: id,
            workloadId: outer.workloadId,
            caseId: outer.caseId,
            inputKey: outer.inputKey,
            intendedPhase: outer.intendedPhase,
            outerOrdinal: outer.outerOrdinal,
            innerOrdinal: index + 1
        }))
    );
}

export function validateRtcBaselineStoredOutcomeReconciliation(input: {
    sampleOutcomes: readonly RtcBaselineSampleOutcomeDto[];
    samples: readonly RtcBaselineSampleDto[];
    cohorts: readonly RtcBaselineExternalCohortDto[];
    failures: readonly (RtcBaselineFailureArtifact | RtcBaselineNotRunArtifact)[];
    summary: RtcBaselineSummaryArtifactRecord;
}) {
    const { sampleOutcomes, cohortOutcomes } = projectRtcBaselineStoredOutcomes({
        sampleOutcomes: input.sampleOutcomes,
        cohortOutcomes: input.cohorts,
        failures: input.failures
    });
    const issues: RtcBaselineIssueDto[] = [];
    const compare = (actual: object, expected: object, problem: RtcBaselineIssueDto) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            issues.push(problem);
        }
    };
    compare(sampleOutcomes, input.summary.sampleOutcomes, {
        path: '$.summary.sampleOutcomes',
        code: 'sample-outcome-mismatch',
        message: 'Summary sample outcomes differ from retained artifacts.'
    });
    compare(cohortOutcomes, input.summary.cohortOutcomes, {
        path: '$.summary.cohortOutcomes',
        code: 'cohort-outcome-mismatch',
        message: 'Summary cohort outcomes differ from retained artifacts.'
    });
    const storedRaw = canonicalizeRtcBaselineRawReferences(
        input.samples.flatMap((sample) => sample.rawReferences)
    );
    const summaryRaw = canonicalizeRtcBaselineRawReferences(input.summary.rawReferences);
    if (!storedRaw.ok) {
        issues.push(...storedRaw.issues);
    }
    if (!summaryRaw.ok) {
        issues.push(...summaryRaw.issues);
    }
    if (storedRaw.ok && summaryRaw.ok) {
        compare(storedRaw.value, summaryRaw.value, {
            path: '$.summary.rawReferences',
            code: 'raw-reference-mismatch',
            message: 'Summary raw references differ from retained samples.'
        });
    }
    return issues;
}

export function projectRtcBaselineStoredOutcomes(input: {
    sampleOutcomes: readonly RtcBaselineSampleOutcomeDto[];
    cohortOutcomes: readonly RtcBaselineExternalCohortDto[];
    failures: readonly (RtcBaselineFailureArtifact | RtcBaselineNotRunArtifact)[];
}) {
    const samples = new Map(
        input.sampleOutcomes.map(({ identity, outcome, issues }) => [
            identity.sampleId,
            { identity, outcome, issues }
        ])
    );
    const cohorts = new Map(
        input.cohortOutcomes.map(({ identity, outcome, issues }) => [
            identity.cohortId,
            { identity, outcome, issues }
        ])
    );
    for (const failure of input.failures) {
        if ('sampleId' in failure.identity) {
            samples.set(failure.identity.sampleId, {
                identity: failure.identity,
                outcome: failure.outcome,
                issues: failure.issues
            });
        }
        else {
            cohorts.set(failure.identity.cohortId, {
                identity: failure.identity,
                outcome: 'failed',
                issues: failure.issues
            });
        }
    }
    return {
        sampleOutcomes: [...samples.values()].sort((left, right) =>
            left.identity.sampleId.localeCompare(right.identity.sampleId)
        ),
        cohortOutcomes: [...cohorts.values()].sort((left, right) =>
            left.identity.cohortId.localeCompare(right.identity.cohortId)
        )
    };
}

export function computeRtcBaselineMetricObservations(
    samples: readonly RtcBaselineSampleDto[],
    environmentId: RtcBaselineEnvironmentId
) {
    return samples.flatMap((sample): RtcBaselineMetricObservation[] => {
        if (
            sample.outcome !== 'passed' ||
            sample.identity.intendedPhase !== 'retained' ||
            sample.runtimeObservation === null
        ) {
            return [];
        }
        const observed = sample.runtimeObservation;
        const database = observed.resolvedConfiguration.find(
            (field) => field.field === 'databaseProvider'
        );
        return sample.metrics.map((metric) => ({
            grouping: {
                headCommit: observed.git.headCommit,
                headTree: observed.git.headTree,
                environmentId,
                provider: sample.evidenceClass,
                browserBuild: observed.runtime.chromium,
                databaseMode: String(database?.value ?? 'none'),
                configurationIdentity: JSON.stringify(observed.resolvedConfiguration),
                workloadId: sample.identity.workloadId,
                caseId: sample.identity.caseId,
                inputKey: sample.identity.inputKey,
                metric: metric.metric,
                unit: metric.unit
            },
            sampleId: sample.identity.sampleId,
            value: metric.value
        }));
    });
}

export function locateRtcBaselineExternalAttempt(
    manifest: RtcBaselineCaptureManifestDto,
    locator: Partial<
        Pick<RtcBaselineAttemptLocatorDto, 'workloadId' | 'caseId' | 'inputKey' | 'intendedPhase' | 'outerOrdinal'>
    >
) {
    for (
        const field of [
            'workloadId',
            'caseId',
            'inputKey',
            'intendedPhase',
            'outerOrdinal'
        ] as const
    ) {
        if (locator[field] === undefined) {
            return {
                ok: false as const,
                issues: [
                    {
                        path: `$.locator.${field}`,
                        code: 'missing-field',
                        message: `External attempt locator requires ${field}.`
                    }
                ]
            };
        }
    }
    const found = manifest.outerAttempts.find(
        (outer) =>
            outer.workloadId === locator.workloadId &&
            outer.caseId === locator.caseId &&
            outer.inputKey === locator.inputKey &&
            outer.intendedPhase === locator.intendedPhase &&
            outer.outerOrdinal === locator.outerOrdinal
    );
    if (!found) {
        return {
            ok: false as const,
            issues: [
                {
                    path: '$.locator',
                    code: 'unknown-external-attempt',
                    message: 'External attempt locator is not predeclared by the initialized manifest.'
                }
            ]
        };
    }
    return {
        ok: true as const,
        value: {
            workloadId: found.workloadId,
            caseId: found.caseId,
            inputKey: found.inputKey,
            intendedPhase: found.intendedPhase,
            outerOrdinal: found.outerOrdinal,
            environmentId: found.environmentId,
            rawResultRelativePath: stagedAttemptPath(found)
        }
    };
}
