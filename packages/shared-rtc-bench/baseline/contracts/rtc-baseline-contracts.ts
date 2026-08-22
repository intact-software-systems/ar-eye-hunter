export const RTC_BASELINE_SCHEMA = 'rallar.rtc-baseline.v1' as const;

export type RtcBaselineWorkloadId = 'RTC-B01' | 'RTC-B02' | 'RTC-B03' | 'RTC-B04' | 'RTC-B05' | 'RTC-B06';
export type RtcBaselineEnvironmentId = 'E1-local' | 'E2-browser' | 'E3-memory' | 'E4-pg' | 'E5-remote';
export interface RtcBaselineIssueDto {
    path: string;
    code: string;
    message: string;
    details?: RtcBaselineJson;
}
export function rtcBaselineIssue(path: string, code: string, message: string): RtcBaselineIssueDto {
    return { path, code, message };
}
export interface RtcBaselineSuccess<T> {
    ok: true;
    value: T;
}
export interface RtcBaselineFailure {
    ok: false;
    issues: RtcBaselineIssueDto[];
}
export type RtcBaselineResult<T> = RtcBaselineSuccess<T> | RtcBaselineFailure;
export function validateRtcBaselineDecoded<T>(
    decoded: RtcBaselineResult<T>,
    validate: (value: T) => readonly RtcBaselineIssueDto[]
): RtcBaselineResult<T> {
    if (!decoded.ok) {
        return decoded;
    }
    const issues = validate(decoded.value);
    return issues.length > 0 ? { ok: false, issues: [...issues] } : decoded;
}
export type RtcBaselineJson =
    | null
    | boolean
    | number
    | string
    | RtcBaselineJson[]
    | {
        [key: string]: RtcBaselineJson;
    };
type GuardedJson<T extends object> = RtcBaselineJson | T;
function hasRtcBaselineSchema(value: RtcBaselineJson | object, schema: string) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    return Reflect.get(value, 'schema') === schema;
}

export interface RtcBaselineCaseKeyDto {
    workloadId: RtcBaselineWorkloadId;
    caseId: string;
    inputKey: string;
}

export interface RtcBaselineConditionalEnvironmentDecisionDto {
    environmentId: RtcBaselineEnvironmentId;
    decision: 'required' | 'not-required';
    reason: string;
}

export interface RtcBaselineRepeatLinkDto {
    primaryBaselineId: string;
    primarySummarySha256: string;
}

export interface RtcBaselineCaptureRequestDto {
    schema: 'rallar.rtc-baseline.capture-request.v1';
    baselineId: string;
    workloadIds: readonly RtcBaselineWorkloadId[];
    environmentId: RtcBaselineEnvironmentId;
    retainedSampleMultiplier: 1 | 2;
    repeatLink: RtcBaselineRepeatLinkDto | null;
    conditionalEnvironmentDecisions: readonly RtcBaselineConditionalEnvironmentDecisionDto[];
}

export interface RtcBaselineSampleIdentityDto extends RtcBaselineCaseKeyDto {
    sampleId: string;
    intendedPhase: 'warmup' | 'retained';
    outerOrdinal: number;
    innerOrdinal: number;
}

export interface RtcBaselineCohortIdentityDto {
    cohortId: string;
    workloadId: RtcBaselineWorkloadId;
    memberSampleIds: readonly string[];
}

export interface RtcBaselineOuterAttemptDto extends RtcBaselineCaseKeyDto {
    environmentId: RtcBaselineEnvironmentId;
    intendedPhase: 'warmup' | 'retained';
    outerOrdinal: number;
    sampleIds: readonly string[];
}

export interface RtcBaselineAttemptLocatorDto extends RtcBaselineCaseKeyDto {
    environmentId: RtcBaselineEnvironmentId;
    intendedPhase: 'warmup' | 'retained';
    outerOrdinal: number;
    rawResultRelativePath: string;
}

