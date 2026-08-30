import {
    computeRtcBaselineExpectedSampleIdentities,
    computeRtcBaselineMetricObservations,
    deriveRtcBaselineCaptureManifest,
    deriveRtcBaselineExternalAttempts
} from '../../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import type {
    RtcBaselineCaptureManifestDto,
    RtcBaselineConditionalEnvironmentDecisionDto,
    RtcBaselineEnvironmentDto,
    RtcBaselineExternalAttemptDto,
    RtcBaselineExternalCohortDto,
    RtcBaselineIssueDto,
    RtcBaselineRepeatLinkDto,
    RtcBaselineRuntimeObservationDto,
    RtcBaselineSampleDto
} from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import type { RtcBaselineSummaryArtifactRecord } from '../../../baseline/evidence/rtc-baseline-evidence-layout.ts';
import {
    partitionRtcBaselineMetricObservations,
    summarizeRtcBaselineMetricPartitions
} from '../../../baseline/evidence/rtc-baseline-statistics.ts';

const encoder = new TextEncoder();
const recordedIssue: RtcBaselineIssueDto = {
    path: '$.producerExitStatus',
    code: 'producer-exit-status',
    message: 'Producer exited with status 1.'
};
const e4NotRequired: RtcBaselineConditionalEnvironmentDecisionDto = {
    environmentId: 'E4-pg',
    decision: 'not-required',
    reason: 'E3-memory observation only; no database-backed candidate is being selected.'
};

export async function createRtcB05FinalizedArtifacts(
    baselineId: string,
    outcome: 'passed' | 'failed',
    repeatLink: RtcBaselineRepeatLinkDto | null = null
) {
    const runtimeObservation = toRuntimeObservation();
    const identity = {
        sampleId: 'rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001-001',
        workloadId: 'RTC-B05' as const,
        caseId: 'browser-data-channel-lifecycle',
        inputKey: 'iterations-25',
        intendedPhase: 'retained' as const,
        outerOrdinal: 1,
        innerOrdinal: 1
    };
    const issues = outcome === 'passed' ? [] : [recordedIssue];
    const sample: RtcBaselineSampleDto = {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity,
        outcome,
        evidenceClass: 'native-browser',
        metrics: outcome === 'passed'
            ? [
                { metric: 'firstOpenDurationMs', unit: 'ms', value: 10 },
                { metric: 'firstCloseDurationMs', unit: 'ms', value: 12 }
            ]
            : [],
        rawEvidence: { opened: outcome === 'passed', closed: outcome === 'passed' },
        rawReferences: [],
        issues,
        runtimeObservation
    };
    const environment = toEnvironment(baselineId, runtimeObservation, repeatLink);
    const manifest = toManifest(baselineId, identity.sampleId, repeatLink);
    const attempt = toExternalAttempt(sample, issues);
    const summary = toSummary(baselineId, sample, repeatLink);
    return withChecksums(
        new Map([
            ['environment.json', toJson(environment)],
            ['manifest.json', toJson(manifest)],
            [
                'results/external-attempts/' +
                'RTC-B05-browser-data-channel-lifecycle-iterations-25-retained-001.json',
                toJson(attempt)
            ],
            ['summary.json', toJson(summary)]
        ])
    );
}

