// prettier-ignore
import {
  createRtcBaselineExternalAttemptReader,
} from '../catalog/rtc-baseline-workload-manifest.ts';
import type {
  RtcBaselineAttemptLocatorDto,
  RtcBaselineResult,
  RtcBaselineWorkloadId,
} from '../contracts/rtc-baseline-contracts.ts';
import type {
  RtcBaselineFinalizedArtifactValidation,
  RtcBaselinePairedComparison,
  RtcBaselinePairedComparisonInput,
  RtcBaselineReaderInput,
  RtcBaselineRepeatRequirement,
  RtcBaselineVerifiedRepeatPrimary,
} from './rtc-baseline-evidence-layout.ts';
import { rtcBaselineTriggeredWorkloads } from './rtc-baseline-statistics.ts';
import {
  createRtcBaselineFinalizedArtifactVerifier,
  type RtcBaselineFinalizedArtifactVerifier,
} from './rtc-baseline-finalized-verification.ts';
// prettier-ignore
import { createRtcBaselineFinalizedComparisonReader } from './rtc-baseline-finalized-comparison.ts';
// prettier-ignore
import type {
  RtcBaselineFinalizedReaderDependencies,
} from './rtc-baseline-finalized-artifact-reader.ts';

// prettier-ignore
export type {
  RtcBaselineFinalizedReaderDependencies,
} from './rtc-baseline-finalized-artifact-reader.ts';
export type { RtcBaselineFinalizedArtifactValidation } from './rtc-baseline-evidence-layout.ts';
export type {
  RtcBaselinePairedComparison,
  RtcBaselineRepeatRequirement,
  RtcBaselineVerifiedRepeatPrimary,
} from './rtc-baseline-evidence-layout.ts';

export interface RtcBaselineFinalizedReader {
  readExternalAttempts(input: {
    baselineId: string;
    workloadId: RtcBaselineWorkloadId;
  }): Promise<RtcBaselineResult<readonly RtcBaselineAttemptLocatorDto[]>>;
  readBaselineValidation(
    input: RtcBaselineReaderInput,
  ): Promise<RtcBaselineResult<RtcBaselineFinalizedArtifactValidation>>;
  readVerifiedRepeatPrimary(
    input: RtcBaselineReaderInput,
  ): Promise<RtcBaselineResult<RtcBaselineVerifiedRepeatPrimary>>;
  readRepeatRequirement(
    input: RtcBaselineReaderInput,
  ): Promise<RtcBaselineResult<RtcBaselineRepeatRequirement>>;
  readPairedComparison(
    input: RtcBaselinePairedComparisonInput,
  ): Promise<RtcBaselineResult<RtcBaselinePairedComparison>>;
}

function failed(path: string, code: string, message: string): RtcBaselineResult<never> {
  return { ok: false, issues: [{ path, code, message }] };
}

async function readBaselineValidation(
  verifier: RtcBaselineFinalizedArtifactVerifier,
  input: RtcBaselineReaderInput,
): Promise<RtcBaselineResult<RtcBaselineFinalizedArtifactValidation>> {
  const verified = await verifier.readVerifiedArtifacts(input.baselineId);
  if (!verified.ok) {
    return verified;
  }
  const linked = await verifier.validateRepeatLink(input.baselineId, verified.value.summary);
  return linked.ok ? { ok: true, value: verified.value.validation } : linked;
}

async function readVerifiedRepeatPrimary(
  verifier: RtcBaselineFinalizedArtifactVerifier,
  input: RtcBaselineReaderInput,
): Promise<RtcBaselineResult<RtcBaselineVerifiedRepeatPrimary>> {
  const verified = await verifier.readVerifiedArtifacts(input.baselineId);
  if (!verified.ok) {
    return verified;
  }
  if (
    input.baselineId.endsWith('-repeat-01') ||
    verified.value.environment.repeatLink !== null ||
    verified.value.manifest.repeatLink !== null
  ) {
    return failed(
      '$.baselineId',
      'invalid-repeat-primary',
      'A repeat primary must be an unlinked non-repeat finalized baseline.',
    );
  }
  return {
    ok: true,
    value: {
      environment: verified.value.environment,
      manifest: verified.value.manifest,
      summarySha256: verified.value.summarySha256,
      triggeredWorkloadIds: rtcBaselineTriggeredWorkloads(verified.value),
    },
  };
}

async function readRepeatRequirement(
  verifier: RtcBaselineFinalizedArtifactVerifier,
  input: RtcBaselineReaderInput,
): Promise<RtcBaselineResult<RtcBaselineRepeatRequirement>> {
  const verified = await verifier.readVerifiedArtifacts(input.baselineId);
  if (!verified.ok) {
    return verified;
  }
  const linked = await verifier.validateRepeatLink(input.baselineId, verified.value.summary);
  if (!linked.ok) {
    return linked;
  }
  const workloadIds = rtcBaselineTriggeredWorkloads(verified.value);
  if (verified.value.summary.repeatLink !== null && workloadIds.length > 0) {
    return failed(
      '$.metricSummaries',
      'repeat-still-noisy',
      'Controlled repeat remains above its coefficient-of-variation threshold.',
    );
  }
  return { ok: true, value: { workloadIds } };
}

export function createRtcBaselineFinalizedReader(
  dependencies: RtcBaselineFinalizedReaderDependencies,
): RtcBaselineFinalizedReader {
  const verifier = createRtcBaselineFinalizedArtifactVerifier(dependencies);
  const comparisonReader = createRtcBaselineFinalizedComparisonReader(verifier);
  return {
    readExternalAttempts: createRtcBaselineExternalAttemptReader(dependencies.readJson),
    readBaselineValidation: (input) => readBaselineValidation(verifier, input),
    readVerifiedRepeatPrimary: (input) => readVerifiedRepeatPrimary(verifier, input),
    readRepeatRequirement: (input) => readRepeatRequirement(verifier, input),
    readPairedComparison: comparisonReader.readPairedComparison,
  };
}