export interface RtcBaselineAttemptInputLocatorDto extends RtcBaselineCaseKeyDto {
    intendedPhase: 'warmup' | 'retained';
    outerOrdinal: number;
}

export interface RtcBaselineCaptureWorkloadInputDto {
    baselineId: string;
    workloadId: RtcBaselineWorkloadId;
}

export interface RtcBaselineRecordAttemptInputDto {
    baselineId: string;
    locator: RtcBaselineAttemptInputLocatorDto;
    producerExitStatus: number;
    rawResultRelativePath: string;
}

export interface RtcBaselineRecordCohortInputDto {
    baselineId: string;
    workloadId: RtcBaselineWorkloadId;
    cohortId: string;
    producerExitStatus: number;
    rawResultRelativePath: string;
}

export interface RtcBaselineInitializeAcceptanceInputDto {
    request: RtcBaselineCaptureRequestDto;
    runtimeObservation: RtcBaselineRuntimeObservationDto;
}

export interface RtcBaselineCaptureManifestDto {
    schema: 'rallar.rtc-baseline.manifest.v1';
    request: RtcBaselineCaptureRequestDto;
    workloadIds: readonly RtcBaselineWorkloadId[];
    cases: readonly RtcBaselineCaseKeyDto[];
    outerAttempts: readonly RtcBaselineOuterAttemptDto[];
    expectedCohorts: readonly RtcBaselineCohortIdentityDto[];
    repeatLink: RtcBaselineRepeatLinkDto | null;
}

export function isRtcBaselineCaptureManifestDto(
    value: GuardedJson<RtcBaselineCaptureManifestDto>
): value is RtcBaselineCaptureManifestDto {
    return hasRtcBaselineSchema(value, 'rallar.rtc-baseline.manifest.v1');
}

export interface RtcBaselineConfigurationFieldDescriptorDto {
    caseKey: RtcBaselineCaseKeyDto;
    field: string;
    flag: string;
    scalarKind: 'boolean' | 'nonnegative-integer' | 'string';
    defaultValue: boolean | number | string;
    allowlistedEnvironmentVariable: string | null;
    environmentUnsetBehavior: 'reject' | 'use-default' | null;
}

export interface RtcBaselineResolvedConfigurationValueDto {
    caseKey: RtcBaselineCaseKeyDto;
    field: string;
    value: boolean | number | string;
    source: 'default' | 'environment' | 'controller' | 'cli';
}

export interface RtcBaselineControllerInputDto {
    name: string;
    value: boolean | number | string | null;
    secret: boolean;
}

export interface RtcBaselineWorkerCommandDto {
    redactedArgv: { executable: string; arguments: readonly string[]; };
    projection: { fixedWorkerFlags: readonly string[]; configurationFlags: readonly string[]; };
}

export interface RtcBaselineRuntimeObservationDto {
    git: { headCommit: string; headTree: string; ref: string; clean: boolean; };
    runtime: {
        node: string;
        npm: string;
        deno: string;
        playwright: string;
        chromium: string;
    };
    host: {
        os: string;
        kernel: string;
        architecture: string;
        logicalCpuCount: number;
        cpuModel: string;
        totalMemoryBytes: number;
        executionContext: 'local' | 'distributed';
    };
    timing: {
        startedAtUtc: string;
        endedAtUtc: string;
        monotonicDurationMs: number;
        monotonicSource: string;
    };
    deviations: readonly string[];
    sourceHashes: readonly { path: string; sha256: string; kind: 'source' | 'config'; }[];
    configurationInputs: readonly RtcBaselineControllerInputDto[];
    resolvedConfiguration: readonly RtcBaselineResolvedConfigurationValueDto[];
    controllerInputs: readonly RtcBaselineControllerInputDto[];
    workerCommand: RtcBaselineWorkerCommandDto;
    allowlistedEnvironment: Readonly<Record<string, string>>;
}

export interface RtcBaselineRawReferenceDto {
    relativePath: string;
    sha256: string;
    bytes: number;
}

