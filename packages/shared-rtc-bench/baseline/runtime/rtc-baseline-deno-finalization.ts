import {
  decodeRtcBaselineExternalAttempt,
  decodeRtcBaselineExternalCohort,
  decodeRtcBaselineFinalizationFailure,
  decodeRtcBaselineSample,
} from '../contracts/rtc-baseline-artifact-decoding.ts';
import {
  isRtcBaselineExternalAttemptDto,
  isRtcBaselineExternalCohortDto,
  isRtcBaselineFinalizationFailureDto,
  isRtcBaselineSampleDto,
  rtcBaselineIssue,
  type RtcBaselineJson,
  type RtcBaselineResult,
} from '../contracts/rtc-baseline-contracts.ts';
import {
  validateRtcBaselineCompleteAccounting,
  validateRtcBaselineReconciliation,
} from '../contracts/rtc-baseline-artifact-validation.ts';
import { requireRtcBaselineDecodedType } from '../contracts/rtc-baseline-decoding.ts';
// prettier-ignore
import { computeRtcBaselineExpectedSampleIdentities } from
  '../catalog/rtc-baseline-workload-manifest.ts';
import {
  decodeRtcBaselineFailureOutcome,
  isRtcBaselineSampleFailureOutcomeArtifact,
  resolveRtcBaselineAcceptedArtifactPath,
} from '../acceptance/rtc-baseline-failure-accounting.ts';
import { classifyRtcBaselineArtifactPath } from '../evidence/rtc-baseline-evidence-layout.ts';
import type {
  RtcBaselineLockedWriter,
  RtcBaselineStoredFile,
} from '../evidence/rtc-baseline-evidence-store.ts';
import {
  createRtcBaselineFinalizedEvidence,
  type CollectedArtifacts,
  type RtcBaselineFinalizationLockedWriter,
  type RtcBaselineFinalizedEvidence,
} from '../evidence/rtc-baseline-finalized-evidence.ts';
import {
  createRtcBaselineFinalizedReader,
  type RtcBaselineFinalizedReader,
} from '../evidence/rtc-baseline-finalized-reader.ts';
import {
  computeRtcBaselineMetricSummary,
  partitionRtcBaselineMetricObservations,
} from '../evidence/rtc-baseline-statistics.ts';
import type { RtcBaselineDenoEvidence } from './rtc-baseline-deno-evidence.ts';

interface RtcBaselineResultArtifactCollection {
  readonly sampleOutcomes: CollectedArtifacts['sampleOutcomes'][number][];
  readonly externalAttempts: CollectedArtifacts['externalAttempts'][number][];
  readonly cohortOutcomes: CollectedArtifacts['cohortOutcomes'][number][];
  readonly samples: CollectedArtifacts['samples'][number][];
  readonly failures: CollectedArtifacts['failures'][number][];
}

type RtcBaselineClassifiedArtifactKind = NonNullable<
  ReturnType<typeof classifyRtcBaselineArtifactPath>
>;

interface AppendRtcBaselineResultArtifactInput {
  readonly collection: RtcBaselineResultArtifactCollection;
  readonly kind: RtcBaselineClassifiedArtifactKind;
  readonly artifactJson: RtcBaselineJson;
  readonly relativePath: string;
}

export interface RtcBaselineDenoFinalization {
  readonly finalizedEvidence: RtcBaselineFinalizedEvidence;
  readonly finalizedReader: RtcBaselineFinalizedReader;
}

function unsupportedArtifactPath(relativePath: string) {
  return {
    ok: false as const,
    issues: [
      rtcBaselineIssue(
        `$.${relativePath}`,
        'unsupported-artifact-path',
        'Result artifact path is not recognized by the RTC baseline protocol.',
      ),
    ],
  };
}

function appendUniqueSamples(
  collection: RtcBaselineResultArtifactCollection,
  incoming: readonly CollectedArtifacts['samples'][number][],
) {
  for (const sample of incoming) {
    const existing = collection.samples.find(
      (value) => value.identity.sampleId === sample.identity.sampleId,
    );
    if (existing && JSON.stringify(existing) !== JSON.stringify(sample)) {
      return rtcBaselineIssue(
        '$.samples',
        'conflicting-sample-duplicate',
        `Sample ${sample.identity.sampleId} has unequal accepted representations.`,
      );
    }
    if (!existing) {
      collection.samples.push(sample);
      collection.sampleOutcomes.push({
        identity: sample.identity,
        outcome: sample.outcome,
        issues: sample.issues,
      });
    }
  }
  return null;
}

function appendRtcBaselineSample(
  collection: RtcBaselineResultArtifactCollection,
  sampleJson: RtcBaselineJson,
): RtcBaselineResult<void> {
  const decoded = requireRtcBaselineDecodedType(
    decodeRtcBaselineSample(sampleJson),
    isRtcBaselineSampleDto,
  );
  if (!decoded.ok) {
    return decoded;
  }
  const duplicate = appendUniqueSamples(collection, [decoded.value]);
  return duplicate ? { ok: false, issues: [duplicate] } : { ok: true, value: undefined };
}

