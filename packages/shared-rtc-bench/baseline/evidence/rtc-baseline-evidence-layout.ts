import type {
  RtcBaselineAttemptLocatorDto,
  RtcBaselineCohortIdentityDto,
  RtcBaselineCaptureManifestDto,
  RtcBaselineEnvironmentDto,
  RtcBaselineExternalAttemptDto,
  RtcBaselineExternalCohortDto,
  RtcBaselineFinalizationFailureDto,
  RtcBaselineIssueDto,
  RtcBaselineJson,
  RtcBaselineRawReferenceDto,
  RtcBaselineRepeatLinkDto,
  RtcBaselineResult,
  RtcBaselineRuntimeObservationDto,
  RtcBaselineSampleDto,
  RtcBaselineSampleOutcomeDto,
  RtcBaselineSummaryDto,
  RtcBaselineWorkloadId,
} from '../contracts/rtc-baseline-contracts.ts';
import type {
  PersistedMetric,
  RtcBaselinePersistedMetricComparison,
} from './rtc-baseline-statistics.ts';
export const RTC_BASELINE_ENVIRONMENT_FILE = 'environment.json';
export const RTC_BASELINE_MANIFEST_FILE = 'manifest.json';
export const RTC_BASELINE_SUMMARY_FILE = 'summary.json';
export const RTC_BASELINE_CHECKSUM_FILE = 'SHA256SUMS';
export interface RtcBaselineFinalizedArtifactValidation {
  baselineId: string;
  retainedArtifactPaths: string[];
  checksumEntryCount: number;
}
export interface RtcBaselineSummaryArtifactRecord extends Omit<
  RtcBaselineSummaryDto,
  'sampleOutcomes' | 'cohortOutcomes' | 'metricSummaries'
> {
  sampleOutcomes: readonly RtcBaselineSampleOutcomeDto[];
  cohortOutcomes: readonly RtcBaselineCohortOutcomeRecord[];
  metricSummaries: readonly PersistedMetric[];
}
export interface RtcBaselineCohortOutcomeRecord {
  identity: RtcBaselineCohortIdentityDto;
  outcome: 'passed' | 'failed';
  issues: readonly RtcBaselineIssueDto[];
}
export interface RtcBaselineStoredArtifactByKind {
  environment: RtcBaselineEnvironmentDto;
  'external-attempt': RtcBaselineExternalAttemptDto;
  'external-cohort': RtcBaselineExternalCohortDto;
  'finalization-failure': RtcBaselineFinalizationFailureDto;
  manifest: RtcBaselineCaptureManifestDto;
  sample: RtcBaselineSampleDto;
  summary: RtcBaselineSummaryArtifactRecord;
}
export type RtcBaselineArtifactKind = keyof RtcBaselineStoredArtifactByKind;
export type RtcBaselineStoredArtifact =
  RtcBaselineStoredArtifactByKind[keyof RtcBaselineStoredArtifactByKind];
export interface RtcBaselineRepeatRequirement {
  workloadIds: RtcBaselineWorkloadId[];
}
export interface RtcBaselineComparisonAnchor {
  primaryBaselineId: string;
  comparisonBaselineId: string;
  repeatRequired: boolean;
}
interface RtcBaselinePairedComparisonRecord {
  primary: RtcBaselineComparisonAnchor;
  candidate: RtcBaselineComparisonAnchor;
  comparisons: readonly RtcBaselinePersistedMetricComparison[];
}
export type RtcBaselinePairedComparison = RtcBaselinePairedComparisonRecord &
  (
    | { outcome: 'conclusive' }
    | {
        outcome: 'inconclusive-still-noisy';
        issues: readonly { path: string; code: string; message: string }[];
      }
  );
