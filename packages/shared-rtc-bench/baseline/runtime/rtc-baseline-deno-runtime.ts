import {
  decodeRtcBaselineEnvironment as decodeEnvironment,
  decodeRtcBaselineExternalAttempt as decodeExternalAttempt,
  decodeRtcBaselineExternalCohort as decodeExternalCohort,
  decodeRtcBaselineFinalizationFailure as decodeFinalizationFailure,
  decodeRtcBaselineManifest as decodeManifest,
  decodeRtcBaselineSample as decodeSample,
} from '../contracts/rtc-baseline-artifact-decoding.ts';
import {
  isRtcBaselineCaptureManifestDto as isManifest,
  isRtcBaselineEnvironmentDto as isEnvironment,
  isRtcBaselineExternalAttemptDto as isExternalAttempt,
  isRtcBaselineExternalCohortDto as isExternalCohort,
  isRtcBaselineFinalizationFailureDto as isFinalizationFailure,
  isRtcBaselineSampleDto as isSample,
  type RtcBaselineJson,
  type RtcBaselineResult,
} from '../contracts/rtc-baseline-contracts.ts';
import {
  normalizeRtcBaselineJson,
  requireRtcBaselineDecodedType,
} from '../contracts/rtc-baseline-decoding.ts';
import type { DenoRtcBaselineAdapters } from './rtc-baseline-deno-adapters.ts';
import {
  validateRtcBaselineSample,
  validateRtcBaselineCompleteAccounting,
  validateRtcBaselineReconciliation,
} from '../contracts/rtc-baseline-artifact-validation.ts';
// prettier-ignore
import { createRtcBaselineEvidenceAcceptance } from
  '../acceptance/rtc-baseline-evidence-acceptance.ts';
import { classifyRtcBaselineArtifactPath } from '../evidence/rtc-baseline-evidence-layout.ts';
import {
  RTC_BASELINE_ACCEPTED_ARTIFACT_DIRECTORIES,
  decodeRtcBaselineFailureOutcome,
  isRtcBaselineSampleFailureOutcomeArtifact,
  resolveRtcBaselineAcceptedArtifactPath,
  type RtcBaselineAcceptedArtifact,
} from '../acceptance/rtc-baseline-failure-accounting.ts';
import { createRtcBaselineFileStore } from '../evidence/rtc-baseline-evidence-store.ts';
import { createRtcBaselineEnvelope, type RtcBaselineEnvelope } from './rtc-baseline-envelope.ts';
import {
  createRtcBaselineFinalizedEvidence,
  type CollectedArtifacts,
} from '../evidence/rtc-baseline-finalized-evidence.ts';
import { createRtcBaselineFinalizedReader } from '../evidence/rtc-baseline-finalized-reader.ts';
import {
  createRtcBaselineDenoObservation,
  createRtcBaselineRuntimeReconciler,
} from './rtc-baseline-runtime-observation.ts';
import {
  createRtcBaselineWorkerCommand,
  prepareRtcBaselineRepeatRequest,
} from '../contracts/rtc-baseline-validation.ts';
import {
  computeRtcBaselineMetricSummary,
  partitionRtcBaselineMetricObservations,
} from '../evidence/rtc-baseline-statistics.ts';
import { RTC_BASELINE_WORKLOAD_CATALOG } from '../catalog/rtc-baseline-workload-catalog.ts';
import {
  computeRtcBaselineExpectedSampleIdentities,
  deriveRtcBaselineCaptureManifest,
} from '../catalog/rtc-baseline-workload-manifest.ts';

const rootPath = 'tmp/perf/rtc-baseline';
const encoder = new TextEncoder();
export type RtcBaselineDenoRuntime = RtcBaselineEnvelope;