function appendRtcBaselineExternalAttempt(
  collection: RtcBaselineResultArtifactCollection,
  attemptJson: RtcBaselineJson,
): RtcBaselineResult<void> {
  const decoded = requireRtcBaselineDecodedType(
    decodeRtcBaselineExternalAttempt(attemptJson),
    isRtcBaselineExternalAttemptDto,
  );
  if (!decoded.ok) {
    return decoded;
  }
  collection.externalAttempts.push(decoded.value);
  const duplicate = appendUniqueSamples(collection, decoded.value.samples);
  return duplicate ? { ok: false, issues: [duplicate] } : { ok: true, value: undefined };
}

function appendRtcBaselineExternalCohort(
  collection: RtcBaselineResultArtifactCollection,
  cohortJson: RtcBaselineJson,
): RtcBaselineResult<void> {
  const decoded = requireRtcBaselineDecodedType(
    decodeRtcBaselineExternalCohort(cohortJson),
    isRtcBaselineExternalCohortDto,
  );
  if (!decoded.ok) {
    return decoded;
  }
  collection.cohortOutcomes.push(decoded.value);
  const duplicate = appendUniqueSamples(collection, decoded.value.samples);
  return duplicate ? { ok: false, issues: [duplicate] } : { ok: true, value: undefined };
}

function appendRtcBaselineFailureOutcome(
  collection: RtcBaselineResultArtifactCollection,
  failureJson: RtcBaselineJson,
  relativePath: string,
): RtcBaselineResult<void> {
  const decoded = decodeRtcBaselineFailureOutcome(failureJson, relativePath);
  if (!decoded.ok) {
    return decoded;
  }
  collection.failures.push(decoded.value);
  if (isRtcBaselineSampleFailureOutcomeArtifact(decoded.value)) {
    collection.sampleOutcomes.push(decoded.value);
  }
  return { ok: true, value: undefined };
}

function appendRtcBaselineResultArtifact(
  artifactInput: AppendRtcBaselineResultArtifactInput,
): RtcBaselineResult<void> {
  if (artifactInput.kind === 'failure-outcome') {
    return appendRtcBaselineFailureOutcome(
      artifactInput.collection,
      artifactInput.artifactJson,
      artifactInput.relativePath,
    );
  }
  if (artifactInput.kind === 'sample') {
    return appendRtcBaselineSample(artifactInput.collection, artifactInput.artifactJson);
  }
  if (artifactInput.kind === 'external-attempt') {
    return appendRtcBaselineExternalAttempt(artifactInput.collection, artifactInput.artifactJson);
  }
  if (artifactInput.kind === 'external-cohort') {
    return appendRtcBaselineExternalCohort(artifactInput.collection, artifactInput.artifactJson);
  }
  if (artifactInput.kind === 'finalization-failure') {
    const decoded = requireRtcBaselineDecodedType(
      decodeRtcBaselineFinalizationFailure(artifactInput.artifactJson),
      isRtcBaselineFinalizationFailureDto,
    );
    return decoded.ok ? { ok: true, value: undefined } : decoded;
  }
  return {
    ok: false,
    issues: [
      rtcBaselineIssue(
        `$.${artifactInput.relativePath}`,
        'unsupported-artifact-path',
        'Unsupported.',
      ),
    ],
  };
}

async function collectRtcBaselineResultArtifacts(
  evidence: RtcBaselineDenoEvidence,
  baselineId: string,
  listedFiles: readonly RtcBaselineStoredFile[],
): Promise<RtcBaselineResult<RtcBaselineResultArtifactCollection>> {
  const collection: RtcBaselineResultArtifactCollection = {
    sampleOutcomes: [],
    externalAttempts: [],
    cohortOutcomes: [],
    samples: [],
    failures: [],
  };
  for (const listedFile of listedFiles) {
    const kind = classifyRtcBaselineArtifactPath(listedFile.relativePath);
    if (kind === null) {
      return unsupportedArtifactPath(listedFile.relativePath);
    }
    const artifact = await evidence.store.readJson(baselineId, listedFile.relativePath);
    if (!artifact.ok) {
      return artifact;
    }
    const appended = appendRtcBaselineResultArtifact({
      collection,
      kind,
      artifactJson: artifact.value,
      relativePath: listedFile.relativePath,
    });
    if (!appended.ok) {
      return appended;
    }
  }
  return { ok: true, value: collection };
}

async function readRtcBaselineRetainedArtifacts(
  evidence: RtcBaselineDenoEvidence,
  baselineId: string,
  relativePaths: readonly string[],
) {
  const retainedArtifacts: CollectedArtifacts['retainedArtifacts'][number][] = [];
  for (const relativePath of relativePaths) {
    const bytes = await evidence.store.readBytes(baselineId, relativePath);
    if (!bytes.ok) {
      return bytes;
    }
    retainedArtifacts.push({ relativePath, bytes: bytes.value });
  }
  return { ok: true as const, value: retainedArtifacts };
}

