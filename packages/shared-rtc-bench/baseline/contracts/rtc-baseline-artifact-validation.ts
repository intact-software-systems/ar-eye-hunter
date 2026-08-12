import { validateRtcBaselineId } from './rtc-baseline-validation.ts';
import type {
  RtcBaselineCaptureManifestDto,
  RtcBaselineCohortIdentityDto,
  RtcBaselineEnvironmentDto,
  RtcBaselineExternalAttemptDto,
  RtcBaselineExternalCohortDto,
  RtcBaselineFinalizationFailureDto,
  RtcBaselineRuntimeObservationDto,
  RtcBaselineJson,
  RtcBaselineSampleDto,
  RtcBaselineSampleIdentityDto,
  RtcBaselineSummaryDto,
} from './rtc-baseline-contracts.ts';
import type {
  RtcBaselineStoredArtifact,
  RtcBaselineSummaryArtifactRecord,
} from '../evidence/rtc-baseline-evidence-layout.ts';
type AccountingIdentity = RtcBaselineSampleIdentityDto | RtcBaselineCohortIdentityDto;
type FailureIdentity = Pick<RtcBaselineFinalizationFailureDto, 'baselineId'>;
type RuntimeObservation = RtcBaselineRuntimeObservationDto;
export interface RtcBaselineAccountingOutcomeRecord {
  identity: AccountingIdentity;
}
const issue = (path: string, code: string, message: string) => ({ path, code, message });
type Issue = ReturnType<typeof issue>;
type IssueInput = readonly [path: string, code: string, message: string];
function reportIf(issues: Issue[], invalid: boolean, problem: IssueInput) {
  if (invalid) issues.push(issue(...problem));
}
function same<Left, Right>(left: Left, right: Right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
const semanticMessages = {
  'artifact-workload-list-mismatch': 'Manifest workload list differs.',
  'attempt-evidence-class-mismatch': 'External attempt sample has the wrong evidence class.',
  'attempt-outcome-projection-mismatch':
    'External attempt outcomes must exactly project its samples.',
  'attempt-sample-identity-mismatch': 'External attempt sample identity differs from its locator.',
  'cohort-evidence-class-mismatch':
    'External cohort samples must contain local full-stack evidence.',
  'cohort-member-samples-mismatch':
    'External cohort samples must exactly match its ordered member sample IDs.',
  'cohort-workload-mismatch': 'External cohort sample workload differs from its cohort.',
  'duplicate-member-sample': 'Cohort member sample IDs must be unique.',
  'invalid-timing-order': 'Runtime observation must end after it starts.',
  'missing-runtime-observation': 'Metric samples require observation.',
  'non-passing-finalized-outcome': 'Every finalized outcome must pass.',
  'passed-with-issues': 'Passed samples cannot contain correctness issues.',
  'producer-fact-mismatch': 'Stored B06 producer facts do not match the selected case.',
  'repeat-link-mismatch': 'Manifest request and artifact repeat links must match.',
  'sample-id-mismatch': 'Sample ID does not match its identity fields.',
  'workload-list-mismatch': 'Manifest workload order must match its request.',
} as const;
type SemanticCode = keyof typeof semanticMessages;
function semanticIssue(path: string, code: SemanticCode): Issue {
  return issue(path, code, semanticMessages[code]);
}
export function validateRtcBaselineNumberRule(
  value: RtcBaselineJson | object | undefined,
  rule: { integer?: boolean; minimum?: number; values?: readonly number[] },
  path: string,
) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return [issue(path, 'expected-number', 'Expected a number.')];
  const integerKind = rule.minimum === 1 ? 'positive' : 'nonnegative';
  if (rule.integer && (!Number.isInteger(value) || value < (rule.minimum ?? 0))) {
    return [issue(path, `expected-${integerKind}-integer`, `Expected a ${integerKind} integer.`)];
  }
  if (rule.minimum !== undefined && value < rule.minimum)
    return [issue(path, 'expected-nonnegative-number', 'Expected a nonnegative number.')];
  return rule.values && !rule.values.includes(value)
    ? [issue(path, 'unsupported-value', `Expected ${rule.values.join(' or ')}.`)]
    : [];
}
type StringFormat = 'baselineId' | 'gitHash' | 'path' | 'sha256' | 'timestamp';
export function validateRtcBaselineStringRule(
  value: RtcBaselineJson | object | undefined,
  rule: { values?: readonly string[]; format?: StringFormat },
  path: string,
) {
  if (typeof value !== 'string') return [issue(path, 'expected-string', 'Expected a string.')];
  if (rule.values && !rule.values.includes(value))
    return [issue(path, 'unsupported-value', 'Unsupported value.')];
  if (rule.format === 'sha256' && !/^[0-9a-f]{64}$/.test(value))
    return [issue(path, 'invalid-sha256', 'Expected a lowercase 64-character SHA-256 digest.')];
  if (
    rule.format === 'baselineId' &&
    !/^\d{8}-[0-9a-f]{12}-e[1-5]-(?:local|browser|memory|pg|remote)(?:-repeat-01)?$/.test(value)
  )
    return [
      issue(path, 'invalid-baseline-id', 'Baseline ID does not match the canonical grammar.'),
    ];
  if (rule.format === 'gitHash' && !/^[0-9a-f]{40}$/.test(value))
    return [issue(path, 'invalid-git-hash', 'Expected a lowercase 40-character Git hash.')];
  if (
    rule.format === 'path' &&
    (value.length === 0 ||
      value.startsWith('/') ||
      value.includes('\\') ||
      value.split('/').includes('..'))
  )
    return [issue(path, 'invalid-relative-path', 'Expected a confined relative path.')];
  return rule.format === 'timestamp' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ? [issue(path, 'invalid-timestamp', 'Expected an ISO 8601 UTC timestamp.')]
    : [];
}
function fieldValue(value: object, field: PropertyKey) {
  return Reflect.get(value, field);
}
const attemptLocatorFields = [
  'workloadId',
  'caseId',
  'inputKey',
  'intendedPhase',
  'outerOrdinal',
] as const;
function expectedSampleId(identity: RtcBaselineSampleIdentityDto) {
  const workload = String(identity.workloadId).slice(4).toLowerCase();
  const outer = String(identity.outerOrdinal).padStart(3, '0');
  const inner = String(identity.innerOrdinal).padStart(3, '0');
  const sampleCase = `${workload}-${identity.caseId}-${identity.inputKey}`;
  return `rtc-${sampleCase}-${identity.intendedPhase}-${outer}-${inner}`;
}
export function validateRtcBaselineManifest(manifest: RtcBaselineCaptureManifestDto) {
  const issues = [...validateRtcBaselineId(manifest.request.baselineId)];
  if (!same(manifest.request.repeatLink, manifest.repeatLink))
    issues.push(semanticIssue('$.repeatLink', 'repeat-link-mismatch'));
  if (!same(manifest.request.workloadIds, manifest.workloadIds))
    issues.push(semanticIssue('$.workloadIds', 'workload-list-mismatch'));
  return issues;
}
export function validateRtcBaselineSample(sample: RtcBaselineSampleDto) {
  const issues: Issue[] = [];
  if (sample.identity.sampleId !== expectedSampleId(sample.identity))
    issues.push(semanticIssue('$.identity.sampleId', 'sample-id-mismatch'));
  if (sample.outcome === 'passed' && sample.issues.length > 0)
    issues.push(semanticIssue('$.issues', 'passed-with-issues'));
  return issues;
}
export function validateRtcBaselineSummary(summary: Pick<RtcBaselineSummaryDto, 'baselineId'>) {
  return validateRtcBaselineId(summary.baselineId);
}
export function validateRtcBaselinePassingSummary(summary: RtcBaselineSummaryArtifactRecord) {
  const outcomes = [...summary.sampleOutcomes, ...summary.cohortOutcomes];
  const failed = outcomes.some((outcome) => outcome.outcome !== 'passed');
  return failed ? [semanticIssue('$.summary', 'non-passing-finalized-outcome')] : [];
}
export function validateRtcBaselineFinalizationFailure(failure: FailureIdentity) {
  return validateRtcBaselineId(failure.baselineId);
}
export function validateRtcBaselineExternalCohort(cohort: RtcBaselineExternalCohortDto) {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  cohort.identity.memberSampleIds.forEach((sampleId: string, index: number) => {
    if (seen.has(sampleId))
      issues.push(semanticIssue(`$.identity.memberSampleIds[${index}]`, 'duplicate-member-sample'));
    seen.add(sampleId);
  });
  const sampleIds = cohort.samples.map(({ identity }) => identity.sampleId);
  if (!same(cohort.identity.memberSampleIds, sampleIds))
    issues.push(semanticIssue('$.samples', 'cohort-member-samples-mismatch'));
  cohort.samples.forEach((sample, index) => {
    if (sample.identity.workloadId !== cohort.identity.workloadId)
      issues.push(
        semanticIssue(`$.samples[${index}].identity.workloadId`, 'cohort-workload-mismatch'),
      );
    if (sample.evidenceClass !== 'local-full-stack')
      issues.push(
        semanticIssue(`$.samples[${index}].evidenceClass`, 'cohort-evidence-class-mismatch'),
      );
  });
  return issues;
}
export function validateRtcBaselineRuntimeObservation(observation: RuntimeObservation) {
  const { startedAtUtc, endedAtUtc } = observation.timing;
  return Date.parse(endedAtUtc) < Date.parse(startedAtUtc)
    ? [semanticIssue('$.timing.endedAtUtc', 'invalid-timing-order')]
    : [];
}
export function validateRtcBaselineExternalAttempt(attempt: RtcBaselineExternalAttemptDto) {
  const facts = attempt.producerFacts;
  const issues: Issue[] = [];
  const expectsAllScenarios = attempt.locator.caseId === 'all-scenarios';
  if (
    facts.allScenariosPresent !== expectsAllScenarios ||
    facts.allScenariosRaw !== (expectsAllScenarios ? '1' : null)
  )
    issues.push(semanticIssue('$.producerFacts.allScenariosRaw', 'producer-fact-mismatch'));
  const expectsRetention = attempt.locator.caseId === 'retention-100';
  if (
    facts.retentionSoakPresent !== expectsRetention ||
    facts.retentionSoakRaw !== (expectsRetention ? '1' : null) ||
    facts.retentionCyclesPresent !== expectsRetention ||
    facts.retentionCyclesRaw !== (expectsRetention ? '100' : null)
  )
    issues.push(semanticIssue('$.producerFacts.retentionSoakRaw', 'producer-fact-mismatch'));
  const expectedEvidence =
    attempt.locator.workloadId === 'RTC-B05'
      ? 'native-browser'
      : attempt.locator.workloadId === 'RTC-B06'
        ? 'local-full-stack'
        : null;
  attempt.samples.forEach((sample, index) => {
    const identityDiffers = attemptLocatorFields.some(
      (field) => sample.identity[field] !== attempt.locator[field],
    );
    if (identityDiffers)
      issues.push(
        semanticIssue(`$.samples[${index}].identity`, 'attempt-sample-identity-mismatch'),
      );
    if (expectedEvidence !== null && sample.evidenceClass !== expectedEvidence)
      issues.push(
        semanticIssue(`$.samples[${index}].evidenceClass`, 'attempt-evidence-class-mismatch'),
      );
  });
  const projectedOutcomes = attempt.samples.map(({ identity, outcome, issues: sampleIssues }) => ({
    identity,
    outcome,
    issues: sampleIssues,
  }));
  if (!same(attempt.sampleOutcomes, projectedOutcomes))
    issues.push(semanticIssue('$.sampleOutcomes', 'attempt-outcome-projection-mismatch'));
  return issues;
}
type AccountingKind = 'sample' | 'cohort';
type OutcomeProblem = 'duplicate' | 'extra' | 'identity';
function accountingId(identity: AccountingIdentity, kind: AccountingKind) {
  if (kind === 'sample' && 'sampleId' in identity) return identity.sampleId;
  if (kind === 'cohort' && 'cohortId' in identity) return identity.cohortId;
  return '';
}
function outcomeIssue(kind: AccountingKind, index: number, problem: OutcomeProblem) {
  const label = kind === 'sample' ? 'Sample' : 'Cohort';
  const identityMismatch = problem === 'identity';
  return issue(
    `$.${kind}Outcomes[${index}]${identityMismatch ? '.identity' : ''}`,
    identityMismatch ? `${kind}-identity-mismatch` : `${problem}-${kind}-outcome`,
    identityMismatch
      ? `${label} identity differs.`
      : `${label} outcome is ${problem === 'duplicate' ? 'duplicated' : 'extra'}.`,
  );
}
function validateOutcomeSet(
  expected: readonly AccountingIdentity[],
  outcomes: readonly RtcBaselineAccountingOutcomeRecord[],
  kind: AccountingKind,
) {
  const seen = new Set<string>();
  const expectedById = new Map(
    expected.map((identity) => [accountingId(identity, kind), identity]),
  );
  const issues: Issue[] = [];
  outcomes.forEach((outcome, index) => {
    const id = accountingId(outcome.identity, kind);
    const expectedIdentity = expectedById.get(id);
    const problem: OutcomeProblem | null = seen.has(id)
      ? 'duplicate'
      : !expectedIdentity
        ? 'extra'
        : !same(expectedIdentity, outcome.identity)
          ? 'identity'
          : null;
    if (problem !== null) issues.push(outcomeIssue(kind, index, problem));
    seen.add(id);
  });
  if (expected.some((identity) => !seen.has(accountingId(identity, kind))))
    issues.push(
      issue(
        `$.${kind}Outcomes`,
        `missing-${kind}-outcome`,
        `${kind === 'sample' ? 'Sample' : 'Cohort'} outcome is missing.`,
      ),
    );
  return issues;
}
export function validateRtcBaselineCompleteAccounting(input: {
  expectedSamples: readonly AccountingIdentity[];
  expectedCohorts: readonly AccountingIdentity[];
  sampleOutcomes: readonly RtcBaselineAccountingOutcomeRecord[];
  cohortOutcomes: readonly RtcBaselineAccountingOutcomeRecord[];
}) {
  return [
    ...validateOutcomeSet(input.expectedSamples, input.sampleOutcomes, 'sample'),
    ...validateOutcomeSet(input.expectedCohorts, input.cohortOutcomes, 'cohort'),
  ];
}
export function validateRtcBaselineReconciliation<Observation extends object>(
  initialized: Observation,
  current: Observation,
) {
  const fields = [
    'git',
    'runtime',
    'host',
    'sourceHashes',
    'configurationInputs',
    'resolvedConfiguration',
    'controllerInputs',
    'workerCommand',
    'allowlistedEnvironment',
  ] as const;
  const issues: Issue[] = [];
  for (const field of fields) {
    reportIf(issues, !same(fieldValue(initialized, field), fieldValue(current, field)), [
      `$.${field}`,
      'reconciliation-mismatch',
      `Runtime observation field ${field} changed.`,
    ]);
  }
  return issues;
}
export function validateRtcBaselineRetainedSampleObservations(
  environment: RtcBaselineRuntimeObservationDto | null,
  samples: readonly RtcBaselineSampleDto[],
) {
  return samples.flatMap((sample, index) => {
    if (sample.identity.intendedPhase !== 'retained') return [];
    if (sample.runtimeObservation === null)
      return sample.metrics.length === 0
        ? []
        : [semanticIssue(`$.samples[${index}].runtimeObservation`, 'missing-runtime-observation')];
    if (environment === null)
      return [issue('$.environment.observation', 'missing-runtime-observation', 'Required.')];
    return validateRtcBaselineReconciliation(environment, sample.runtimeObservation).map(
      (problem) => ({
        ...problem,
        path: `$.samples[${index}].runtimeObservation${problem.path.slice(1)}`,
      }),
    );
  });
}
export function validateRtcBaselineArtifactReconciliation(input: {
  baselineId: string;
  environment: RtcBaselineEnvironmentDto;
  manifest: RtcBaselineCaptureManifestDto;
  summary: RtcBaselineSummaryArtifactRecord;
}) {
  const issues: Issue[] = [];
  const { environment, manifest, summary } = input;
  const { request } = manifest;
  for (const [owner, label, actual] of [
    ['environment', 'Environment', environment.baselineId],
    ['manifest.request', 'Manifest', request.baselineId],
    ['summary', 'Summary', summary.baselineId],
  ] as const) {
    reportIf(issues, actual !== input.baselineId, [
      `$.${owner}.baselineId`,
      'artifact-baseline-id-mismatch',
      `${label} baseline ID differs.`,
    ]);
  }
  if (!same(manifest.workloadIds, request.workloadIds))
    issues.push(semanticIssue('$.manifest.workloadIds', 'artifact-workload-list-mismatch'));
  const facts = [
    ['workloadIds', request.workloadIds, 'workload-list', 'workload list differs'],
    ['environmentId', request.environmentId, 'environment-id', 'environment differs'],
    ['repeatLink', manifest.repeatLink, 'repeat-link', 'repeat link differs'],
    [
      'conditionalEnvironmentDecisions',
      request.conditionalEnvironmentDecisions,
      'decisions',
      'decisions differ',
    ],
  ] as const;
  for (const [owner, label, artifact] of [
    ['environment', 'Environment', environment],
    ['summary', 'Summary', summary],
  ] as const) {
    for (const [field, expected, code, description] of facts) {
      reportIf(issues, !same(Reflect.get(artifact, field), expected), [
        `$.${owner}.${field}`,
        `artifact-${code}-mismatch`,
        `${label} ${description}.`,
      ]);
    }
  }
  return issues;
}
export function validateRtcBaselineStoredArtifact(value: RtcBaselineStoredArtifact) {
  if (value.schema === 'rallar.rtc-baseline.environment.v1' && value.observation !== null)
    return validateRtcBaselineRuntimeObservation(value.observation);
  if (value.schema === 'rallar.rtc-baseline.environment.v1') return [];
  if (value.schema === 'rallar.rtc-baseline.manifest.v1') return validateRtcBaselineManifest(value);
  if (value.schema === 'rallar.rtc-baseline.sample.v1') {
    const observationIssues = value.runtimeObservation
      ? validateRtcBaselineRuntimeObservation(value.runtimeObservation)
      : [];
    return [...validateRtcBaselineSample(value), ...observationIssues];
  }
  if (value.schema === 'rallar.rtc-baseline.external-attempt.v1')
    return validateRtcBaselineExternalAttempt(value);
  if (value.schema === 'rallar.rtc-baseline.external-cohort.v1')
    return validateRtcBaselineExternalCohort(value);
  if (value.schema === 'rallar.rtc-baseline.finalization-failure.v1')
    return validateRtcBaselineFinalizationFailure(value);
  return validateRtcBaselineSummary(value);
}
