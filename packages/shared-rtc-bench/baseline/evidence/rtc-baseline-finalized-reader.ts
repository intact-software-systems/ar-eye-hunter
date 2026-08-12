import { decodeRtcBaselineStoredJson } from '../contracts/rtc-baseline-artifact-decoding.ts';
import {
  RTC_BASELINE_CHECKSUM_FILE,
  RTC_BASELINE_SUMMARY_FILE,
  classifyRtcBaselineArtifactPath,
  inspectRtcBaselineChecksumEntries,
  inspectRtcBaselineStoredArtifactBytes,
  validateRtcBaselineChecksumMembership,
  validateRtcBaselineRawArtifactIntegrity,
  validateRtcBaselineRawArtifactMembership,
  validateRtcBaselineRepeatLinkIdentity,
  validateRtcBaselineRepeatPrimaryDigest,
  type RtcBaselineReaderInput as BaselineInput,
  type RtcBaselineComparisonChoice,
  type RtcBaselineComparisonChoiceInput as ComparisonChoiceInput,
  type RtcBaselineFinalizedArtifactValidation,
  type RtcBaselineFinalizedReader as RtcBaselineFinalizedReaderContract,
  type RtcBaselineFinalizedReaderDependencies,
  type RtcBaselinePairedComparison,
  type RtcBaselinePairedComparisonInput,
  type RtcBaselineRepeatRequirement as RepeatRequirement,
  type RtcBaselineSummaryArtifactRecord,
  type RtcBaselineVerifiedArtifacts as VerifiedArtifacts,
  type RtcBaselineVerifiedRepeatPrimary as RepeatPrimary,
  type RtcBaselineVerifiedStoredArtifact,
} from './rtc-baseline-evidence-layout.ts';
import {
  compareRtcBaselinePersistedMetrics,
  evaluateRtcBaselineWorkloadRepeatOutcome,
  partitionRtcBaselineMetricObservations,
  rtcBaselineTriggeredWorkloads,
  summarizeRtcBaselineMetricPartitions,
  validateRtcBaselinePersistedMetricSummaries,
} from './rtc-baseline-statistics.ts';
import {
  computeRtcBaselineExpectedSampleIdentities,
  computeRtcBaselineMetricObservations,
  createRtcBaselineExternalAttemptReader,
  validateRtcBaselineStoredOutcomeReconciliation,
} from '../catalog/rtc-baseline-workload-manifest.ts';
import type {
  RtcBaselineCaptureManifestDto,
  RtcBaselineEnvironmentDto,
  RtcBaselineExternalCohortDto,
  RtcBaselineIssueDto as Issue,
  RtcBaselineResult as Result,
  RtcBaselineSampleDto,
} from '../contracts/rtc-baseline-contracts.ts';
import {
  validateRtcBaselineCompleteAccounting,
  validateRtcBaselineArtifactReconciliation,
  validateRtcBaselinePassingSummary,
  validateRtcBaselineRetainedSampleObservations,
  validateRtcBaselineStoredArtifact,
} from '../contracts/rtc-baseline-artifact-validation.ts';
import {
  decodeRtcBaselineFailureOutcome,
  type RtcBaselineFailureOutcomeArtifact,
} from '../acceptance/rtc-baseline-failure-accounting.ts';
export type { RtcBaselineFinalizedArtifactValidation } from './rtc-baseline-evidence-layout.ts';
export type RtcBaselineFinalizedReader = RtcBaselineFinalizedReaderContract;
export type {
  RtcBaselinePairedComparison,
  RtcBaselineRepeatRequirement,
  RtcBaselineVerifiedRepeatPrimary,
} from './rtc-baseline-evidence-layout.ts';
const issue = (path: string, code: string, message: string): Issue => ({ path, code, message });
function failed(path: string, code: string, message: string): Result<never> {
  return { ok: false, issues: [issue(path, code, message)] };
}
export function createRtcBaselineFinalizedReader(
  dependencies: RtcBaselineFinalizedReaderDependencies,
): RtcBaselineFinalizedReader {
  async function readRtcBaselineVerifiedStoredArtifact(
    baselineId: string,
    relativePath: string,
    expectedSha256: string,
  ): Promise<Result<RtcBaselineVerifiedStoredArtifact>> {
    const bytes = await dependencies.readBytes(baselineId, relativePath);
    if (!bytes.ok) return bytes;
    if ((await dependencies.sha256(bytes.value)) !== expectedSha256)
      return failed(
        `$.${relativePath}`,
        'checksum-mismatch',
        'Stored bytes do not match the SHA-256 checksum.',
      );
    return inspectRtcBaselineStoredArtifactBytes({ relativePath, bytes: bytes.value });
  }
  async function validateRtcBaselineVerifiedRepeatLink(
    baselineId: string,
    summary: RtcBaselineSummaryArtifactRecord,
  ): Promise<Result<void>> {
    const identity = validateRtcBaselineRepeatLinkIdentity(baselineId, summary.repeatLink);
    if (!identity.ok || summary.repeatLink === null) return identity;
    const primaryId = summary.repeatLink.primaryBaselineId;
    const checksumBytes = await dependencies.readBytes(primaryId, RTC_BASELINE_CHECKSUM_FILE);
    if (!checksumBytes.ok) return checksumBytes;
    const checksums = inspectRtcBaselineChecksumEntries(checksumBytes.value);
    if (checksums.issues.length > 0) return { ok: false, issues: checksums.issues };
    const checksum = validateRtcBaselineRepeatPrimaryDigest({
      summary,
      sha256: checksums.entries.get(RTC_BASELINE_SUMMARY_FILE) ?? '',
      source: 'checksum',
    });
    if (!checksum.ok) return checksum;
    const primaryBytes = await dependencies.readBytes(primaryId, RTC_BASELINE_SUMMARY_FILE);
    if (!primaryBytes.ok) return primaryBytes;
    return validateRtcBaselineRepeatPrimaryDigest({
      summary,
      sha256: await dependencies.sha256(primaryBytes.value),
      source: 'summary-bytes',
    });
  }
  const validateRepeatLink = validateRtcBaselineVerifiedRepeatLink;
  const readExternalAttempts = createRtcBaselineExternalAttemptReader(dependencies.readJson);
  async function readVerifiedArtifacts(input: BaselineInput): Promise<Result<VerifiedArtifacts>> {
    const checksumBytes = await dependencies.readBytes(input.baselineId, 'SHA256SUMS');
    if (!checksumBytes.ok) return checksumBytes;
    const listed = await dependencies.listArtifactPaths(input.baselineId);
    if (!listed.ok) return listed;
    const retainedPaths = [...listed.value].sort();
    const { entries, issues } = inspectRtcBaselineChecksumEntries(checksumBytes.value);
    let environment: RtcBaselineEnvironmentDto | undefined;
    let manifest: RtcBaselineCaptureManifestDto | undefined;
    let summary: RtcBaselineSummaryArtifactRecord | undefined;
    const cohorts: RtcBaselineExternalCohortDto[] = [];
    const failures: RtcBaselineFailureOutcomeArtifact[] = [];
    const retained = new Map<string, RtcBaselineSampleDto>();
    const retain = (sample: RtcBaselineSampleDto) => {
      const existing = retained.get(sample.identity.sampleId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(sample))
        issues.push(issue('$.samples', 'conflicting-sample', 'Duplicate sample bodies differ.'));
      else retained.set(sample.identity.sampleId, sample);
    };
    issues.push(...validateRtcBaselineChecksumMembership(retainedPaths, entries));
    for (const path of retainedPaths) {
      const expected = entries.get(path);
      if (!expected) continue;
      const stored = await readRtcBaselineVerifiedStoredArtifact(input.baselineId, path, expected);
      if (!stored.ok) issues.push(...stored.issues);
      else if (stored.value.kind && stored.value.json !== null) {
        const decoded = decodeRtcBaselineStoredJson(stored.value.kind, stored.value.json);
        if (!decoded.ok) issues.push(...decoded.issues);
        else {
          issues.push(...validateRtcBaselineStoredArtifact(decoded.value));
          if (decoded.value.schema === 'rallar.rtc-baseline.environment.v1')
            environment = decoded.value;
          if (decoded.value.schema === 'rallar.rtc-baseline.manifest.v1') manifest = decoded.value;
          if (decoded.value.schema === 'rallar.rtc-baseline.summary.v1') summary = decoded.value;
          if (decoded.value.schema === 'rallar.rtc-baseline.sample.v1') retain(decoded.value);
          if (
            decoded.value.schema === 'rallar.rtc-baseline.external-attempt.v1' ||
            decoded.value.schema === 'rallar.rtc-baseline.external-cohort.v1'
          )
            decoded.value.samples.forEach(retain);
          if (decoded.value.schema === 'rallar.rtc-baseline.external-cohort.v1')
            cohorts.push(decoded.value);
        }
      } else if (classifyRtcBaselineArtifactPath(path) === 'failure-outcome') {
        const decoded = decodeRtcBaselineFailureOutcome(stored.value.json, path);
        if (decoded.ok) failures.push(decoded.value);
        else issues.push(...decoded.issues);
      }
    }
    const samples = [...retained.values()];
    if (manifest && summary) {
      issues.push(
        ...validateRtcBaselineCompleteAccounting({
          expectedSamples: computeRtcBaselineExpectedSampleIdentities(manifest),
          expectedCohorts: manifest.expectedCohorts,
          sampleOutcomes: summary.sampleOutcomes,
          cohortOutcomes: summary.cohortOutcomes,
        }),
      );
      const partitioned = partitionRtcBaselineMetricObservations(
        computeRtcBaselineMetricObservations(samples, manifest.request.environmentId),
      );
      if (!partitioned.ok) issues.push(...partitioned.issues);
      else {
        const expected = summarizeRtcBaselineMetricPartitions(partitioned.value);
        issues.push(
          ...validateRtcBaselinePersistedMetricSummaries(expected, summary.metricSummaries),
        );
      }
      issues.push(
        ...validateRtcBaselineStoredOutcomeReconciliation({
          sampleOutcomes: samples,
          samples,
          cohorts,
          failures,
          summary,
        }),
      );
      issues.push(...validateRtcBaselinePassingSummary(summary));
    }
    if (environment && manifest && summary) {
      issues.push(
        ...validateRtcBaselineArtifactReconciliation({
          baselineId: input.baselineId,
          environment,
          manifest,
          summary,
        }),
      );
    }
    if (environment)
      issues.push(
        ...validateRtcBaselineRetainedSampleObservations(environment.observation, samples),
      );
    if (summary) {
      issues.push(
        ...validateRtcBaselineRawArtifactMembership({
          retainedArtifactPaths: retainedPaths,
          rawReferencePaths: summary.rawReferences.map((reference) => reference.relativePath),
        }),
        ...validateRtcBaselineRawArtifactIntegrity({
          rawReferences: summary.rawReferences,
          checksumEntries: entries,
        }),
      );
    }
    if (issues.length > 0) return { ok: false as const, issues };
    const summarySha256 = entries.get('summary.json');
    if (!environment || !manifest || !summary || !summarySha256)
      return failed(
        '$.retainedArtifactPaths',
        'missing-finalized-artifact',
        'Environment, manifest, summary, and summary checksum are required.',
      );
    return {
      ok: true,
      value: {
        environment,
        manifest,
        summary,
        summarySha256,
        validation: {
          baselineId: input.baselineId,
          retainedArtifactPaths: retainedPaths,
          checksumEntryCount: entries.size,
        },
      },
    };
  }
  async function readBaselineValidation(input: BaselineInput) {
    const verified = await readVerifiedArtifacts(input);
    if (!verified.ok) return verified;
    const linked = await validateRepeatLink(input.baselineId, verified.value.summary);
    return linked.ok ? { ok: true as const, value: verified.value.validation } : linked;
  }
  async function readVerifiedRepeatPrimary(input: BaselineInput): Promise<Result<RepeatPrimary>> {
    const verified = await readVerifiedArtifacts(input);
    if (!verified.ok) return verified;
    if (
      input.baselineId.endsWith('-repeat-01') ||
      verified.value.environment.repeatLink !== null ||
      verified.value.manifest.repeatLink !== null
    )
      return failed(
        '$.baselineId',
        'invalid-repeat-primary',
        'A repeat primary must be an unlinked non-repeat finalized baseline.',
      );
    return {
      ok: true as const,
      value: {
        environment: verified.value.environment,
        manifest: verified.value.manifest,
        summarySha256: verified.value.summarySha256,
        triggeredWorkloadIds: rtcBaselineTriggeredWorkloads(verified.value),
      },
    };
  }
  async function readRepeatRequirement(input: BaselineInput): Promise<Result<RepeatRequirement>> {
    const validated = await readVerifiedArtifacts(input);
    if (!validated.ok) return validated;
    const summary = validated.value.summary;
    const linked = await validateRepeatLink(input.baselineId, summary);
    if (!linked.ok) return linked;
    const workloadIds = rtcBaselineTriggeredWorkloads(validated.value);
    if (summary.repeatLink !== null && workloadIds.length > 0)
      return failed(
        '$.metricSummaries',
        'repeat-still-noisy',
        'Controlled repeat remains above its coefficient-of-variation threshold.',
      );
    return { ok: true as const, value: { workloadIds } };
  }
  async function comparisonChoice(input: ComparisonChoiceInput) {
    const { primaryBaselineId, comparisonBaselineId, inputPath, workloadId } = input;
    const primary = await readVerifiedArtifacts({ baselineId: primaryBaselineId });
    if (!primary.ok) return primary;
    const repeatRequired = rtcBaselineTriggeredWorkloads(primary.value).includes(workloadId);
    const selectedId = repeatRequired ? `${primaryBaselineId}-repeat-01` : primaryBaselineId;
    if (comparisonBaselineId !== selectedId) {
      return failed(
        inputPath,
        'invalid-comparison-baseline',
        repeatRequired
          ? 'A noisy primary requires its exact -repeat-01 baseline.'
          : 'A stable primary must compare from itself.',
      );
    }
    const selected =
      selectedId === primaryBaselineId
        ? primary
        : await readVerifiedArtifacts({ baselineId: selectedId });
    if (!selected.ok) return selected;
    const linked = await validateRepeatLink(selectedId, selected.value.summary);
    if (!linked.ok) return linked;
    const context = primary.value.environment.observation?.host.executionContext;
    const repeatEvaluation =
      context === undefined
        ? { ok: true as const, value: { repeatRequired: false, stillNoisy: false } }
        : evaluateRtcBaselineWorkloadRepeatOutcome({
            primaryMetrics: primary.value.summary.metricSummaries,
            repeatMetrics: selected.value.summary.metricSummaries,
            workloadId,
            executionContext: context,
          });
    if (!repeatEvaluation.ok) return repeatEvaluation;
    const environment = selected.value.environment;
    if (environment.observation === null)
      return failed(
        '$.environment.observation',
        'missing-runtime-observation',
        'Comparison baselines require a runtime observation.',
      );
    return {
      ok: true as const,
      value: {
        primary: primary.value.summary,
        selected: selected.value.summary,
        selectedId,
        repeatRequired,
        stillNoisy: repeatEvaluation.value.stillNoisy,
        environment: { ...environment, observation: environment.observation },
      },
    };
  }
  async function readPairedComparison(
    input: RtcBaselinePairedComparisonInput,
  ): Promise<Result<RtcBaselinePairedComparison>> {
    const primary = await comparisonChoice({
      primaryBaselineId: input.primaryBaselineId,
      comparisonBaselineId: input.primaryComparisonCohortId,
      inputPath: '$.primaryComparisonCohortId',
      workloadId: input.workloadId,
    });
    if (!primary.ok) return primary;
    const candidate = await comparisonChoice({
      primaryBaselineId: input.candidateBaselineId,
      comparisonBaselineId: input.candidateComparisonCohortId,
      inputPath: '$.candidateComparisonCohortId',
      workloadId: input.workloadId,
    });
    if (!candidate.ok) return candidate;
    const compared = compareRtcBaselinePersistedMetrics({
      baselineEnvironment: primary.value.environment,
      candidateEnvironment: candidate.value.environment,
      baselineMetrics: primary.value.selected.metricSummaries,
      candidateMetrics: candidate.value.selected.metricSummaries,
      workloadId: input.workloadId,
    });
    if (!compared.ok) return compared;
    const value = {
      primary: {
        primaryBaselineId: input.primaryBaselineId,
        comparisonBaselineId: primary.value.selectedId,
        repeatRequired: primary.value.repeatRequired,
      },
      candidate: {
        primaryBaselineId: input.candidateBaselineId,
        comparisonBaselineId: candidate.value.selectedId,
        repeatRequired: candidate.value.repeatRequired,
      },
      comparisons: compared.value,
    };
    const stillNoisy = primary.value.stillNoisy || candidate.value.stillNoisy;
    return stillNoisy
      ? {
          ok: true as const,
          value: {
            outcome: 'inconclusive-still-noisy' as const,
            ...value,
            issues: [issue('$.comparisons', 'repeat-still-noisy', 'Selected repeat is noisy.')],
          },
        }
      : { ok: true as const, value: { outcome: 'conclusive' as const, ...value } };
  }
  return {
    readExternalAttempts,
    readBaselineValidation,
    readVerifiedRepeatPrimary,
    readRepeatRequirement,
    readPairedComparison,
  };
}