export interface RtcBaselinePairedComparisonInput {
  primaryBaselineId: string;
  primaryComparisonCohortId: string;
  candidateBaselineId: string;
  candidateComparisonCohortId: string;
  workloadId: RtcBaselineWorkloadId;
}
export type RtcBaselineReaderInput = Pick<RtcBaselineFinalizedArtifactValidation, 'baselineId'>;
export interface RtcBaselineVerifiedRepeatPrimary {
  environment: RtcBaselineEnvironmentDto;
  manifest: RtcBaselineCaptureManifestDto;
  summarySha256: string;
  triggeredWorkloadIds: readonly RtcBaselineWorkloadId[];
}
export interface RtcBaselineVerifiedArtifacts {
  environment: RtcBaselineEnvironmentDto;
  manifest: RtcBaselineCaptureManifestDto;
  summarySha256: string;
  summary: RtcBaselineSummaryArtifactRecord;
  validation: RtcBaselineFinalizedArtifactValidation;
}
export interface RtcBaselineComparisonChoiceInput {
  primaryBaselineId: string;
  comparisonBaselineId: string;
  inputPath: string;
  workloadId: RtcBaselineWorkloadId;
}
export interface RtcBaselineComparisonChoice {
  primary: RtcBaselineSummaryArtifactRecord;
  selected: RtcBaselineSummaryArtifactRecord;
  selectedId: string;
  repeatRequired: boolean;
  stillNoisy: boolean;
  environment: RtcBaselineEnvironmentDto & { observation: RtcBaselineRuntimeObservationDto };
}
export interface RtcBaselineFinalizedReaderDependencies {
  readJson(baselineId: string, path: string): Promise<RtcBaselineResult<RtcBaselineJson>>;
  readBytes(baselineId: string, path: string): Promise<RtcBaselineResult<Uint8Array>>;
  listArtifactPaths(baselineId: string): Promise<RtcBaselineResult<string[]>>;
  sha256(bytes: Uint8Array): Promise<string>;
}
type RtcBaselineValidationRead = Promise<RtcBaselineResult<RtcBaselineFinalizedArtifactValidation>>;
type RtcBaselinePrimaryRead = Promise<RtcBaselineResult<RtcBaselineVerifiedRepeatPrimary>>;
type RtcBaselineRepeatRead = Promise<RtcBaselineResult<RtcBaselineRepeatRequirement>>;
type RtcBaselinePairedRead = Promise<RtcBaselineResult<RtcBaselinePairedComparison>>;
export interface RtcBaselineFinalizedReader {
  readExternalAttempts(input: {
    baselineId: string;
    workloadId: RtcBaselineWorkloadId;
  }): Promise<RtcBaselineResult<readonly RtcBaselineAttemptLocatorDto[]>>;
  readBaselineValidation(input: RtcBaselineReaderInput): RtcBaselineValidationRead;
  readVerifiedRepeatPrimary(input: RtcBaselineReaderInput): RtcBaselinePrimaryRead;
  readRepeatRequirement(input: RtcBaselineReaderInput): RtcBaselineRepeatRead;
  readPairedComparison(input: RtcBaselinePairedComparisonInput): RtcBaselinePairedRead;
}
export interface RtcBaselineVerifiedStoredArtifact {
  kind: RtcBaselineArtifactKind | null;
  json: RtcBaselineJson | null;
}
const artifactKindsBySchema: Readonly<Record<string, RtcBaselineArtifactKind>> = {
  'rallar.rtc-baseline.environment.v1': 'environment',
  'rallar.rtc-baseline.external-attempt.v1': 'external-attempt',
  'rallar.rtc-baseline.external-cohort.v1': 'external-cohort',
  'rallar.rtc-baseline.finalization-failure.v1': 'finalization-failure',
  'rallar.rtc-baseline.manifest.v1': 'manifest',
  'rallar.rtc-baseline.sample.v1': 'sample',
  'rallar.rtc-baseline.summary.v1': 'summary',
};
function rejected(path: string, code: string, message: string): RtcBaselineResult<never> {
  return { ok: false, issues: [{ path, code, message }] };
}
export function rtcBaselineArtifactKindFromSchema(value: RtcBaselineJson) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false as const,
      issues: [{ path: '$', code: 'expected-object', message: 'Expected a plain object.' }],
    };
  }
  const schema = Reflect.get(value, 'schema');
  const kind = typeof schema === 'string' ? artifactKindsBySchema[schema] : undefined;
  return kind
    ? { ok: true as const, value: kind }
    : rejected(
        '$.schema',
        'unsupported-artifact-schema',
        'Artifact schema is not retained by the RTC baseline protocol.',
      );
}
export function classifyRtcBaselineArtifactPath(relativePath: string) {
  if (relativePath === RTC_BASELINE_ENVIRONMENT_FILE) return 'environment' as const;
  if (relativePath === RTC_BASELINE_MANIFEST_FILE) return 'manifest' as const;
  if (relativePath === RTC_BASELINE_SUMMARY_FILE) return 'summary' as const;
  if (/^results\/samples\/[^/]+\.json$/.test(relativePath)) return 'sample' as const;
  if (/^results\/external-attempts\/[^/]+\.json$/.test(relativePath))
    return 'external-attempt' as const;
  if (/^results\/external-cohorts\/[^/]+\.json$/.test(relativePath))
    return 'external-cohort' as const;
  if (/^results\/failures\/[^/]+\.json$/.test(relativePath)) return 'failure-outcome' as const;
  if (/^results\/finalization-failures\/[^/]+\.json$/.test(relativePath))
    return 'finalization-failure' as const;
  if (
    !relativePath.startsWith('artifacts/staging/') &&
    /^artifacts\/[^/]+(?:\/[^/]+)*$/.test(relativePath)
  )
    return 'raw' as const;
  return null;
}
export function validateRtcBaselineRawArtifactMembership(input: {
  retainedArtifactPaths: readonly string[];
  rawReferencePaths: readonly string[];
}) {
  const retainedRawPaths = input.retainedArtifactPaths.filter(
    (path) => classifyRtcBaselineArtifactPath(path) === 'raw',
  );
  const issues: Array<{ path: string; code: string; message: string }> = [];
  input.rawReferencePaths.forEach((path, index) => {
    if (!retainedRawPaths.includes(path)) {
      issues.push({
        path: `$.summary.rawReferences[${index}].relativePath`,
        code: 'missing-raw-artifact',
        message: `Raw reference ${path} is not retained.`,
      });
    }
  });
  retainedRawPaths.forEach((path) => {
    if (!input.rawReferencePaths.includes(path)) {
      issues.push({
        path: '$.retainedArtifactPaths',
        code: 'unreferenced-raw-artifact',
        message: `Retained raw artifact ${path} is not referenced.`,
      });
    }
  });
  return issues;
}
export function validateRtcBaselineRawArtifactIntegrity(input: {
  rawReferences: readonly RtcBaselineRawReferenceDto[];
  checksumEntries: ReadonlyMap<string, string>;
}) {
  return input.rawReferences.flatMap((reference, index) =>
    input.checksumEntries.get(reference.relativePath) === reference.sha256
      ? []
      : [
          {
            path: `$.summary.rawReferences[${index}].sha256`,
            code: 'raw-reference-checksum-mismatch',
            message: 'Raw reference digest differs from SHA256SUMS.',
          },
        ],
  );
}
export function canonicalizeRtcBaselineRawReferences(
  references: readonly RtcBaselineRawReferenceDto[],
): RtcBaselineResult<readonly RtcBaselineRawReferenceDto[]> {
  const byPath = new Map<string, RtcBaselineRawReferenceDto>();
  for (const reference of references) {
    const existing = byPath.get(reference.relativePath);
    if (existing && (existing.sha256 !== reference.sha256 || existing.bytes !== reference.bytes))
      return rejected(
        '$.rawReferences',
        'conflicting-raw-reference',
        `Raw reference metadata conflicts for ${reference.relativePath}.`,
      );
    byPath.set(reference.relativePath, reference);
  }
  return {
    ok: true,
    value: [...byPath.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
  };
}
export function validateRtcBaselineChecksumMembership(
  retainedPaths: readonly string[],
  entries: ReadonlyMap<string, string>,
) {
  const issues: Array<{ path: string; code: string; message: string }> = [];
  for (const path of retainedPaths) {
    if (!entries.has(path))
      issues.push({
        path: '$.SHA256SUMS',
        code: 'missing-checksum-entry',
        message: `Missing checksum for ${path}.`,
      });
  }
  for (const path of entries.keys()) {
    if (!retainedPaths.includes(path))
      issues.push({
        path: '$.SHA256SUMS',
        code: 'extra-checksum-entry',
        message: `Checksum references unretained path ${path}.`,
      });
  }
  return issues;
}
export function validateRtcBaselineRepeatLinkIdentity(
  baselineId: string,
  repeatLink: RtcBaselineRepeatLinkDto | null,
): RtcBaselineResult<void> {
  const suffix = '-repeat-01';
  const isRepeat = baselineId.endsWith(suffix);
  if (repeatLink === null)
    return isRepeat
      ? rejected(
          '$.repeatLink',
          'missing-repeat-link',
          'A -repeat-01 baseline requires its primary repeat link.',
        )
      : { ok: true, value: undefined };
  return isRepeat && repeatLink.primaryBaselineId === baselineId.slice(0, -suffix.length)
    ? { ok: true, value: undefined }
    : rejected(
        '$.repeatLink.primaryBaselineId',
        'invalid-repeat-primary',
        'Repeat links must match the exact -repeat-01 baseline suffix.',
      );
}
type RtcBaselineRepeatDigestSource = 'checksum' | 'summary-bytes';
export function validateRtcBaselineRepeatPrimaryDigest(input: {
  summary: RtcBaselineSummaryArtifactRecord;
  sha256: string;
  source: RtcBaselineRepeatDigestSource;
}): RtcBaselineResult<void> {
  const link = input.summary.repeatLink;
  if (link === null || input.sha256 === link.primarySummarySha256)
    return { ok: true, value: undefined };
  const checksum = input.source === 'checksum';
  return rejected(
    '$.repeatLink.primarySummarySha256',
    checksum ? 'repeat-primary-checksum-mismatch' : 'repeat-primary-hash-mismatch',
    checksum
      ? 'Repeat link does not match primary SHA256SUMS.'
      : 'Repeat link does not match the primary summary bytes.',
  );
}
export function inspectRtcBaselineStoredArtifactBytes(input: {
  relativePath: string;
  bytes: Uint8Array;
}): RtcBaselineResult<RtcBaselineVerifiedStoredArtifact> {
  const pathKind = classifyRtcBaselineArtifactPath(input.relativePath);
  if (pathKind === 'raw') return { ok: true, value: { kind: null, json: null } };
  if (pathKind === null)
    return rejected(
      `$.${input.relativePath}`,
      'unsupported-artifact-path',
      'Artifact path is not typed.',
    );
  let json: RtcBaselineJson;
  try {
    json = JSON.parse(new TextDecoder().decode(input.bytes));
  } catch {
    return rejected(`$.${input.relativePath}`, 'malformed-json', 'Stored bytes are not JSON.');
  }
  if (pathKind === 'failure-outcome') return { ok: true, value: { kind: null, json } };
  const classified = rtcBaselineArtifactKindFromSchema(json);
  if (!classified.ok) return classified;
  if (classified.value !== pathKind)
    return rejected(
      `$.${input.relativePath}.schema`,
      'artifact-schema-path-mismatch',
      'Artifact schema does not match its retained path.',
    );
  return { ok: true, value: { kind: classified.value, json } };
}
export function inspectRtcBaselineChecksumEntries(bytes: Uint8Array) {
  const entries = new Map<string, string>();
  const issues: Array<{ path: string; code: string; message: string }> = [];
  new TextDecoder()
    .decode(bytes)
    .split('\n')
    .forEach((line, index) => {
      if (line.length === 0) return;
      const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
      if (!match) {
        issues.push({
          path: `$.SHA256SUMS[${index}]`,
          code: 'malformed-checksum-entry',
          message: 'Expected lowercase SHA-256, two spaces, and a relative path.',
        });
        return;
      }
      const path = match[2]!;
      if (entries.has(path)) {
        issues.push({
          path: `$.SHA256SUMS[${index}]`,
          code: 'duplicate-checksum-entry',
          message: `Checksum path ${path} appears more than once.`,
        });
      } else if (
        path.length === 0 ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').includes('..')
      ) {
        issues.push({
          path: `$.SHA256SUMS[${index}]`,
          code: 'unconfined-checksum-path',
          message: 'Checksum paths must be relative and non-traversing.',
        });
      } else {
        entries.set(path, match[1]!);
      }
    });
  return { entries, issues };
}
export function rtcBaselineSampleArtifactPath(sampleId: string) {
  return `samples/${sampleId}.json`;
}
export function rtcBaselineFailureArtifactPath(failureId: string, identity: string) {
  return `failures/${failureId}-${identity}.json`;
}
export function encodeRtcBaselineChecksumEntries(
  entries: readonly { sha256: string; relativePath: string }[],
) {
  const orderedEntries = [...entries].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return new TextEncoder().encode(
    orderedEntries.map((entry) => `${entry.sha256}  ${entry.relativePath}`).join('\n') + '\n',
  );
}