function failure(path: string, code: string, message: string) {
  return { ok: false as const, issues: [{ path, code, message }] };
}
function unsupportedArtifactPath(relativePath: string) {
  return failure(
    `$.${relativePath}`,
    'unsupported-artifact-path',
    'Result artifact path is not recognized by the RTC baseline protocol.',
  );
}
function appendUniqueSamples(
  outcomes: CollectedArtifacts['sampleOutcomes'][number][],
  samples: CollectedArtifacts['samples'][number][],
  incoming: readonly CollectedArtifacts['samples'][number][],
) {
  for (const sample of incoming) {
    const existing = samples.find((value) => value.identity.sampleId === sample.identity.sampleId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(sample)) {
      return {
        path: '$.samples',
        code: 'conflicting-sample-duplicate',
        message: `Sample ${sample.identity.sampleId} has unequal accepted representations.`,
      };
    }
    if (!existing) {
      samples.push(sample);
      outcomes.push({ identity: sample.identity, outcome: sample.outcome, issues: sample.issues });
    }
  }
  return null;
}

export function createRtcBaselineDenoRuntime(
  adapters: DenoRtcBaselineAdapters,
): RtcBaselineDenoRuntime {
  const store = createRtcBaselineFileStore({ rootPath, filePort: adapters.filePort });

  async function readManifestArtifact(baselineId: string) {
    const json = await store.readJson(baselineId, 'manifest.json');
    return json.ok ? requireRtcBaselineDecodedType(decodeManifest(json.value), isManifest) : json;
  }
  async function readEnvironment(baselineId: string) {
    const json = await store.readJson(baselineId, 'environment.json');
    return json.ok
      ? requireRtcBaselineDecodedType(decodeEnvironment(json.value), isEnvironment)
      : json;
  }
  const observeRequest = createRtcBaselineDenoObservation(adapters);
  const reconcileAcceptedOperation = createRtcBaselineRuntimeReconciler({
    async readInitialized(baselineId) {
      const environment = await readEnvironment(baselineId);
      if (!environment.ok) return environment;
      const manifest = await readManifestArtifact(baselineId);
      if (!manifest.ok) return manifest;
      if (environment.value.observation === null) {
        return failure('$.observation', 'missing-observation', 'Required.');
      }
      return {
        ok: true as const,
        value: { request: manifest.value.request, observation: environment.value.observation },
      };
    },
    observe: observeRequest,
    validate: validateRtcBaselineReconciliation,
  });

  async function writeAcceptedArtifact(baselineId: string, artifact: RtcBaselineAcceptedArtifact) {
    const path = resolveRtcBaselineAcceptedArtifactPath(artifact);
    return path.ok ? store.writeJsonCreateNew(baselineId, path.value, artifact) : path;
  }

  const acceptance = createRtcBaselineEvidenceAcceptance({
    async initializeStore(baselineId, input) {
      const environment = {
        schema: 'rallar.rtc-baseline.environment.v1',
        baselineId,
        workloadIds: input.request.workloadIds,
        environmentId: input.request.environmentId,
        repeatLink: input.request.repeatLink,
        conditionalEnvironmentDecisions: input.request.conditionalEnvironmentDecisions,
        observation: input.runtimeObservation,
      };
      const manifest = deriveRtcBaselineCaptureManifest(input.request);
      return store.initializeBaseline(
        baselineId,
        {
          'environment.json': encoder.encode(`${JSON.stringify(environment)}\n`),
          'manifest.json': encoder.encode(`${JSON.stringify(manifest)}\n`),
        },
        [...RTC_BASELINE_ACCEPTED_ARTIFACT_DIRECTORIES, 'artifacts', 'artifacts/staging'],
      );
    },
    readManifest: readManifestArtifact,
    writeAcceptedArtifact,
    readStagedJson: store.readJson,
    async runFreshWorker(input) {
      const workload = RTC_BASELINE_WORKLOAD_CATALOG.find(
        (entry) => entry.workloadId === input.outerAttempt.workloadId,
      );
      const caseEntry = workload?.cases.find(
        (entry) =>
          entry.caseId === input.outerAttempt.caseId &&
          entry.inputKey === input.outerAttempt.inputKey,
      );
      if (!caseEntry) throw new Error('The manifest outer attempt is absent from the catalog.');
      const environment = await readEnvironment(input.baselineId);
      if (!environment.ok) throw new Error(JSON.stringify(environment.issues));
      const resolvedConfiguration = environment.value.observation?.resolvedConfiguration;
      if (!resolvedConfiguration) throw new Error('The initialized configuration is absent.');
      const command = createRtcBaselineWorkerCommand({
        baselineId: input.baselineId,
        caseEntry,
        outerAttempt: input.outerAttempt,
        resolvedConfiguration,
      });
      if (!command.ok) throw new Error(JSON.stringify(command.issues));
      const result = await adapters.freshWorker.run(command.value.redactedArgv);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      const normalized = normalizeRtcBaselineJson(JSON.parse(result.value.stdout));
      if (!normalized.ok) throw new Error(JSON.stringify(normalized.issues));
      const parsed = normalized.value;
      if (!Array.isArray(parsed)) throw new Error('Worker output must be a JSON array.');
      const outcomes = parsed.map((value) => {
        const decoded = decodeSample(value);
        if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
        if (!isSample(decoded.value)) throw new Error('Decoded worker sample is untyped.');
        const issues = validateRtcBaselineSample(decoded.value);
        if (issues.length > 0) throw new Error(JSON.stringify(issues));
        return decoded.value;
      });
      return { outcomes };
    },
    reconcileAcceptedOperation,
  });

  const reader = createRtcBaselineFinalizedReader({
    readJson: store.readJson,
    readBytes: store.readBytes,
    async listArtifactPaths(baselineId: string) {
      const results = await store.listArtifacts(baselineId, 'results');
      if (!results.ok) return results;
      const artifacts = await store.listArtifacts(baselineId, 'artifacts');
      if (!artifacts.ok) return artifacts;
      const unsupported = results.value.find(
        (entry) => classifyRtcBaselineArtifactPath(entry.relativePath) === null,
      );
      if (unsupported) return unsupportedArtifactPath(unsupported.relativePath);
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
    },
    sha256: adapters.sha256,
  });

  async function collectArtifacts(
    baselineId: string,
  ): Promise<RtcBaselineResult<CollectedArtifacts>> {
    const reconciliation = await reconcileAcceptedOperation('finalize', { baselineId });
    if (reconciliation.length > 0) return { ok: false as const, issues: reconciliation };
    const environment = await readEnvironment(baselineId);
    if (!environment.ok) return environment;
    const observation = environment.value.observation;
    if (observation === null) return failure('$.observation', 'missing-observation', 'Required.');
    const manifest = await readManifestArtifact(baselineId);
    if (!manifest.ok) return manifest;
    const listed = await store.listArtifacts(baselineId, 'results');
    if (!listed.ok) return listed;
    const sampleOutcomes: CollectedArtifacts['sampleOutcomes'][number][] = [];
    const externalAttempts: CollectedArtifacts['externalAttempts'][number][] = [];
    const cohortOutcomes: CollectedArtifacts['cohortOutcomes'][number][] = [];
    const samples: CollectedArtifacts['samples'][number][] = [];
    const failures: CollectedArtifacts['failures'][number][] = [];
    for (const entry of listed.value) {
      const kind = classifyRtcBaselineArtifactPath(entry.relativePath);
      if (kind === null) return unsupportedArtifactPath(entry.relativePath);
      const artifact = await store.readJson(baselineId, entry.relativePath);
      if (!artifact.ok) return artifact;
      if (kind === 'failure-outcome') {
        const decoded = decodeRtcBaselineFailureOutcome(artifact.value, entry.relativePath);
        if (!decoded.ok) return decoded;
        failures.push(decoded.value);
        if (isRtcBaselineSampleFailureOutcomeArtifact(decoded.value))
          sampleOutcomes.push(decoded.value);
        continue;
      }
      if (kind === 'sample') {
        const decoded = requireRtcBaselineDecodedType(decodeSample(artifact.value), isSample);
        if (!decoded.ok) return decoded;
        const duplicate = appendUniqueSamples(sampleOutcomes, samples, [decoded.value]);
        if (duplicate) return { ok: false as const, issues: [duplicate] };
      } else if (kind === 'external-attempt') {
        const decoded = requireRtcBaselineDecodedType(
          decodeExternalAttempt(artifact.value),
          isExternalAttempt,
        );
        if (!decoded.ok) return decoded;
        externalAttempts.push(decoded.value);
        const duplicate = appendUniqueSamples(sampleOutcomes, samples, decoded.value.samples);
        if (duplicate) return { ok: false as const, issues: [duplicate] };
      } else if (kind === 'external-cohort') {
        const decoded = requireRtcBaselineDecodedType(
          decodeExternalCohort(artifact.value),
          isExternalCohort,
        );
        if (!decoded.ok) return decoded;
        cohortOutcomes.push(decoded.value);
        const duplicate = appendUniqueSamples(sampleOutcomes, samples, decoded.value.samples);
        if (duplicate) return { ok: false as const, issues: [duplicate] };
      } else if (kind === 'finalization-failure') {
        const decoded = requireRtcBaselineDecodedType(
          decodeFinalizationFailure(artifact.value),
          isFinalizationFailure,
        );
        if (!decoded.ok) return decoded;
      } else {
        return failure(`$.${entry.relativePath}`, 'unsupported-artifact-path', 'Unsupported.');
      }
    }
    const retainedPaths = [
      'environment.json',
      'manifest.json',
      ...listed.value.map((entry) => entry.relativePath),
    ];
    const retainedArtifacts = [];
    for (const relativePath of retainedPaths) {
      const bytes = await store.readBytes(baselineId, relativePath);
      if (!bytes.ok) return bytes;
      retainedArtifacts.push({ relativePath, bytes: bytes.value });
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
        sampleOutcomes,
        externalAttempts,
        cohortOutcomes,
        samples,
        failures,
        retainedArtifacts,
      },
    };
  }

  const finalized = createRtcBaselineFinalizedEvidence({
    withFinalizationLock: (baselineId, operation) =>
      store.withFinalizationLock(baselineId, (writer) =>
        operation({
          publishSummary: writer.publishSummary,
          writeFinalizationFailure: async (failureBaselineId, artifact) => {
            const path = resolveRtcBaselineAcceptedArtifactPath(artifact);
            return path.ok
              ? writer.writeJsonCreateNew(failureBaselineId, path.value, artifact)
              : path;
          },
        }),
      ),
    collectArtifacts,
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
    readRawBytes: store.readBytes,
    sha256: adapters.sha256,
  });

  const envelope = createRtcBaselineEnvelope({
    acceptance,
    finalizedEvidence: finalized,
    finalizedReader: reader,
    observeRuntime: observeRequest,
  });

  return {
    ...envelope,
    async initializeBaseline(request: RtcBaselineJson) {
      if (typeof request !== 'object' || request === null || Array.isArray(request))
        return envelope.initializeBaseline(request);
      const repeatOf = Reflect.get(request, 'repeatOf');
      if (typeof repeatOf !== 'string') return envelope.initializeBaseline(request);
      const primaryId = repeatOf;
      if (primaryId.endsWith('-repeat-01')) {
        return failure('$.repeatOf', 'repeat-of-repeat', 'A repeat cannot use another repeat.');
      }
      const primary = await reader.readVerifiedRepeatPrimary({ baselineId: primaryId });
      if (!primary.ok) return primary;
      const prepared = prepareRtcBaselineRepeatRequest({
        primary: {
          ...primary.value.manifest.request,
          workloadIds: primary.value.triggeredWorkloadIds,
        },
        request,
        repeatLink: {
          primaryBaselineId: primaryId,
          primarySummarySha256: primary.value.summarySha256,
        },
        inheritedDecisions: primary.value.environment.conditionalEnvironmentDecisions,
      });
      return prepared.ok ? envelope.initializeBaseline(prepared.value) : prepared;
    },
  };
}