export async function createRtcB06FinalizedArtifacts(
    baselineId: string,
    repeatLink: RtcBaselineRepeatLinkDto | null = null
) {
    const runtimeObservation = toB06RuntimeObservation();
    const retainedSampleMultiplier: 1 | 2 = baselineId.endsWith('-repeat-01') ? 2 : 1;
    const request = {
        schema: 'rallar.rtc-baseline.capture-request.v1' as const,
        baselineId,
        workloadIds: ['RTC-B06'] as const,
        environmentId: 'E3-memory' as const,
        retainedSampleMultiplier,
        repeatLink,
        conditionalEnvironmentDecisions: [e4NotRequired]
    };
    const manifest = deriveRtcBaselineCaptureManifest(request);
    const identities = computeRtcBaselineExpectedSampleIdentities(manifest);
    const samples: RtcBaselineSampleDto[] = identities.map((identity) => ({
        schema: 'rallar.rtc-baseline.sample.v1',
        identity,
        outcome: 'passed',
        evidenceClass: 'local-full-stack',
        metrics: [{ metric: 'durationMs', unit: 'ms', value: identity.outerOrdinal }],
        rawEvidence: {},
        rawReferences: [],
        issues: [],
        runtimeObservation
    }));
    const sampleById = new Map(samples.map((sample) => [sample.identity.sampleId, sample]));
    const attempts = deriveRtcBaselineExternalAttempts(manifest, 'RTC-B06').map((locator) => {
        const sample = samples.find((candidate) =>
            candidate.identity.caseId === locator.caseId &&
            candidate.identity.inputKey === locator.inputKey &&
            candidate.identity.intendedPhase === locator.intendedPhase &&
            candidate.identity.outerOrdinal === locator.outerOrdinal
        )!;
        const allScenarios = locator.caseId === 'all-scenarios';
        const retention = locator.caseId === 'retention-100';
        return {
            schema: 'rallar.rtc-baseline.external-attempt.v1' as const,
            locator,
            producerExitStatus: 0,
            producerFacts: {
                databaseUrl: 'absent' as const,
                allScenariosPresent: allScenarios,
                allScenariosRaw: allScenarios ? '1' : null,
                retentionSoakPresent: retention,
                retentionSoakRaw: retention ? '1' : null,
                retentionCyclesPresent: retention,
                retentionCyclesRaw: retention ? '100' : null,
                iceModePresent: false,
                iceModeRaw: null
            },
            sampleOutcomes: [{
                identity: sample.identity,
                outcome: sample.outcome,
                issues: sample.issues
            }],
            samples: [sample],
            issues: []
        };
    });
    const cohorts: RtcBaselineExternalCohortDto[] = manifest.expectedCohorts.map(
        (identity) => ({
            schema: 'rallar.rtc-baseline.external-cohort.v1',
            identity,
            outcome: 'passed',
            rawEvidence: {},
            issues: [],
            samples: identity.memberSampleIds.map((sampleId) => sampleById.get(sampleId)!)
        })
    );
    const environment: RtcBaselineEnvironmentDto = {
        schema: 'rallar.rtc-baseline.environment.v1',
        baselineId,
        workloadIds: ['RTC-B06'],
        environmentId: 'E3-memory',
        repeatLink,
        conditionalEnvironmentDecisions: [e4NotRequired],
        observation: runtimeObservation
    };
    const metricObservations = computeRtcBaselineMetricObservations(samples, 'E3-memory');
    const partitioned = partitionRtcBaselineMetricObservations(metricObservations);
    if (!partitioned.ok) {
        throw new Error('B06 observation fixture metrics must have consistent provenance.');
    }
    const summary: RtcBaselineSummaryArtifactRecord = {
        schema: 'rallar.rtc-baseline.summary.v1',
        baselineId,
        workloadIds: ['RTC-B06'],
        environmentId: 'E3-memory',
        repeatLink,
        conditionalEnvironmentDecisions: [e4NotRequired],
        sampleOutcomes: samples
            .map((sample) => ({
                identity: sample.identity,
                outcome: sample.outcome,
                issues: sample.issues
            }))
            .sort((left, right) => left.identity.sampleId.localeCompare(right.identity.sampleId)),
        cohortOutcomes: cohorts.map((cohort) => ({
            identity: cohort.identity,
            outcome: cohort.outcome,
            issues: cohort.issues
        })),
        metricSummaries: summarizeRtcBaselineMetricPartitions(partitioned.value),
        rawReferences: []
    };
    return withChecksums(
        new Map([
            ['environment.json', toJson(environment)],
            ['manifest.json', toJson(manifest)],
            ...attempts.map((attempt) =>
                [
                    `results/external-attempts/${attempt.locator.rawResultRelativePath.split('/').at(-1)}`,
                    toJson(attempt)
                ] as const
            ),
            ...cohorts.map((cohort) =>
                [
                    `results/external-cohorts/${cohort.identity.cohortId}.json`,
                    toJson(cohort)
                ] as const
            ),
            ['summary.json', toJson(summary)]
        ])
    );
}

function toB06RuntimeObservation(): RtcBaselineRuntimeObservationDto {
    return {
        ...toRuntimeObservation(),
        git: {
            headCommit: 'c0cadb8216cf27d82a3143755e6965f3831ea164',
            headTree: 'd45ae178384826f49fa31ab1e52c0f66d8ff069a',
            ref: 'detached@c0cadb8216cf27d82a3143755e6965f3831ea164',
            clean: true
        },
        runtime: { node: '24', npm: '11', deno: '2', playwright: '1', chromium: '139' },
        resolvedConfiguration: [
            {
                caseKey: {
                    workloadId: 'RTC-B06',
                    caseId: 'default',
                    inputKey: 'e3-memory-default'
                },
                field: 'databaseProvider',
                value: 'memory',
                source: 'default'
            }
        ],
        workerCommand: {
            redactedArgv: {
                executable: 'npm',
                arguments: ['run', 'test:rallar:full-stack:memory:live-rtc-3']
            },
            projection: { fixedWorkerFlags: [], configurationFlags: [] }
        },
        allowlistedEnvironment: { DATABASE_URL: 'absent' }
    };
}

