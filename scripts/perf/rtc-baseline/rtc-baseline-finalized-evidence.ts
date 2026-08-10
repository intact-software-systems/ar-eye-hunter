import {
  canonicalizeRtcBaselineRawReferences,
  encodeRtcBaselineChecksumEntries,
} from './rtc-baseline-evidence-layout.ts';
import type { RtcBaselineCohortOutcomeRecord } from './rtc-baseline-evidence-layout.ts';
import {
  validateRtcBaselineCompleteAccounting,
  validateRtcBaselineArtifactReconciliation,
  validateRtcBaselineRetainedSampleObservations,
  validateRtcBaselineStoredArtifact,
} from './rtc-baseline-artifact-validation.ts';
import type {
  RtcBaselineCaptureManifestDto,
  RtcBaselineConditionalEnvironmentDecisionDto,
  RtcBaselineEnvironmentDto,
  RtcBaselineEnvironmentId,
  RtcBaselineExternalAttemptDto,
  RtcBaselineExternalCohortDto,
  RtcBaselineIssueDto,
  RtcBaselineRawReferenceDto,
  RtcBaselineRepeatLinkDto,
  RtcBaselineResult,
  RtcBaselineRuntimeObservationDto,
  RtcBaselineSampleDto,
  RtcBaselineSampleOutcomeDto,
  RtcBaselineWorkloadId,
} from './rtc-baseline-contracts.ts';
import type {
  RtcBaselineMetricObservation,
  RtcBaselineMetricPartition,
  RtcBaselineMetricSummary,
} from './rtc-baseline-statistics.ts';
import { summarizeRtcBaselineMetricPartitions } from './rtc-baseline-statistics.ts';
import {
  computeRtcBaselineExpectedSampleIdentities,
  computeRtcBaselineMetricObservations,
  projectRtcBaselineStoredOutcomes,
  validateRtcBaselineStoredOutcomeReconciliation,
} from './rtc-baseline-workload-manifest.ts';
import type {
  RtcBaselineFailureArtifact,
  RtcBaselineNotRunArtifact,
} from './rtc-baseline-failure-accounting.ts';

type Issue = RtcBaselineIssueDto;
type Result<T> = RtcBaselineResult<T>;
interface PersistedFinalizationFailure {
  schema: 'rallar.rtc-baseline.finalization-failure.v1';
  baselineId: string;
  failureId: string;
  issues: readonly Issue[];
  rawEvidence: null;
}
interface FinalizationFailureInput {
  baselineId: string;
  failureId: string;
  issues: Issue[];
}
export interface RtcBaselineFinalizationLockedWriter {
  publishSummary(
    baselineId: string,
    summaryBytes: Uint8Array,
    checksumBytes: Uint8Array,
  ): Promise<RtcBaselineResult<void>>;
  writeFinalizationFailure(
    baselineId: string,
    failure: PersistedFinalizationFailure,
  ): Promise<RtcBaselineResult<void>>;
}
export interface RtcBaselineFinalizationLockPort {
  withFinalizationLock<T>(
    baselineId: string,
    operation: (writer: RtcBaselineFinalizationLockedWriter) => Promise<RtcBaselineResult<T>>,
  ): Promise<RtcBaselineResult<T>>;
}
type MetricGrouping = Pick<
  RtcBaselineMetricObservation['grouping'],
  'workloadId' | 'caseId' | 'inputKey' | 'metric' | 'unit'