export interface RtcBaselineSampleDto {
    schema: 'rallar.rtc-baseline.sample.v1';
    identity: RtcBaselineSampleIdentityDto;
    outcome: 'passed' | 'failed' | 'not-run';
    evidenceClass: 'synthetic-path' | 'native-browser' | 'local-full-stack';
    metrics: readonly { metric: string; unit: string; value: number; }[];
    rawEvidence: RtcBaselineJson;
    rawReferences: readonly RtcBaselineRawReferenceDto[];
    issues: readonly RtcBaselineIssueDto[];
    runtimeObservation: RtcBaselineRuntimeObservationDto | null;
}

export interface RtcBaselineSampleOutcomeDto {
    identity: RtcBaselineSampleIdentityDto;
    outcome: 'passed' | 'failed' | 'not-run';
    issues: readonly RtcBaselineIssueDto[];
}

export function isRtcBaselineSampleDto(
    value: GuardedJson<RtcBaselineSampleDto | RtcBaselineSampleOutcomeDto>
): value is RtcBaselineSampleDto {
    return hasRtcBaselineSchema(value, 'rallar.rtc-baseline.sample.v1');
}

export function isRtcBaselineObservedSampleDto(
    value: GuardedJson<RtcBaselineSampleDto | RtcBaselineSampleOutcomeDto>
): value is RtcBaselineSampleDto & { runtimeObservation: RtcBaselineRuntimeObservationDto; } {
    return isRtcBaselineSampleDto(value) && value.runtimeObservation !== null;
}

export interface RtcBaselineExternalAttemptDto {
    schema: 'rallar.rtc-baseline.external-attempt.v1';
    locator: RtcBaselineAttemptLocatorDto;
    producerExitStatus: number;
    producerFacts: {
        databaseUrl: 'present' | 'absent';
        allScenariosPresent: boolean;
        allScenariosRaw: string | null;
        retentionSoakPresent: boolean;
        retentionSoakRaw: string | null;
        retentionCyclesPresent: boolean;
        retentionCyclesRaw: string | null;
        iceModePresent: boolean;
        iceModeRaw: string | null;
    };
    sampleOutcomes: readonly RtcBaselineSampleOutcomeDto[];
    samples: readonly RtcBaselineSampleDto[];
    issues: readonly RtcBaselineIssueDto[];
}

export function isRtcBaselineExternalAttemptDto(
    value: GuardedJson<RtcBaselineExternalAttemptDto>
): value is RtcBaselineExternalAttemptDto {
    return hasRtcBaselineSchema(value, 'rallar.rtc-baseline.external-attempt.v1');
}

export interface RtcBaselineExternalCohortDto {
    schema: 'rallar.rtc-baseline.external-cohort.v1';
    identity: RtcBaselineCohortIdentityDto;
    outcome: 'passed' | 'failed';
    rawEvidence: RtcBaselineJson;
    issues: readonly RtcBaselineIssueDto[];
    samples: readonly RtcBaselineSampleDto[];
}

export function isRtcBaselineExternalCohortDto(
    value: GuardedJson<RtcBaselineExternalCohortDto>
): value is RtcBaselineExternalCohortDto {
    return hasRtcBaselineSchema(value, 'rallar.rtc-baseline.external-cohort.v1');
}

export interface RtcBaselineEnvironmentDto {
    schema: 'rallar.rtc-baseline.environment.v1';
    baselineId: string;
    workloadIds: readonly RtcBaselineWorkloadId[];
    environmentId: RtcBaselineEnvironmentId;
    repeatLink: RtcBaselineRepeatLinkDto | null;
    conditionalEnvironmentDecisions: readonly RtcBaselineConditionalEnvironmentDecisionDto[];
    observation: RtcBaselineRuntimeObservationDto | null;
}

export function isRtcBaselineEnvironmentDto(
    value: GuardedJson<RtcBaselineEnvironmentDto>
): value is RtcBaselineEnvironmentDto {
    return hasRtcBaselineSchema(value, 'rallar.rtc-baseline.environment.v1');
}

