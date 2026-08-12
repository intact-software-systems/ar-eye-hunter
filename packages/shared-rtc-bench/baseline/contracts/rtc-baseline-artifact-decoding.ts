import type * as Artifact from './rtc-baseline-contracts.ts';
import type { RtcBaselineJson, RtcBaselineResult } from './rtc-baseline-contracts.ts';
import type {
  RtcBaselineArtifactKind,
  RtcBaselineStoredArtifact,
  RtcBaselineSummaryArtifactRecord,
} from '../evidence/rtc-baseline-evidence-layout.ts';
import {
  validateRtcBaselineNumberRule,
  validateRtcBaselineStringRule,
} from './rtc-baseline-artifact-validation.ts';
import { normalizeRtcBaselineJson } from './rtc-baseline-decoding.ts';
type Rule =
  | { kind: 'json' }
  | { kind: 'scalar'; nullable: boolean }
  | {
      kind: 'string';
      values?: readonly string[];
      format?: 'baselineId' | 'gitHash' | 'path' | 'sha256' | 'timestamp';
    }
  | { kind: 'number'; integer?: boolean; minimum?: number; values?: readonly number[] }
  | { kind: 'boolean' }
  | { kind: 'array'; item: Rule }
  | { kind: 'object'; fields: Record<string, Rule> }
  | { kind: 'record'; value: Rule }
  | { kind: 'optional'; value: Rule }
  | { kind: 'nullable'; value: Rule };