function toRuntimeObservation(): RtcBaselineRuntimeObservationDto {
    return {
        git: {
            headCommit: 'eaf526518c70e3b396dad91c008125a622b38b00',
            headTree: '1111111111111111111111111111111111111111',
            ref: 'detached@eaf526518c70e3b396dad91c008125a622b38b00',
            clean: true
        },
        runtime: { node: '24', npm: '11', deno: '2', playwright: '1', chromium: '139' },
        host: {
            os: 'linux',
            kernel: '6.8',
            architecture: 'x64',
            logicalCpuCount: 4,
            cpuModel: 'GitHub Actions',
            totalMemoryBytes: 17179869184,
            executionContext: 'distributed'
        },
        timing: {
            startedAtUtc: '2026-08-27T03:15:00.417Z',
            endedAtUtc: '2026-08-27T03:16:00.417Z',
            monotonicDurationMs: 60000,
            monotonicSource: 'performance.now'
        },
        deviations: [],
        sourceHashes: [],
        configurationInputs: [],
        resolvedConfiguration: [],
        controllerInputs: [],
        workerCommand: {
            redactedArgv: { executable: 'node', arguments: [] },
            projection: { fixedWorkerFlags: [], configurationFlags: [] }
        },
        allowlistedEnvironment: {}
    };
}

function toEnvironment(
    baselineId: string,
    observation: RtcBaselineRuntimeObservationDto,
    repeatLink: RtcBaselineRepeatLinkDto | null
): RtcBaselineEnvironmentDto {
    return {
        schema: 'rallar.rtc-baseline.environment.v1',
        baselineId,
        workloadIds: ['RTC-B05'],
        environmentId: 'E2-browser',
        repeatLink,
        conditionalEnvironmentDecisions: [],
        observation
    };
}

function toManifest(
    baselineId: string,
    sampleId: string,
    repeatLink: RtcBaselineRepeatLinkDto | null
): RtcBaselineCaptureManifestDto {
    const request = {
        schema: 'rallar.rtc-baseline.capture-request.v1' as const,
        baselineId,
        workloadIds: ['RTC-B05'] as const,
        environmentId: 'E2-browser' as const,
        retainedSampleMultiplier: 1 as const,
        repeatLink,
        conditionalEnvironmentDecisions: []
    };
    return {
        schema: 'rallar.rtc-baseline.manifest.v1',
        request,
        workloadIds: request.workloadIds,
        cases: [
            {
                workloadId: 'RTC-B05',
                caseId: 'browser-data-channel-lifecycle',
                inputKey: 'iterations-25'
            }
        ],
        outerAttempts: [
            {
                workloadId: 'RTC-B05',
                caseId: 'browser-data-channel-lifecycle',
                inputKey: 'iterations-25',
                environmentId: 'E2-browser',
                intendedPhase: 'retained',
                outerOrdinal: 1,
                sampleIds: [sampleId]
            }
        ],
        expectedCohorts: [],
        repeatLink
    };
}

function toExternalAttempt(
    sample: RtcBaselineSampleDto,
    issues: readonly RtcBaselineIssueDto[]
): RtcBaselineExternalAttemptDto {
    return {
        schema: 'rallar.rtc-baseline.external-attempt.v1',
        locator: {
            workloadId: 'RTC-B05',
            caseId: 'browser-data-channel-lifecycle',
            inputKey: 'iterations-25',
            intendedPhase: 'retained',
            outerOrdinal: 1,
            environmentId: 'E2-browser',
            rawResultRelativePath: 'artifacts/staging/' +
                'rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001.json'
        },
        producerExitStatus: sample.outcome === 'passed' ? 0 : 1,
        producerFacts: {
            databaseUrl: 'absent',
            allScenariosPresent: false,
            allScenariosRaw: null,
            retentionSoakPresent: false,
            retentionSoakRaw: null,
            retentionCyclesPresent: false,
            retentionCyclesRaw: null,
            iceModePresent: false,
            iceModeRaw: null
        },
        sampleOutcomes: [{ identity: sample.identity, outcome: sample.outcome, issues }],
        samples: [sample],
        issues
    };
}

function toSummary(
    baselineId: string,
    sample: RtcBaselineSampleDto,
    repeatLink: RtcBaselineRepeatLinkDto | null
): RtcBaselineSummaryArtifactRecord {
    const partitioned = partitionRtcBaselineMetricObservations(
        computeRtcBaselineMetricObservations([sample], 'E2-browser')
    );
    if (!partitioned.ok) {
        throw new Error('Observation fixture metrics must have one consistent provenance group.');
    }
    return {
        schema: 'rallar.rtc-baseline.summary.v1',
        baselineId,
        workloadIds: ['RTC-B05'],
        environmentId: 'E2-browser',
        repeatLink,
        conditionalEnvironmentDecisions: [],
        sampleOutcomes: [{ identity: sample.identity, outcome: sample.outcome, issues: sample.issues }],
        cohortOutcomes: [],
        metricSummaries: summarizeRtcBaselineMetricPartitions(partitioned.value),
        rawReferences: []
    };
}

async function withChecksums(entries: ReadonlyMap<string, Uint8Array>) {
    const lines = await Promise.all(
        [...entries].sort(([left], [right]) => left.localeCompare(right)).map(
            async ([path, bytes]) => `${await sha256(bytes)}  ${path}`
        )
    );
    return new Map([...entries, ['SHA256SUMS', encoder.encode(`${lines.join('\n')}\n`)]]);
}

async function sha256(bytes: Uint8Array) {
    const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
    );
    return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function toJson(value: object) {
    return encoder.encode(JSON.stringify(value));
}