async function collectRtcBaselineArtifacts(
  evidence: RtcBaselineDenoEvidence,
  baselineId: string,
): Promise<RtcBaselineResult<CollectedArtifacts>> {
  const reconciliation = await evidence.reconcileAcceptedOperation('finalize', { baselineId });
  if (reconciliation.length > 0) {
    return { ok: false, issues: reconciliation };
  }
  const environment = await evidence.readEnvironment(baselineId);
  if (!environment.ok) {
    return environment;
  }
  const observation = environment.value.observation;
  if (observation === null) {
    return {
      ok: false,
      issues: [rtcBaselineIssue('$.observation', 'missing-observation', 'Required.')],
    };
  }
  const manifest = await evidence.readManifest(baselineId);
  if (!manifest.ok) {
    return manifest;
  }
  const listed = await evidence.store.listArtifacts(baselineId, 'results');
  if (!listed.ok) {
    return listed;
  }
  const collection = await collectRtcBaselineResultArtifacts(evidence, baselineId, listed.value);
  if (!collection.ok) {
    return collection;
  }
  const retained = await readRtcBaselineRetainedArtifacts(evidence, baselineId, [
    'environment.json',
    'manifest.json',
    ...listed.value.map((entry) => entry.relativePath),
  ]);
  if (!retained.ok) {
    return retained;
  }
  return {
    ok: true,
    value: {
      environment: { ...environment.value, observation },
      manifest: manifest.value,
      workloadIds: manifest.value.workloadIds,
      environmentId: manifest.value.request.environmentId,
      repeatLink: manifest.value.repeatLink,
      conditionalEnvironmentDecisions: manifest.value.request.conditionalEnvironmentDecisions,
      ...collection.value,
      retainedArtifacts: retained.value,
    },
  };
}

async function listRtcBaselineFinalizedArtifactPaths(
  evidence: RtcBaselineDenoEvidence,
  baselineId: string,
) {
  const results = await evidence.store.listArtifacts(baselineId, 'results');
  if (!results.ok) {
    return results;
  }
  const artifacts = await evidence.store.listArtifacts(baselineId, 'artifacts');
  if (!artifacts.ok) {
    return artifacts;
  }
  const unsupported = results.value.find(
    (entry) => classifyRtcBaselineArtifactPath(entry.relativePath) === null,
  );
  if (unsupported) {
    return unsupportedArtifactPath(unsupported.relativePath);
  }
  return {
    ok: true as const,
    value: [
      'environment.json',
      'manifest.json',
      ...results.value.map((entry) => entry.relativePath),
      ...artifacts.value
        .map((entry) => entry.relativePath)
        .filter((path) => classifyRtcBaselineArtifactPath(path) !== null),
      'summary.json',
    ],
  };
}

function toRtcBaselineFinalizationWriter(
  writer: RtcBaselineLockedWriter,
): RtcBaselineFinalizationLockedWriter {
  return {
    publishSummary: writer.publishSummary,
    async writeFinalizationFailure(baselineId, artifact) {
      const path = resolveRtcBaselineAcceptedArtifactPath(artifact);
      return path.ok ? writer.writeJsonCreateNew(baselineId, path.value, artifact) : path;
    },
  };
}

async function withRtcBaselineFinalizationLock<T>(
  evidence: RtcBaselineDenoEvidence,
  baselineId: string,
  operation: (writer: RtcBaselineFinalizationLockedWriter) => Promise<RtcBaselineResult<T>>,
) {
  return evidence.store.withFinalizationLock(baselineId, (writer) =>
    operation(toRtcBaselineFinalizationWriter(writer)),
  );
}

export function createRtcBaselineDenoFinalization(
  evidence: RtcBaselineDenoEvidence,
  sha256: (bytes: Uint8Array) => Promise<string>,
): RtcBaselineDenoFinalization {
  const finalizedReader = createRtcBaselineFinalizedReader({
    readJson: evidence.store.readJson,
    readBytes: evidence.store.readBytes,
    listArtifactPaths: (baselineId) => listRtcBaselineFinalizedArtifactPaths(evidence, baselineId),
    sha256,
  });
  const finalizedEvidence = createRtcBaselineFinalizedEvidence({
    withFinalizationLock: (baselineId, operation) =>
      withRtcBaselineFinalizationLock(evidence, baselineId, operation),
    collectArtifacts: (baselineId) => collectRtcBaselineArtifacts(evidence, baselineId),
    validateCompleteAccounting: (value) =>
      validateRtcBaselineCompleteAccounting({
        expectedSamples: computeRtcBaselineExpectedSampleIdentities(value.manifest),
        expectedCohorts: value.manifest.expectedCohorts,
        sampleOutcomes: value.sampleOutcomes,
        cohortOutcomes: value.cohortOutcomes,
      }),
    validateReconciliation: (value) =>
      value.sampleOutcomes.flatMap((sample) =>
        sample.runtimeObservation
          ? validateRtcBaselineReconciliation(
              value.environment.observation,
              sample.runtimeObservation,
            )
          : [],
      ),
    partitionMetricObservations: partitionRtcBaselineMetricObservations,
    summarizeMetricValues: computeRtcBaselineMetricSummary,
    readRawBytes: evidence.store.readBytes,
    sha256,
  });
  return { finalizedEvidence, finalizedReader };
}
