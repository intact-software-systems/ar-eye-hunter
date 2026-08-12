import type {
  RtcBaselineCaptureManifestDto,
  RtcBaselineCaptureWorkloadInputDto,
  RtcBaselineInitializeAcceptanceInputDto,
  RtcBaselineIssueDto,
  RtcBaselineJson,
  RtcBaselineOuterAttemptDto,
  RtcBaselineRecordAttemptInputDto,
  RtcBaselineRecordCohortInputDto,
  RtcBaselineResult,
  RtcBaselineSampleDto,
} from '../contracts/rtc-baseline-contracts.ts';
import { decodeRtcBaselineSample } from '../contracts/rtc-baseline-artifact-decoding.ts';
import { validateRtcBaselineSample } from '../contracts/rtc-baseline-artifact-validation.ts';
import { normalizeRtcBaselineJson } from '../contracts/rtc-baseline-decoding.ts';
import {
  buildRtcBaselineFailureSequence,
  decodeRtcBaselineAcceptedAttempt,
  decodeRtcBaselineAcceptedCohort,
  deriveRtcBaselineSampleIdentities,
  findRtcBaselineAttemptFailureOwner,
  rtcBaselineSampleIdentityEquals,
  type RtcBaselineFailureOwner,
  type RtcBaselineAcceptedArtifact,
} from './rtc-baseline-failure-accounting.ts';

interface Dependencies {
  initializeStore(
    baselineId: string,
    input: RtcBaselineInitializeAcceptanceInputDto,
  ): Promise<RtcBaselineResult<void>>;
  readManifest(baselineId: string): Promise<RtcBaselineResult<RtcBaselineCaptureManifestDto>>;
  writeAcceptedArtifact(
    baselineId: string,
    artifact: RtcBaselineAcceptedArtifact,
  ): Promise<RtcBaselineResult<void>>;
  readStagedJson(
    baselineId: string,
    relativePath: string,
  ): Promise<RtcBaselineResult<RtcBaselineJson>>;
  runFreshWorker(input: {
    baselineId: string;
    outerAttempt: RtcBaselineOuterAttemptDto;
  }): Promise<{ outcomes: RtcBaselineSampleDto[] }>;
  reconcileAcceptedOperation(
    operation: 'initialize' | 'capture' | 'browser' | 'external' | 'cohort',
    input: { baselineId?: string },
  ): Promise<RtcBaselineIssueDto[]>;
}

interface PersistFailureInput {
  baselineId: string;
  manifest?: RtcBaselineCaptureManifestDto;
  owner: RtcBaselineFailureOwner;
  issues: readonly RtcBaselineIssueDto[];
  rawEvidence: RtcBaselineJson;
}

type AcceptedSamples = Promise<RtcBaselineResult<{ acceptedSampleCount: number }>>;
export interface RtcBaselineEvidenceAcceptance {
  initializeBaseline(
    input: RtcBaselineInitializeAcceptanceInputDto,
  ): Promise<RtcBaselineResult<void>>;
  captureWorkload(input: RtcBaselineCaptureWorkloadInputDto): AcceptedSamples;
  recordBrowser(input: RtcBaselineRecordAttemptInputDto): AcceptedSamples;
  recordExternalAttempt(input: RtcBaselineRecordAttemptInputDto): AcceptedSamples;
  recordExternalCohortAssertion(
    input: RtcBaselineRecordCohortInputDto,
  ): Promise<RtcBaselineResult<{ acceptedCohortCount: number }>>;
}

function issue(path: string, code: string, message: string) {
  return { path, code, message };
}

function correctnessIssues(issues: readonly RtcBaselineIssueDto[], path: string, message: string) {
  return issues.length > 0 ? issues : [issue(path, 'correctness-failure', message)];
}

