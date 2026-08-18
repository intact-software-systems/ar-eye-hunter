import {
  decodeRtcBaselineEnvironment,
  decodeRtcBaselineManifest,
} from '../contracts/rtc-baseline-artifact-decoding.ts';
import {
  isRtcBaselineCaptureManifestDto,
  isRtcBaselineEnvironmentDto,
  rtcBaselineIssue,
  type RtcBaselineCaptureManifestDto,
  type RtcBaselineEnvironmentDto,
  type RtcBaselineIssueDto,
  type RtcBaselineResult,
} from '../contracts/rtc-baseline-contracts.ts';
import { requireRtcBaselineDecodedType } from '../contracts/rtc-baseline-decoding.ts';
// prettier-ignore
import { validateRtcBaselineReconciliation } from
  '../contracts/rtc-baseline-artifact-validation.ts';
import {
  createRtcBaselineFileStore,
  type RtcBaselineFileStore,
} from '../evidence/rtc-baseline-evidence-store.ts';
import type { RtcBaselineFilePort } from '../evidence/rtc-baseline-file-port.ts';
import {
  RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS,
  type RtcBaselineWriterLockRuntime,
} from '../evidence/rtc-baseline-writer-lock.ts';
import {
  createRtcBaselineRuntimeReconciler,
  type RtcBaselineCaptureObserver,
} from './rtc-baseline-runtime-observation.ts';

interface CreateRtcBaselineDenoEvidenceInput {
  readonly rootPath: string;
  readonly filePort: RtcBaselineFilePort;
  readonly writerLockRuntime: RtcBaselineWriterLockRuntime;
  readonly observeRuntime: RtcBaselineCaptureObserver;
}

export interface RtcBaselineDenoEvidence {
  readonly store: RtcBaselineFileStore;
  readManifest(baselineId: string): Promise<RtcBaselineResult<RtcBaselineCaptureManifestDto>>;
  readEnvironment(baselineId: string): Promise<RtcBaselineResult<RtcBaselineEnvironmentDto>>;
  reconcileAcceptedOperation(
    operation: string,
    operationInput: { baselineId?: string },
  ): Promise<RtcBaselineIssueDto[]>;
}

export function createRtcBaselineDenoEvidence(
  evidenceInput: CreateRtcBaselineDenoEvidenceInput,
): RtcBaselineDenoEvidence {
  const store = createRtcBaselineFileStore({
    rootPath: evidenceInput.rootPath,
    filePort: evidenceInput.filePort,
    writerLockRuntime: evidenceInput.writerLockRuntime,
    writerLockConfig: { staleAfterMs: RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS },
  });
  const readManifest = async (baselineId: string) => {
    const json = await store.readJson(baselineId, 'manifest.json');
    return json.ok
      ? requireRtcBaselineDecodedType(
          decodeRtcBaselineManifest(json.value),
          isRtcBaselineCaptureManifestDto,
        )
      : json;
  };
  const readEnvironment = async (baselineId: string) => {
    const json = await store.readJson(baselineId, 'environment.json');
    return json.ok
      ? requireRtcBaselineDecodedType(
          decodeRtcBaselineEnvironment(json.value),
          isRtcBaselineEnvironmentDto,
        )
      : json;
  };
  const reconcileAcceptedOperation = createRtcBaselineRuntimeReconciler({
    async readInitialized(baselineId) {
      const environment = await readEnvironment(baselineId);
      if (!environment.ok) {
        return environment;
      }
      const manifest = await readManifest(baselineId);
      if (!manifest.ok) {
        return manifest;
      }
      if (environment.value.observation === null) {
        return {
          ok: false,
          issues: [rtcBaselineIssue('$.observation', 'missing-observation', 'Required.')],
        };
      }
      return {
        ok: true,
        value: { request: manifest.value.request, observation: environment.value.observation },
      };
    },
    observe: evidenceInput.observeRuntime,
    validate: validateRtcBaselineReconciliation,
  });

  return { store, readManifest, readEnvironment, reconcileAcceptedOperation };
}
