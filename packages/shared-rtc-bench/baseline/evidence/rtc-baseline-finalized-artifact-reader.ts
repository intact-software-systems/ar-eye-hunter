import { decodeRtcBaselineStoredJson } from '../contracts/rtc-baseline-artifact-decoding.ts';
import type {
  RtcBaselineCaptureManifestDto,
  RtcBaselineEnvironmentDto,
  RtcBaselineIssueDto,
  RtcBaselineJson,
  RtcBaselineResult,
} from '../contracts/rtc-baseline-contracts.ts';
import { validateRtcBaselineStoredArtifact } from '../contracts/rtc-baseline-artifact-validation.ts';
import { decodeRtcBaselineFailureOutcome } from '../acceptance/rtc-baseline-failure-accounting.ts';
import {
  classifyRtcBaselineArtifactPath,
  inspectRtcBaselineChecksumEntries,
  inspectRtcBaselineStoredArtifactBytes,
  RTC_BASELINE_CHECKSUM_FILE,
  type RtcBaselineSummaryArtifactRecord,
  type RtcBaselineVerifiedStoredArtifact,
  validateRtcBaselineChecksumMembership,
} from './rtc-baseline-evidence-layout.ts';
import {
  createRtcBaselineArtifactProjector,
  type RtcBaselineArtifactProjection,
  type RtcBaselineArtifactProjector,
} from './rtc-baseline-artifact-projection.ts';

export interface RtcBaselineFinalizedReaderDependencies {
  readJson(baselineId: string, path: string): Promise<RtcBaselineResult<RtcBaselineJson>>;
  readBytes(baselineId: string, path: string): Promise<RtcBaselineResult<Uint8Array>>;
  listArtifactPaths(baselineId: string): Promise<RtcBaselineResult<string[]>>;
  sha256(bytes: Uint8Array): Promise<string>;
}

export interface RtcBaselineReadFinalizedArtifacts {
  readonly retainedPaths: readonly string[];
  readonly checksumEntries: ReadonlyMap<string, string>;
  readonly issues: RtcBaselineIssueDto[];
  readonly environment?: RtcBaselineEnvironmentDto;
  readonly manifest?: RtcBaselineCaptureManifestDto;
  readonly summary?: RtcBaselineSummaryArtifactRecord;
  readonly projection?: RtcBaselineArtifactProjection;
}

interface RtcBaselineArtifactReadState {
  issues: RtcBaselineIssueDto[];
  environment?: RtcBaselineEnvironmentDto;
  manifest?: RtcBaselineCaptureManifestDto;
  summary?: RtcBaselineSummaryArtifactRecord;
  projector?: RtcBaselineArtifactProjector;
}

interface ReadVerifiedStoredArtifactInput {
  readonly dependencies: RtcBaselineFinalizedReaderDependencies;
  readonly baselineId: string;
  readonly relativePath: string;
  readonly expectedSha256: string;
}

function failed(path: string, code: string, message: string): RtcBaselineResult<never> {
  return { ok: false, issues: [{ path, code, message }] };
}

async function readVerifiedStoredArtifact(
  input: ReadVerifiedStoredArtifactInput,
): Promise<RtcBaselineResult<RtcBaselineVerifiedStoredArtifact>> {
  const bytes = await input.dependencies.readBytes(input.baselineId, input.relativePath);
  if (!bytes.ok) {
    return bytes;
  }
  if ((await input.dependencies.sha256(bytes.value)) !== input.expectedSha256) {
    return failed(
      `$.${input.relativePath}`,
      'checksum-mismatch',
      'Stored bytes do not match the SHA-256 checksum.',
    );
  }
  return inspectRtcBaselineStoredArtifactBytes({
    relativePath: input.relativePath,
    bytes: bytes.value,
  });
}