export interface RtcBaselineFinalizationFailureDto {
    schema: 'rallar.rtc-baseline.finalization-failure.v1';
    baselineId: string;
    failureId: string;
    issues: readonly RtcBaselineIssueDto[];
    rawEvidence: RtcBaselineJson;
}

export interface RtcBaselineFailureArtifact {
    artifactKind: 'failure';
    failureId: string;
    identity: RtcBaselineSampleIdentityDto | RtcBaselineCohortIdentityDto;
    outcome: 'failed';
    causalFailureId: null;
    issues: readonly RtcBaselineIssueDto[];
    rawEvidence: RtcBaselineJson;
}

export interface RtcBaselineNotRunArtifact {
    artifactKind: 'not-run';
    failureId: string;
    identity: RtcBaselineSampleIdentityDto;
    outcome: 'not-run';
    causalFailureId: string;
    issues: readonly RtcBaselineIssueDto[];
    rawEvidence: null;
}
export const RTC_BASELINE_CAUSAL_NOT_RUN_ISSUE = rtcBaselineIssue(
    '$',
    'causal-not-run',
    'Not run after the first workload correctness failure.'
);

export const RTC_BASELINE_FAILURE_ARTIFACT_FIELDS: readonly string[] = [
    'artifactKind',
    'failureId',
    'identity',
    'outcome',
    'causalFailureId',
    'issues',
    'rawEvidence'
];

export const RTC_BASELINE_ACCEPTED_ARTIFACT_DIRECTORIES = [
    'results',
    'results/samples',
    'results/external-attempts',
    'results/external-cohorts',
    'results/failures',
    'results/finalization-failures'
] as const;

export interface RtcBaselineSampleFailureOwner {
    kind: 'sample';
    identity: RtcBaselineSampleIdentityDto;
}
export type RtcBaselineFailureOwner = RtcBaselineSampleFailureOwner | {
    kind: 'cohort';
    identity: RtcBaselineCohortIdentityDto;
};
export type RtcBaselineFailureOutcomeArtifact = RtcBaselineFailureArtifact | RtcBaselineNotRunArtifact;
export type RtcBaselineSampleFailureOutcomeArtifact = RtcBaselineFailureOutcomeArtifact & {
    identity: RtcBaselineSampleIdentityDto;
};
export type RtcBaselineFailureOutcomeDecodingResult = RtcBaselineResult<RtcBaselineFailureOutcomeArtifact>;
export interface RtcBaselineFailureSequenceInput {
    manifest?: RtcBaselineCaptureManifestDto;
    owner: RtcBaselineFailureOwner;
    issues: readonly RtcBaselineIssueDto[];
    rawEvidence: RtcBaselineJson;
}
export type RtcBaselineAcceptedArtifact =
    | RtcBaselineSampleDto
    | RtcBaselineExternalAttemptDto
    | RtcBaselineExternalCohortDto
    | RtcBaselineFinalizationFailureDto
    | RtcBaselineFailureOutcomeArtifact;

export function isRtcBaselineFinalizationFailureDto(
    value: GuardedJson<RtcBaselineFinalizationFailureDto>
): value is RtcBaselineFinalizationFailureDto {
    return hasRtcBaselineSchema(value, 'rallar.rtc-baseline.finalization-failure.v1');
}

export interface RtcBaselineSummaryDto {
    schema: 'rallar.rtc-baseline.summary.v1';
    baselineId: string;
    workloadIds: readonly RtcBaselineWorkloadId[];
    environmentId: RtcBaselineEnvironmentId;
    repeatLink: RtcBaselineRepeatLinkDto | null;
    conditionalEnvironmentDecisions: readonly RtcBaselineConditionalEnvironmentDecisionDto[];
    sampleOutcomes: readonly RtcBaselineJson[];
    cohortOutcomes: readonly RtcBaselineJson[];
    metricSummaries: readonly RtcBaselineJson[];
    rawReferences: readonly RtcBaselineRawReferenceDto[];
}