>;
export interface RtcBaselineFinalizedSummary {
  schema: 'rallar.rtc-baseline.summary.v1';
  baselineId: string;
  workloadIds: readonly RtcBaselineWorkloadId[];
  environmentId: RtcBaselineEnvironmentId;
  repeatLink: RtcBaselineRepeatLinkDto | null;
  conditionalEnvironmentDecisions: readonly RtcBaselineConditionalEnvironmentDecisionDto[];
  sampleOutcomes: readonly RtcBaselineSampleOutcomeDto[];
  cohortOutcomes: readonly RtcBaselineCohortOutcomeRecord[];
  metricSummaries: readonly (MetricGrouping & RtcBaselineMetricSummary)[];
  rawReferences: readonly RtcBaselineRawReferenceDto[];
}
export interface RtcBaselineCollectedSampleOutcome extends RtcBaselineSampleOutcomeDto {
  runtimeObservation?: RtcBaselineRuntimeObservationDto | null;
  rawReferences?: readonly RtcBaselineRawReferenceDto[];
}
export interface CollectedArtifacts {
  environment: Omit<RtcBaselineEnvironmentDto, 'observation'> & {
    observation: RtcBaselineRuntimeObservationDto;
  };
  manifest: RtcBaselineCaptureManifestDto;
  workloadIds: readonly RtcBaselineWorkloadId[];
  environmentId: RtcBaselineEnvironmentId;
  repeatLink: RtcBaselineRepeatLinkDto | null;
  conditionalEnvironmentDecisions: readonly RtcBaselineConditionalEnvironmentDecisionDto[];
  sampleOutcomes: readonly RtcBaselineCollectedSampleOutcome[];
  externalAttempts: readonly RtcBaselineExternalAttemptDto[];
  cohortOutcomes: readonly RtcBaselineExternalCohortDto[];
  failures: readonly (RtcBaselineFailureArtifact | RtcBaselineNotRunArtifact)[];
  samples: readonly RtcBaselineSampleDto[];
  retainedArtifacts: readonly { relativePath: string; bytes: Uint8Array }[];
}
interface Dependencies extends RtcBaselineFinalizationLockPort {
  collectArtifacts(baselineId: string): Promise<Result<CollectedArtifacts>>;
  validateCompleteAccounting(value: CollectedArtifacts): Issue[];
  validateReconciliation(value: CollectedArtifacts): Issue[];
  partitionMetricObservations(
    value: readonly RtcBaselineMetricObservation[],
  ): Result<RtcBaselineMetricPartition[]>;
  summarizeMetricValues(values: readonly number[]): RtcBaselineMetricSummary;
  readRawBytes(baselineId: string, relativePath: string): Promise<Result<Uint8Array>>;
  sha256(bytes: Uint8Array): Promise<string>;
}
export interface RtcBaselineFinalizedEvidence {
  finalize(input: { baselineId: string }): Promise<Result<RtcBaselineFinalizedSummary>>;
}
export function projectRtcBaselineFinalizedOutcomes(
  value: Pick<CollectedArtifacts, 'sampleOutcomes' | 'cohortOutcomes' | 'failures'>,
) {
  return projectRtcBaselineStoredOutcomes(value);
}

export function validateRtcBaselineCollectedArtifacts(
  value: CollectedArtifacts,
  baselineId: string,
) {
  const outcomes = projectRtcBaselineFinalizedOutcomes(value);
  return [
    ...validateRtcBaselineRetainedSampleObservations(value.environment.observation, value.samples),
    ...validateRtcBaselineStoredArtifact(value.environment),
    ...validateRtcBaselineStoredArtifact(value.manifest),
    ...value.samples.flatMap(validateRtcBaselineStoredArtifact),
    ...value.externalAttempts.flatMap(validateRtcBaselineStoredArtifact),
    ...value.cohortOutcomes.flatMap(validateRtcBaselineStoredArtifact),
    ...validateRtcBaselineArtifactReconciliation({
      baselineId,
      environment: value.environment,
      manifest: value.manifest,
      summary: {
        schema: 'rallar.rtc-baseline.summary.v1',
        baselineId: value.environment.baselineId,
        workloadIds: value.workloadIds,
        environmentId: value.environmentId,
        repeatLink: value.repeatLink,
        conditionalEnvironmentDecisions: value.conditionalEnvironmentDecisions,
        ...outcomes,
        metricSummaries: [],
        rawReferences: [],
      },
    }),
  ];
}

function issue(path: string, code: string, message: string): Issue {
  return { path, code, message };
}