function entryOwnershipIssue(
  entry: 'capture' | 'browser' | 'external',
  workloadId: RtcBaselineCaptureWorkloadInputDto['workloadId'],
) {
  const policy =
    workloadId === 'RTC-B05'
      ? (['browser', 'Native-browser', 'record-browser'] as const)
      : workloadId === 'RTC-B06'
        ? (['external', 'Local-full-stack', 'external ingestion'] as const)
        : (['capture', 'Synthetic', 'capture'] as const);
  const [required, family, route] = policy;
  if (entry === required) return null;
  const path = entry === 'capture' ? '$.workloadId' : '$.locator.workloadId';
  return issue(path, 'entry-ownership', `${family} workloads must enter through ${route}.`);
}

export function createRtcBaselineEvidenceAcceptance(
  dependencies: Dependencies,
): RtcBaselineEvidenceAcceptance {
  async function persistFailure(input: PersistFailureInput) {
    const artifacts = buildRtcBaselineFailureSequence(input);
    for (const artifact of artifacts) {
      const written = await dependencies.writeAcceptedArtifact(input.baselineId, artifact);
      if (!written.ok) return written;
    }
    return { ok: false as const, issues: [...input.issues] };
  }

  async function readStagedEvidence(
    input: RtcBaselineRecordAttemptInputDto | RtcBaselineRecordCohortInputDto,
    owner: RtcBaselineFailureOwner,
    manifest?: RtcBaselineCaptureManifestDto,
  ) {
    if (input.producerExitStatus !== 0) {
      const producerIssue = issue(
        '$.producerExitStatus',
        'producer-exit-status',
        `Producer exited with status ${input.producerExitStatus}.`,
      );
      return persistFailure({
        baselineId: input.baselineId,
        manifest,
        owner,
        issues: [producerIssue],
        rawEvidence: { producerExitStatus: input.producerExitStatus },
      });
    }
    const staged = await dependencies.readStagedJson(input.baselineId, input.rawResultRelativePath);
    return staged.ok
      ? staged
      : persistFailure({
          baselineId: input.baselineId,
          manifest,
          owner,
          issues: staged.issues,
          rawEvidence: null,
        });
  }

  async function initializeBaseline(input: RtcBaselineInitializeAcceptanceInputDto) {
    const issues = await dependencies.reconcileAcceptedOperation('initialize', {
      baselineId: input.request.baselineId,
    });
    if (issues.length > 0) return { ok: false as const, issues };
    return dependencies.initializeStore(input.request.baselineId, input);
  }

  async function captureWorkload(input: RtcBaselineCaptureWorkloadInputDto) {
    const manifestResult = await dependencies.readManifest(input.baselineId);
    if (!manifestResult.ok) return manifestResult;
    const ownershipIssue = entryOwnershipIssue('capture', input.workloadId);
    if (ownershipIssue) return { ok: false as const, issues: [ownershipIssue] };
    const attempts = manifestResult.value.outerAttempts.filter(
      (attempt) => attempt.workloadId === input.workloadId,
    );
    const allIdentities = deriveRtcBaselineSampleIdentities(attempts);
    const reconciliation = await dependencies.reconcileAcceptedOperation('capture', input);
    if (reconciliation.length > 0) {
      return persistFailure({
        baselineId: input.baselineId,
        manifest: manifestResult.value,
        owner: { kind: 'sample', identity: allIdentities[0]! },
        issues: reconciliation,
        rawEvidence: null,
      });
    }
    let acceptedSampleCount = 0;
    let globalIndex = 0;
    for (const outerAttempt of attempts) {
      let worker: { outcomes: RtcBaselineSampleDto[] };
      try {
        worker = await dependencies.runFreshWorker({ baselineId: input.baselineId, outerAttempt });
      } catch (error) {
        const workerIssue = issue(
          '$.worker',
          'worker-threw',
          error instanceof Error ? error.message : String(error),
        );
        return persistFailure({
          baselineId: input.baselineId,
          manifest: manifestResult.value,
          owner: { kind: 'sample', identity: allIdentities[globalIndex]! },
          issues: [workerIssue],
          rawEvidence: null,
        });
      }
      const actualCount = worker.outcomes.length;
      if (actualCount !== outerAttempt.sampleIds.length) {
        const expectedCount = outerAttempt.sampleIds.length;
        const cardinalityIssue = issue(
          '$.worker.outcomes',
          'worker-outcome-cardinality',
          `Worker returned ${actualCount} outcomes for ${expectedCount} expected inner samples.`,
        );
        return persistFailure({
          baselineId: input.baselineId,
          manifest: manifestResult.value,
          owner: { kind: 'sample', identity: allIdentities[globalIndex]! },
          issues: [cardinalityIssue],
          rawEvidence: null,
        });
      }
      for (let index = 0; index < outerAttempt.sampleIds.length; index += 1) {
        const expected = allIdentities[globalIndex]!;
        const outcome = worker.outcomes[index];
        const rawOutcome = normalizeRtcBaselineJson(outcome);
        const decoded = rawOutcome.ok ? decodeRtcBaselineSample(rawOutcome.value) : rawOutcome;
        const expectedEvidenceClass =
          expected.workloadId === 'RTC-B05'
            ? 'native-browser'
            : expected.workloadId === 'RTC-B06'
              ? 'local-full-stack'
              : 'synthetic-path';
        if (
          !decoded.ok ||
          validateRtcBaselineSample(decoded.value).length > 0 ||
          !rtcBaselineSampleIdentityEquals(decoded.value.identity, expected) ||
          decoded.value.evidenceClass !== expectedEvidenceClass
        ) {
          const invalidIssue = issue(
            `$.worker.outcomes[${index}]`,
            'invalid-worker-outcome',
            'Worker outcome does not match the expected inner identity.',
          );
          return persistFailure({
            baselineId: input.baselineId,
            manifest: manifestResult.value,
            owner: { kind: 'sample', identity: expected },
            issues: [invalidIssue],
            rawEvidence: rawOutcome.ok ? rawOutcome.value : null,
          });
        }
        if (outcome.outcome !== 'passed') {
          const outcomeIssues =
            outcome.issues.length > 0
              ? outcome.issues
              : [
                  issue(
                    `$.worker.outcomes[${index}].outcome`,
                    'worker-outcome-failed',
                    'A failed worker outcome stops the capture workload.',
                  ),
                ];
          return persistFailure({
            baselineId: input.baselineId,
            manifest: manifestResult.value,
            owner: { kind: 'sample', identity: expected },
            issues: outcomeIssues,
            rawEvidence: outcome.rawEvidence,
          });
        }
        const written = await dependencies.writeAcceptedArtifact(input.baselineId, decoded.value);
        if (!written.ok) return written;
        acceptedSampleCount += 1;
        globalIndex += 1;
      }
    }
    return { ok: true as const, value: { acceptedSampleCount } };
  }

  async function prepareAttempt(
    input: RtcBaselineRecordAttemptInputDto,
    entry: 'browser' | 'external',
  ) {
    const manifestResult = await dependencies.readManifest(input.baselineId);
    if (!manifestResult.ok) return manifestResult;
    const workloadId = input.locator.workloadId;
    const ownershipIssue = entryOwnershipIssue(entry, workloadId);
    if (ownershipIssue) return { ok: false as const, issues: [ownershipIssue] };
    const owner = findRtcBaselineAttemptFailureOwner(manifestResult.value, input.locator);
    if (!owner) {
      return {
        ok: false as const,
        issues: [
          issue(
            '$.locator',
            'unknown-external-attempt',
            'External attempt locator is not predeclared by the initialized manifest.',
          ),
        ],
      };
    }
    const reconciliation = await dependencies.reconcileAcceptedOperation(entry, input);
    if (reconciliation.length > 0) {
      return persistFailure({
        baselineId: input.baselineId,
        manifest: manifestResult.value,
        owner,
        issues: reconciliation,
        rawEvidence: null,
      });
    }
    const staged = await readStagedEvidence(input, owner, manifestResult.value);
    if (!staged.ok) return staged;
    const expectedOuter = manifestResult.value.outerAttempts.find(
      (attempt) => attempt.sampleIds[0] === owner.identity.sampleId,
    )!;
    const accepted = decodeRtcBaselineAcceptedAttempt(staged.value, {
      expectedOuter,
      rawResultRelativePath: input.rawResultRelativePath,
      producerExitStatus: input.producerExitStatus,
    });
    if (!accepted.ok) {
      return persistFailure({
        baselineId: input.baselineId,
        manifest: manifestResult.value,
        owner,
        issues: accepted.issues,
        rawEvidence: staged.value,
      });
    }
    const failedIndex = accepted.value.samples.findIndex(
      (sample) => sample.outcome !== 'passed' || sample.issues.length > 0,
    );
    const failed = accepted.value.samples[failedIndex];
    if (failed) {
      for (const sample of accepted.value.samples.slice(0, failedIndex)) {
        const written = await dependencies.writeAcceptedArtifact(input.baselineId, sample);
        if (!written.ok) return written;
      }
      return persistFailure({
        baselineId: input.baselineId,
        manifest: manifestResult.value,
        owner: { kind: 'sample', identity: failed.identity },
        issues: correctnessIssues(
          failed.issues,
          '$.samples.outcome',
          'A non-passing external sample stops evidence acceptance.',
        ),
        rawEvidence: failed.rawEvidence,
      });
    }
    const written = await dependencies.writeAcceptedArtifact(input.baselineId, accepted.value);
    return written.ok
      ? { ok: true as const, value: { acceptedSampleCount: accepted.value.sampleOutcomes.length } }
      : written;
  }

  async function recordExternalCohortAssertion(input: RtcBaselineRecordCohortInputDto) {
    const manifestResult = await dependencies.readManifest(input.baselineId);
    if (!manifestResult.ok) return manifestResult;
    const identity = manifestResult.value.expectedCohorts.find(
      (entry) => entry.workloadId === input.workloadId && entry.cohortId === input.cohortId,
    );
    if (!identity)
      return {
        ok: false as const,
        issues: [
          issue(
            '$.cohortId',
            'unknown-cohort',
            'External cohort is not predeclared by the initialized manifest.',
          ),
        ],
      };
    const owner = { kind: 'cohort' as const, identity };
    const reconciliation = await dependencies.reconcileAcceptedOperation('cohort', input);
    if (reconciliation.length > 0)
      return persistFailure({
        baselineId: input.baselineId,
        owner,
        issues: reconciliation,
        rawEvidence: null,
      });
    const staged = await readStagedEvidence(input, owner);
    if (!staged.ok) return staged;
    const accepted = decodeRtcBaselineAcceptedCohort(staged.value, identity);
    if (!accepted.ok) {
      return persistFailure({
        baselineId: input.baselineId,
        owner,
        issues: accepted.issues,
        rawEvidence: staged.value,
      });
    }
    if (accepted.value.outcome !== 'passed' || accepted.value.issues.length > 0) {
      return persistFailure({
        baselineId: input.baselineId,
        owner,
        issues: correctnessIssues(
          accepted.value.issues,
          '$.outcome',
          'A non-passing external cohort stops evidence acceptance.',
        ),
        rawEvidence: accepted.value.rawEvidence,
      });
    }
    const written = await dependencies.writeAcceptedArtifact(input.baselineId, accepted.value);
    return written.ok ? { ok: true as const, value: { acceptedCohortCount: 1 } } : written;
  }

  return {
    initializeBaseline,
    captureWorkload,
    recordBrowser: (input) => prepareAttempt(input, 'browser'),
    recordExternalAttempt: (input) => prepareAttempt(input, 'external'),
    recordExternalCohortAssertion,
  };
}