async function appendDecodedArtifact(
  state: RtcBaselineArtifactReadState,
  artifact: RtcBaselineVerifiedStoredArtifact,
  sha256: (bytes: Uint8Array) => Promise<string>,
): Promise<void> {
  if (artifact.kind === null || artifact.json === null) {
    return;
  }
  const decoded = decodeRtcBaselineStoredJson(artifact.kind, artifact.json);
  if (!decoded.ok) {
    state.issues.push(...decoded.issues);
    return;
  }
  if (decoded.value.schema === 'rallar.rtc-baseline.environment.v1') {
    state.environment = decoded.value;
    state.issues.push(...validateRtcBaselineStoredArtifact(decoded.value));
    state.projector = createRtcBaselineArtifactProjector({
      environmentId: decoded.value.environmentId,
      environmentObservation: decoded.value.observation,
      conflictingSampleCode: 'conflicting-sample',
      conflictingSampleMessage: () => 'Duplicate sample bodies differ.',
      sha256,
    });
    return;
  }
  if (decoded.value.schema === 'rallar.rtc-baseline.manifest.v1') {
    state.manifest = decoded.value;
  }
  if (decoded.value.schema === 'rallar.rtc-baseline.summary.v1') {
    state.summary = decoded.value;
  }
  if (state.projector) {
    const appended = await state.projector.appendStoredArtifact(decoded.value);
    if (!appended.ok) {
      state.issues.push(...appended.issues);
    }
    return;
  }
  state.issues.push(...validateRtcBaselineStoredArtifact(decoded.value));
}

async function appendFailureArtifact(
  state: RtcBaselineArtifactReadState,
  artifact: RtcBaselineVerifiedStoredArtifact,
  relativePath: string,
): Promise<void> {
  if (classifyRtcBaselineArtifactPath(relativePath) !== 'failure-outcome') {
    return;
  }
  const decoded = decodeRtcBaselineFailureOutcome(artifact.json, relativePath);
  if (!decoded.ok) {
    state.issues.push(...decoded.issues);
    return;
  }
  if (state.projector) {
    const appended = await state.projector.appendFailureOutcome(decoded.value);
    if (!appended.ok) {
      state.issues.push(...appended.issues);
    }
  }
}

async function appendArtifactPath(
  dependencies: RtcBaselineFinalizedReaderDependencies,
  state: RtcBaselineArtifactReadState,
  input: { baselineId: string; relativePath: string; expectedSha256: string },
): Promise<void> {
  const stored = await readVerifiedStoredArtifact({
    dependencies,
    ...input,
  });
  if (!stored.ok) {
    state.issues.push(...stored.issues);
    return;
  }
  await appendDecodedArtifact(state, stored.value, dependencies.sha256);
  await appendFailureArtifact(state, stored.value, input.relativePath);
}

export function createRtcBaselineFinalizedArtifactReader(
  dependencies: RtcBaselineFinalizedReaderDependencies,
) {
  async function read(
    baselineId: string,
  ): Promise<RtcBaselineResult<RtcBaselineReadFinalizedArtifacts>> {
    const checksumBytes = await dependencies.readBytes(baselineId, RTC_BASELINE_CHECKSUM_FILE);
    if (!checksumBytes.ok) {
      return checksumBytes;
    }
    const listed = await dependencies.listArtifactPaths(baselineId);
    if (!listed.ok) {
      return listed;
    }
    const retainedPaths = [...listed.value].sort();
    const { entries, issues } = inspectRtcBaselineChecksumEntries(checksumBytes.value);
    const state: RtcBaselineArtifactReadState = { issues };
    issues.push(...validateRtcBaselineChecksumMembership(retainedPaths, entries));
    for (const relativePath of retainedPaths) {
      const expectedSha256 = entries.get(relativePath);
      if (expectedSha256 !== undefined) {
        await appendArtifactPath(dependencies, state, {
          baselineId,
          relativePath,
          expectedSha256,
        });
      }
    }
    const projection = state.projector?.getProjection();
    if (projection) {
      issues.push(...projection.artifactIssues);
    }
    return {
      ok: true,
      value: {
        retainedPaths,
        checksumEntries: entries,
        issues,
        environment: state.environment,
        manifest: state.manifest,
        summary: state.summary,
        projection,
      },
    };
  }

  return { read };
}