export function createRtcBaselineFinalizedEvidence(
  dependencies: Dependencies,
): RtcBaselineFinalizedEvidence {
  async function fail(
    writer: RtcBaselineFinalizationLockedWriter,
    input: FinalizationFailureInput,
  ) {
    const persisted = await writer.writeFinalizationFailure(input.baselineId, {
      schema: 'rallar.rtc-baseline.finalization-failure.v1',
      baselineId: input.baselineId,
      failureId: input.failureId,
      issues: input.issues,
      rawEvidence: null,
    });
    return {
      ok: false as const,
      issues: persisted.ok ? input.issues : [...input.issues, ...persisted.issues],
    };
  }

  async function finalizeLocked(
    writer: RtcBaselineFinalizationLockedWriter,
    input: { baselineId: string },
  ) {
    const failWith = (failureId: string, issues: Issue[]) =>
      fail(writer, { baselineId: input.baselineId, failureId, issues });
    const collected = await dependencies.collectArtifacts(input.baselineId);
    if (!collected.ok) return failWith('finalization-artifact-collection', collected.issues);
    const artifactIssues = validateRtcBaselineCollectedArtifacts(collected.value, input.baselineId);
    if (artifactIssues.length > 0)
      return failWith('finalization-artifact-validation', artifactIssues);
    const outcomes = projectRtcBaselineFinalizedOutcomes(collected.value);
    const accounting = [
      ...validateRtcBaselineCompleteAccounting({
        expectedSamples: computeRtcBaselineExpectedSampleIdentities(collected.value.manifest),
        expectedCohorts: collected.value.manifest.expectedCohorts,
        ...outcomes,
      }),
      ...dependencies.validateCompleteAccounting(collected.value),
    ];
    if (accounting.length > 0) return failWith('finalization-accounting', accounting);
    const reconciliation = dependencies.validateReconciliation(collected.value);
    if (reconciliation.length > 0) return failWith('finalization-reconciliation', reconciliation);
    const partitioned = dependencies.partitionMetricObservations(
      computeRtcBaselineMetricObservations(collected.value.samples, collected.value.environmentId),
    );
    if (!partitioned.ok) return failWith('finalization-statistics', partitioned.issues);
    const metricSummaries = summarizeRtcBaselineMetricPartitions(
      partitioned.value,
      dependencies.summarizeMetricValues,
    );
    const canonicalRaw = canonicalizeRtcBaselineRawReferences(
      collected.value.samples.flatMap((sample) => sample.rawReferences),
    );
    if (!canonicalRaw.ok) return failWith('finalization-raw-reference', canonicalRaw.issues);
    const rawReferences = canonicalRaw.value;
    const retainedRawArtifacts: Array<{ relativePath: string; bytes: Uint8Array }> = [];
    for (let index = 0; index < rawReferences.length; index += 1) {
      const reference = rawReferences[index];
      const bytes = await dependencies.readRawBytes(input.baselineId, reference.relativePath);
      if (!bytes.ok) return failWith('finalization-raw-reference', bytes.issues);
      const issues: Issue[] = [];
      if (bytes.value.byteLength !== reference.bytes) {
        issues.push(
          issue(
            `$.rawReferences[${index}].bytes`,
            'raw-byte-length-mismatch',
            'Raw reference byte length differs from stored bytes.',
          ),
        );
      }
      let digest: string;
      try {
        digest = await dependencies.sha256(bytes.value);
      } catch (error) {
        return failWith('finalization-raw-reference', [
          issue(
            `$.rawReferences[${index}].sha256`,
            'hash-failed',
            error instanceof Error ? error.message : String(error),
          ),
        ]);
      }
      if (digest !== reference.sha256) {
        issues.push(
          issue(
            `$.rawReferences[${index}].sha256`,
            'raw-sha256-mismatch',
            'Raw reference SHA-256 differs from stored bytes.',
          ),
        );
      }
      if (issues.length > 0) return failWith('finalization-raw-reference', issues);
      retainedRawArtifacts.push({ relativePath: reference.relativePath, bytes: bytes.value });
    }
    const summary = {
      schema: 'rallar.rtc-baseline.summary.v1' as const,
      baselineId: input.baselineId,
      workloadIds: collected.value.workloadIds,
      environmentId: collected.value.environmentId,
      repeatLink: collected.value.repeatLink,
      conditionalEnvironmentDecisions: collected.value.conditionalEnvironmentDecisions,
      ...outcomes,
      metricSummaries,
      rawReferences,
    };
    const outcomeIssues = validateRtcBaselineStoredOutcomeReconciliation({
      sampleOutcomes: collected.value.sampleOutcomes,
      samples: collected.value.samples,
      cohorts: collected.value.cohortOutcomes,
      failures: collected.value.failures,
      summary,
    });
    if (outcomeIssues.length > 0) return failWith('finalization-reconciliation', outcomeIssues);
    const summaryBytes = new TextEncoder().encode(JSON.stringify(summary));
    const checksumEntries = [];
    try {
      for (const artifact of [...collected.value.retainedArtifacts, ...retainedRawArtifacts]) {
        checksumEntries.push({
          sha256: await dependencies.sha256(artifact.bytes),
          relativePath: artifact.relativePath,
        });
      }
      checksumEntries.push({
        sha256: await dependencies.sha256(summaryBytes),
        relativePath: 'summary.json',
      });
    } catch (error) {
      return failWith('finalization-summary-publication', [
        issue('$.summary', 'hash-failed', error instanceof Error ? error.message : String(error)),
      ]);
    }
    const checksumBytes = encodeRtcBaselineChecksumEntries(checksumEntries);
    const published = await writer.publishSummary(input.baselineId, summaryBytes, checksumBytes);
    if (!published.ok) {
      return failWith('finalization-summary-publication', published.issues);
    }
    return { ok: true as const, value: summary };
  }

  function finalize(input: { baselineId: string }) {
    return dependencies.withFinalizationLock(input.baselineId, (writer) =>
      finalizeLocked(writer, input),
    );
  }

  return { finalize };
}
