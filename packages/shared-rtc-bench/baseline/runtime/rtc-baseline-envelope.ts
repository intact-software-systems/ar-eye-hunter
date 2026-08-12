import type {
  RtcBaselineCaptureWorkloadInputDto,
  RtcBaselineCaptureRequestDto,
  RtcBaselineInitializeAcceptanceInputDto,
  RtcBaselineJson,
  RtcBaselineRecordAttemptInputDto,
  RtcBaselineRecordCohortInputDto,
  RtcBaselineResult,
  RtcBaselineRuntimeObservationDto,
  RtcBaselineWorkloadId,
} from '../contracts/rtc-baseline-contracts.ts';
import { decodeRtcBaselineCaptureRequest } from '../contracts/rtc-baseline-decoding.ts';
// prettier-ignore
import type { RtcBaselineEvidenceAcceptance } from
  '../acceptance/rtc-baseline-evidence-acceptance.ts';
import type { RtcBaselineFinalizedEvidence } from '../evidence/rtc-baseline-finalized-evidence.ts';
import type { RtcBaselineFinalizedReader } from '../evidence/rtc-baseline-finalized-reader.ts';
import { validateRtcBaselineCaptureRequest } from '../contracts/rtc-baseline-validation.ts';

interface Dependencies {
  acceptance: RtcBaselineEvidenceAcceptance;
  finalizedEvidence: RtcBaselineFinalizedEvidence;
  finalizedReader: RtcBaselineFinalizedReader;
  observeRuntime(
    input: RtcBaselineCaptureRequestDto,
  ): Promise<RtcBaselineResult<RtcBaselineRuntimeObservationDto>>;
}

export interface RtcBaselineEnvelope
  extends
    Omit<RtcBaselineEvidenceAcceptance, 'initializeBaseline'>,
    RtcBaselineFinalizedEvidence,
    RtcBaselineFinalizedReader {
  initializeBaseline(request: RtcBaselineJson | object): Promise<RtcBaselineResult<void>>;
}

export function createRtcBaselineEnvelope(dependencies: Dependencies): RtcBaselineEnvelope {
  return {
    async initializeBaseline(request) {
      const decoded = decodeRtcBaselineCaptureRequest(request);
      if (!decoded.ok) return decoded;
      const issues = validateRtcBaselineCaptureRequest(decoded.value);
      if (issues.length > 0) return { ok: false as const, issues };
      const observed = await dependencies.observeRuntime(decoded.value);
      if (!observed.ok) return observed;
      return dependencies.acceptance.initializeBaseline({
        request: decoded.value,
        runtimeObservation: observed.value,
      });
    },
    captureWorkload: (input) => dependencies.acceptance.captureWorkload(input),
    recordBrowser: (input) => dependencies.acceptance.recordBrowser(input),
    recordExternalAttempt: (input) => dependencies.acceptance.recordExternalAttempt(input),
    recordExternalCohortAssertion: (input) =>
      dependencies.acceptance.recordExternalCohortAssertion(input),
    finalize: (input) => dependencies.finalizedEvidence.finalize(input),
    readExternalAttempts: (input) => dependencies.finalizedReader.readExternalAttempts(input),
    readRepeatRequirement: (input) => dependencies.finalizedReader.readRepeatRequirement(input),
    readPairedComparison: (input) => dependencies.finalizedReader.readPairedComparison(input),
    readBaselineValidation: (input) => dependencies.finalizedReader.readBaselineValidation(input),
    readVerifiedRepeatPrimary: (input) =>
      dependencies.finalizedReader.readVerifiedRepeatPrimary(input),
  };
}
