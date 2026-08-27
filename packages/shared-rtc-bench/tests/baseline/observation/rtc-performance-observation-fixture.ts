import { computeRtcBaselineMetricObservations } from '../../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import type {
    RtcBaselineCaptureManifestDto,
    RtcBaselineEnvironmentDto,
    RtcBaselineExternalAttemptDto,
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