type StringFormat = Extract<Rule, { kind: 'string' }>['format'];
type EnvironmentArtifact = Artifact.RtcBaselineEnvironmentDto;
type ManifestArtifact = Artifact.RtcBaselineCaptureManifestDto;
const jsonValue = (): Rule => ({ kind: 'json' });
const scalar = (nullable: boolean): Rule => ({ kind: 'scalar', nullable });
const string = (values?: readonly string[]): Rule => ({ kind: 'string', values });
const formatted = (format: StringFormat): Rule => ({ kind: 'string', format });
const number = (minimum?: number, integer = false, values?: readonly number[]): Rule => ({
  kind: 'number',
  minimum,
  integer,
  values,
});
const boolean = (): Rule => ({ kind: 'boolean' });
const array = (item: Rule): Rule => ({ kind: 'array', item });
const object = (fields: Record<string, Rule>): Rule => ({ kind: 'object', fields });
const record = (value: Rule): Rule => ({ kind: 'record', value });
const optional = (value: Rule): Rule => ({ kind: 'optional', value });
const nullable = (value: Rule): Rule => ({ kind: 'nullable', value });
const workload = string(['RTC-B01', 'RTC-B02', 'RTC-B03', 'RTC-B04', 'RTC-B05', 'RTC-B06']);
const environment = string(['E1-local', 'E2-browser', 'E3-memory', 'E4-pg', 'E5-remote']);
const phase = string(['warmup', 'retained']);
const issueShape = object({
  path: string(),
  code: string(),
  message: string(),
  details: optional(jsonValue()),
});
const caseKeyShape = object({ workloadId: workload, caseId: string(), inputKey: string() });
const identityShape = object({
  sampleId: string(),
  workloadId: workload,
  caseId: string(),
  inputKey: string(),
  intendedPhase: phase,
  outerOrdinal: number(1, true),
  innerOrdinal: number(1, true),
});
const cohortIdentityShape = object({
  cohortId: string(),
  workloadId: workload,
  memberSampleIds: array(string()),
});
const repeatShape = object({
  primaryBaselineId: formatted('baselineId'),
  primarySummarySha256: formatted('sha256'),
});
const decisionShape = object({
  environmentId: environment,
  decision: string(['required', 'not-required']),
  reason: string(),
});
const rawReferenceShape = object({
  relativePath: formatted('path'),
  sha256: formatted('sha256'),
  bytes: number(0, true),
});
const sampleOutcomeShape = object({
  identity: identityShape,
  outcome: string(['passed', 'failed', 'not-run']),
  issues: array(issueShape),
});
const cohortOutcomeShape = object({
  identity: cohortIdentityShape,
  outcome: string(['passed', 'failed']),
  issues: array(issueShape),
});
const configurationInputShape = object({
  name: string(),
  value: scalar(true),
  secret: boolean(),
});
const resolvedConfigurationShape = object({
  caseKey: caseKeyShape,
  field: string(),
  value: scalar(false),
  source: string(['default', 'environment', 'controller', 'cli']),
});
const runtimeObservationShape = object({
  git: object({
    headCommit: formatted('gitHash'),
    headTree: formatted('gitHash'),
    ref: string(),
    clean: boolean(),
  }),
  runtime: object({
    node: string(),
    npm: string(),
    deno: string(),
    playwright: string(),
    chromium: string(),
  }),
  host: object({
    os: string(),
    kernel: string(),
    architecture: string(),
    logicalCpuCount: number(1, true),
    cpuModel: string(),
    totalMemoryBytes: number(0, true),
    executionContext: string(['local', 'distributed']),
  }),
  timing: object({
    startedAtUtc: formatted('timestamp'),
    endedAtUtc: formatted('timestamp'),
    monotonicDurationMs: number(0),
    monotonicSource: string(),
  }),
  deviations: array(string()),
  sourceHashes: array(
    object({
      path: formatted('path'),
      sha256: formatted('sha256'),
      kind: string(['source', 'config']),
    }),
  ),
  configurationInputs: array(configurationInputShape),
  resolvedConfiguration: array(resolvedConfigurationShape),
  controllerInputs: array(configurationInputShape),
  workerCommand: object({
    redactedArgv: object({ executable: string(), arguments: array(string()) }),
    projection: object({ fixedWorkerFlags: array(string()), configurationFlags: array(string()) }),
  }),
  allowlistedEnvironment: record(string()),
});
const sampleShape = object({
  schema: string(['rallar.rtc-baseline.sample.v1']),
  identity: identityShape,
  outcome: string(['passed', 'failed', 'not-run']),
  evidenceClass: string(['synthetic-path', 'native-browser', 'local-full-stack']),
  metrics: array(object({ metric: string(), unit: string(), value: number() })),
  rawEvidence: jsonValue(),
  rawReferences: array(rawReferenceShape),
  issues: array(issueShape),
  runtimeObservation: nullable(runtimeObservationShape),
});
const requestShape = object({
  schema: string(['rallar.rtc-baseline.capture-request.v1']),
  baselineId: formatted('baselineId'),
  workloadIds: array(workload),
  environmentId: environment,
  retainedSampleMultiplier: number(1, true, [1, 2]),
  repeatLink: nullable(repeatShape),
  conditionalEnvironmentDecisions: array(decisionShape),
});
const shapes = {
  environment: object({
    schema: string(['rallar.rtc-baseline.environment.v1']),
    baselineId: formatted('baselineId'),
    workloadIds: array(workload),
    environmentId: environment,
    repeatLink: nullable(repeatShape),
    conditionalEnvironmentDecisions: array(decisionShape),
    observation: nullable(runtimeObservationShape),
  }),
  manifest: object({
    schema: string(['rallar.rtc-baseline.manifest.v1']),
    request: requestShape,
    workloadIds: array(workload),
    cases: array(caseKeyShape),
    outerAttempts: array(
      object({
        workloadId: workload,
        caseId: string(),
        inputKey: string(),
        environmentId: environment,
        intendedPhase: phase,
        outerOrdinal: number(1, true),
        sampleIds: array(string()),
      }),
    ),
    expectedCohorts: array(cohortIdentityShape),
    repeatLink: nullable(repeatShape),
  }),
  sample: sampleShape,
  'external-attempt': object({
    schema: string(['rallar.rtc-baseline.external-attempt.v1']),
    locator: object({
      workloadId: workload,
      caseId: string(),
      inputKey: string(),
      intendedPhase: phase,
      outerOrdinal: number(1, true),
      environmentId: environment,
      rawResultRelativePath: formatted('path'),
    }),
    producerExitStatus: number(0, true),
    producerFacts: object({
      databaseUrl: string(['present', 'absent']),
      allScenariosPresent: boolean(),
      allScenariosRaw: nullable(string()),
      retentionSoakPresent: boolean(),
      retentionSoakRaw: nullable(string()),
      retentionCyclesPresent: boolean(),
      retentionCyclesRaw: nullable(string()),
      iceModePresent: boolean(),
      iceModeRaw: nullable(string()),
    }),
    sampleOutcomes: array(sampleOutcomeShape),
    samples: array(sampleShape),
    issues: array(issueShape),
  }),
  'external-cohort': object({
    schema: string(['rallar.rtc-baseline.external-cohort.v1']),
    identity: cohortIdentityShape,
    outcome: string(['passed', 'failed']),
    rawEvidence: jsonValue(),
    issues: array(issueShape),
    samples: array(sampleShape),
  }),
  'finalization-failure': object({
    schema: string(['rallar.rtc-baseline.finalization-failure.v1']),
    baselineId: formatted('baselineId'),
    failureId: string(),
    issues: array(issueShape),
    rawEvidence: jsonValue(),
  }),
  summary: object({
    schema: string(['rallar.rtc-baseline.summary.v1']),
    baselineId: formatted('baselineId'),
    workloadIds: array(workload),
    environmentId: environment,
    repeatLink: nullable(repeatShape),
    conditionalEnvironmentDecisions: array(decisionShape),
    sampleOutcomes: array(sampleOutcomeShape),
    cohortOutcomes: array(cohortOutcomeShape),
    metricSummaries: array(
      object({
        workloadId: workload,
        caseId: string(),
        inputKey: string(),
        metric: string(),
        unit: string(),
        count: number(0, true),
        minimum: number(),
        median: number(),
        maximum: number(),
        mad: number(0),
        coefficientOfVariation: number(0),
      }),
    ),
    rawReferences: array(rawReferenceShape),
  }),
  runtime: runtimeObservationShape,
};
function issue(path: string, code: string, message: string) {
  return { path, code, message };
}
interface ValidationInput {
  value: RtcBaselineJson | object | undefined;
  rule: Rule;
  path: string;
  issues: ReturnType<typeof issue>[];
}
function validate(input: ValidationInput) {
  const { value, rule, path, issues } = input;
  if (rule.kind === 'nullable') {
    if (value !== null) validate({ value, rule: rule.value, path, issues });
    return;
  }
  if (rule.kind === 'json') {
    const normalized = value === undefined ? null : normalizeRtcBaselineJson(value);
    if (normalized === null || !normalized.ok) {
      issues.push(issue(path, 'invalid-json-value', 'Expected a JSON value.'));
    }
    return;
  }
  if (rule.kind === 'scalar') {
    const valid =
      (rule.nullable && value === null) ||
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value));
    if (!valid) {
      issues.push(
        issue(
          path,
          'expected-scalar',
          rule.nullable
            ? 'Expected a boolean, number, string, or null.'
            : 'Expected a boolean, number, or string.',
        ),
      );
    }
    return;
  }
  if (rule.kind === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push(issue(path, 'expected-object', 'Expected a plain object.'));
      return;
    }
    const record = value as Record<string, RtcBaselineJson>;
    for (const [field, child] of Object.entries(rule.fields)) {
      const childPath = `${path}.${field}`;
      if (!Object.hasOwn(record, field)) {
        if (child.kind !== 'optional') issues.push(issue(childPath, 'missing-field', 'Required.'));
      } else {
        validate({
          value: record[field]!,
          rule: child.kind === 'optional' ? child.value : child,
          path: childPath,
          issues,
        });
      }
    }
    for (const field of Object.keys(record)) {
      if (!Object.hasOwn(rule.fields, field)) {
        issues.push(issue(`${path}.${field}`, 'unexpected-field', 'Unexpected field.'));
      }
    }
    return;
  }
  if (rule.kind === 'record') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push(issue(path, 'expected-object', 'Expected a plain object.'));
      return;
    }
    for (const [field, child] of Object.entries(value)) {
      validate({ value: child, rule: rule.value, path: `${path}.${field}`, issues });
    }
    return;
  }
  if (rule.kind === 'array') {
    if (!Array.isArray(value)) {
      issues.push(issue(path, 'expected-array', 'Expected an array.'));
      return;
    }
    for (let index = 0; index < value.length; index += 1) {
      const childPath = `${path}[${index}]`;
      if (!(index in value))
        issues.push(issue(childPath, 'sparse-array', 'Array entries must be dense JSON values.'));
      else validate({ value: value[index]!, rule: rule.item, path: childPath, issues });
    }
    return;
  }
  if (rule.kind === 'boolean') {
    if (typeof value !== 'boolean')
      issues.push(issue(path, 'expected-boolean', 'Expected a boolean.'));
    return;
  }
  if (rule.kind === 'number') {
    issues.push(...validateRtcBaselineNumberRule(value, rule, path));
    return;
  }
  if (rule.kind === 'string') issues.push(...validateRtcBaselineStringRule(value, rule, path));
}
function decode<T>(value: RtcBaselineJson, rule: Rule): RtcBaselineResult<T> {
  const issues: ReturnType<typeof issue>[] = [];
  validate({ value, rule, path: '$', issues });
  return issues.length === 0 ? { ok: true, value: value as T } : { ok: false, issues };
}
function decoder<T>(rule: Rule) {
  return (value: RtcBaselineJson) => decode<T>(value, rule);
}

export const decodeRtcBaselineEnvironment = decoder<EnvironmentArtifact>(shapes.environment);
export const decodeRtcBaselineManifest = decoder<ManifestArtifact>(shapes.manifest);
export const decodeRtcBaselineSample = decoder<Artifact.RtcBaselineSampleDto>(shapes.sample);
export const decodeRtcBaselineExternalAttempt = decoder<Artifact.RtcBaselineExternalAttemptDto>(
  shapes['external-attempt'],
);
export const decodeRtcBaselineExternalCohort = decoder<Artifact.RtcBaselineExternalCohortDto>(
  shapes['external-cohort'],
);
export const decodeRtcBaselineFinalizationFailure =
  decoder<Artifact.RtcBaselineFinalizationFailureDto>(shapes['finalization-failure']);
export const decodeRtcBaselineSummary = decoder<RtcBaselineSummaryArtifactRecord>(shapes.summary);
export const decodeRtcBaselineRuntimeObservation =
  decoder<Artifact.RtcBaselineRuntimeObservationDto>(shapes.runtime);

export function decodeRtcBaselineStoredJson(kind: RtcBaselineArtifactKind, value: RtcBaselineJson) {
  return decode<RtcBaselineStoredArtifact>(value, shapes[kind]);
}
