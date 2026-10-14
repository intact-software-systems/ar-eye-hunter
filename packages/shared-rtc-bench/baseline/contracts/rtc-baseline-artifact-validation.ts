import { jsonEquals } from '@shared/repository/state-utils.ts';

import type {
    RtcBaselineStoredArtifact,
    RtcBaselineSummaryArtifactRecord
} from '../evidence/rtc-baseline-evidence-layout.ts';
import { validateRtcB06ProductionServingProof } from '../observation/validate-rtc-b06-production-serving-proof.ts';
import {
    rtcBaselineIssue,
    type RtcBaselineCaptureManifestDto,
    type RtcBaselineCohortIdentityDto,
    type RtcBaselineEnvironmentDto,
    type RtcBaselineExternalAttemptDto,
    type RtcBaselineExternalCohortDto,
    type RtcBaselineFinalizationFailureDto,
    type RtcBaselineIssueDto,
    type RtcBaselineJson,
    type RtcBaselineRuntimeObservationDto,
    type RtcBaselineSampleDto,
    type RtcBaselineSampleIdentityDto,
    type RtcBaselineSummaryDto
} from './rtc-baseline-contracts.ts';
import { isRtcBaselineId } from './rtc-baseline-id.ts';
import { validateRtcBaselineId } from './rtc-baseline-validation.ts';

export interface RtcBaselineAccountingOutcomeRecord {
    identity: AccountingIdentity;
}

type AccountingIdentity = RtcBaselineSampleIdentityDto | RtcBaselineCohortIdentityDto;

type FailureIdentity = Pick<RtcBaselineFinalizationFailureDto, 'baselineId'>;

type IssueInput = readonly [path: string, code: string, message: string];

const semanticMessages = {
    'artifact-workload-list-mismatch': 'Manifest workload list differs.',
    'attempt-evidence-class-mismatch': 'External attempt sample has the wrong evidence class.',
    'attempt-outcome-projection-mismatch': 'External attempt outcomes must exactly project its samples.',
    'attempt-sample-identity-mismatch': 'External attempt sample identity differs from its locator.',
    'cohort-evidence-class-mismatch': 'External cohort samples must contain local full-stack evidence.',
    'cohort-member-samples-mismatch': 'External cohort samples must exactly match its ordered member sample IDs.',
    'cohort-workload-mismatch': 'External cohort sample workload differs from its cohort.',
    'duplicate-member-sample': 'Cohort member sample IDs must be unique.',
    'invalid-timing-order': 'Runtime observation must end after it starts.',
    'missing-runtime-observation': 'Metric samples require observation.',
    'non-passing-finalized-outcome': 'Every finalized outcome must pass.',
    'passed-with-issues': 'Passed samples cannot contain correctness issues.',
    'producer-fact-mismatch': 'Stored B06 producer facts do not match the selected case.',
    'repeat-link-mismatch': 'Manifest request and artifact repeat links must match.',
    'sample-id-mismatch': 'Sample ID does not match its identity fields.',
    'workload-list-mismatch': 'Manifest workload order must match its request.'
} as const;

type SemanticCode = keyof typeof semanticMessages;

type StringFormat = 'baselineId' | 'gitHash' | 'path' | 'sha256' | 'timestamp';

const attemptLocatorFields = [
    'workloadId',
    'caseId',
    'inputKey',
    'intendedPhase',
    'outerOrdinal'
] as const;

type AccountingKind = 'sample' | 'cohort';

type OutcomeProblem = 'duplicate' | 'extra' | 'identity';

export function validateRtcBaselineNumberRule(
    value: RtcBaselineJson | object | undefined,
    rule: { integer?: boolean; minimum?: number; values?: readonly number[]; },
    path: string
) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return [rtcBaselineIssue(path, 'expected-number', 'Expected a number.')];
    }
    const integerKind = rule.minimum === 1 ? 'positive' : 'nonnegative';
    if (rule.integer && (!Number.isInteger(value) || value < (rule.minimum ?? 0))) {
        return [rtcBaselineIssue(path, `expected-${integerKind}-integer`, `Expected a ${integerKind} integer.`)];
    }
    if (rule.minimum !== undefined && value < rule.minimum) {
        return [rtcBaselineIssue(path, 'expected-nonnegative-number', 'Expected a nonnegative number.')];
    }
    return rule.values && !rule.values.includes(value)
        ? [rtcBaselineIssue(path, 'unsupported-value', `Expected ${rule.values.join(' or ')}.`)]
        : [];
}

export function validateRtcBaselineStringRule(
    value: RtcBaselineJson | object | undefined,
    rule: { values?: readonly string[]; format?: StringFormat; },
    path: string
) {
    if (typeof value !== 'string') {
        return [rtcBaselineIssue(path, 'expected-string', 'Expected a string.')];
    }
    if (rule.values && !rule.values.includes(value)) {
        return [rtcBaselineIssue(path, 'unsupported-value', 'Unsupported value.')];
    }
    if (rule.format === 'sha256' && !/^[0-9a-f]{64}$/.test(value)) {
        return [rtcBaselineIssue(path, 'invalid-sha256', 'Expected a lowercase 64-character SHA-256 digest.')];
    }
    if (rule.format === 'baselineId' && !isRtcBaselineId(value)) {
        return [
            rtcBaselineIssue(path, 'invalid-baseline-id', 'Baseline ID does not match the canonical grammar.')
        ];
    }
    if (rule.format === 'gitHash' && !/^[0-9a-f]{40}$/.test(value)) {
        return [rtcBaselineIssue(path, 'invalid-git-hash', 'Expected a lowercase 40-character Git hash.')];
    }
    if (
        rule.format === 'path' &&
        (value.length === 0 ||
            value.startsWith('/') ||
            value.includes('\\') ||
            value.split('/').includes('..'))
    ) {
        return [rtcBaselineIssue(path, 'invalid-relative-path', 'Expected a confined relative path.')];
    }
    return rule.format === 'timestamp' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        ? [rtcBaselineIssue(path, 'invalid-timestamp', 'Expected an ISO 8601 UTC timestamp.')]
        : [];
}

export function validateRtcBaselineManifest(manifest: RtcBaselineCaptureManifestDto) {
    const issues = [...validateRtcBaselineId(manifest.request.baselineId)];
    if (!jsonEquals(manifest.request.repeatLink, manifest.repeatLink)) {
        issues.push(toRtcBaselineSemanticIssue('$.repeatLink', 'repeat-link-mismatch'));
    }
    if (!jsonEquals(manifest.request.workloadIds, manifest.workloadIds)) {
        issues.push(toRtcBaselineSemanticIssue('$.workloadIds', 'workload-list-mismatch'));
    }
    return issues;
}

export function validateRtcBaselineSample(sample: RtcBaselineSampleDto) {
    const issues: RtcBaselineIssueDto[] = [];
    if (sample.identity.sampleId !== computeRtcBaselineSampleId(sample.identity)) {
        issues.push(toRtcBaselineSemanticIssue('$.identity.sampleId', 'sample-id-mismatch'));
    }
    if (sample.outcome === 'passed' && sample.issues.length > 0) {
        issues.push(toRtcBaselineSemanticIssue('$.issues', 'passed-with-issues'));
    }
    issues.push(...validateRtcB06ProductionServingProof(sample));
    return issues;
}

export function validateRtcBaselineSummary(summary: Pick<RtcBaselineSummaryDto, 'baselineId'>) {
    return validateRtcBaselineId(summary.baselineId);
}

export function validateRtcBaselinePassingSummary(summary: RtcBaselineSummaryArtifactRecord) {
    const outcomes = [...summary.sampleOutcomes, ...summary.cohortOutcomes];
    const failed = outcomes.some((outcome) => outcome.outcome !== 'passed');
    return failed ? [toRtcBaselineSemanticIssue('$.summary', 'non-passing-finalized-outcome')] : [];
}

export function validateRtcBaselineFinalizationFailure(failure: FailureIdentity) {
    return validateRtcBaselineId(failure.baselineId);
}

export function validateRtcBaselineExternalCohort(cohort: RtcBaselineExternalCohortDto) {
    const seen = new Set<string>();
    const issues: RtcBaselineIssueDto[] = [];
    cohort.identity.memberSampleIds.forEach((sampleId: string, index: number) => {
        if (seen.has(sampleId)) {
            issues.push(toRtcBaselineSemanticIssue(`$.identity.memberSampleIds[${index}]`, 'duplicate-member-sample'));
        }
        seen.add(sampleId);
    });
    const sampleIds = cohort.samples.map(({ identity }) => identity.sampleId);
    if (!jsonEquals(cohort.identity.memberSampleIds, sampleIds)) {
        issues.push(toRtcBaselineSemanticIssue('$.samples', 'cohort-member-samples-mismatch'));
    }
    cohort.samples.forEach((sample, index) => {
        if (sample.identity.workloadId !== cohort.identity.workloadId) {
            issues.push(
                toRtcBaselineSemanticIssue(`$.samples[${index}].identity.workloadId`, 'cohort-workload-mismatch')
            );
        }
        if (sample.evidenceClass !== 'local-full-stack') {
            issues.push(
                toRtcBaselineSemanticIssue(`$.samples[${index}].evidenceClass`, 'cohort-evidence-class-mismatch')
            );
        }
    });
    return issues;
}

export function validateRtcBaselineRuntimeObservation(
    observation: RtcBaselineRuntimeObservationDto
) {
    const { startedAtUtc, endedAtUtc } = observation.timing;
    return Date.parse(endedAtUtc) < Date.parse(startedAtUtc)
        ? [toRtcBaselineSemanticIssue('$.timing.endedAtUtc', 'invalid-timing-order')]
        : [];
}

export function validateRtcBaselineExternalAttempt(attempt: RtcBaselineExternalAttemptDto) {
    const facts = attempt.producerFacts;
    const issues: RtcBaselineIssueDto[] = [];
    const expectsAllScenarios = attempt.locator.caseId === 'all-scenarios';
    if (
        facts.allScenariosPresent !== expectsAllScenarios ||
        facts.allScenariosRaw !== (expectsAllScenarios ? '1' : null)
    ) {
        issues.push(toRtcBaselineSemanticIssue('$.producerFacts.allScenariosRaw', 'producer-fact-mismatch'));
    }
    const expectsRetention = attempt.locator.caseId === 'retention-100';
    if (
        facts.retentionSoakPresent !== expectsRetention ||
        facts.retentionSoakRaw !== (expectsRetention ? '1' : null) ||
        facts.retentionCyclesPresent !== expectsRetention ||
        facts.retentionCyclesRaw !== (expectsRetention ? '100' : null)
    ) {
        issues.push(toRtcBaselineSemanticIssue('$.producerFacts.retentionSoakRaw', 'producer-fact-mismatch'));
    }
    const expectedEvidence = attempt.locator.workloadId === 'RTC-B05'
        ? 'native-browser'
        : attempt.locator.workloadId === 'RTC-B06'
        ? 'local-full-stack'
        : null;
    attempt.samples.forEach((sample, index) => {
        issues.push(...validateRtcB06ProductionServingProof(sample));
        const identityDiffers = attemptLocatorFields.some(
            (field) => sample.identity[field] !== attempt.locator[field]
        );
        if (identityDiffers) {
            issues.push(
                toRtcBaselineSemanticIssue(`$.samples[${index}].identity`, 'attempt-sample-identity-mismatch')
            );
        }
        if (expectedEvidence !== null && sample.evidenceClass !== expectedEvidence) {
            issues.push(
                toRtcBaselineSemanticIssue(`$.samples[${index}].evidenceClass`, 'attempt-evidence-class-mismatch')
            );
        }
    });
    const projectedOutcomes = attempt.samples.map(({ identity, outcome, issues: sampleIssues }) => ({
        identity,
        outcome,
        issues: sampleIssues
    }));
    if (!jsonEquals(attempt.sampleOutcomes, projectedOutcomes)) {
        issues.push(toRtcBaselineSemanticIssue('$.sampleOutcomes', 'attempt-outcome-projection-mismatch'));
    }
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
        ...validateOutcomeSet(input.expectedCohorts, input.cohortOutcomes, 'cohort')
    ];
}

export function validateRtcBaselineReconciliation<Observation extends object>(
    initialized: Observation,
    current: Observation
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
        'allowlistedEnvironment'
    ] as const;
    const issues: RtcBaselineIssueDto[] = [];
    for (const field of fields) {
        appendRtcBaselineIssueIf(issues, !jsonEquals(Reflect.get(initialized, field), Reflect.get(current, field)), [
            `$.${field}`,
            'reconciliation-mismatch',
            `Runtime observation field ${field} changed.`
        ]);
    }
    return issues;
}

export function validateRtcBaselineRetainedSampleObservations(
    environment: RtcBaselineRuntimeObservationDto | null,
    samples: readonly RtcBaselineSampleDto[]
) {
    return samples.flatMap((sample, index) => {
        if (sample.identity.intendedPhase !== 'retained') {
            return [];
        }
        if (sample.runtimeObservation === null) {
            return sample.metrics.length === 0
                ? []
                : [toRtcBaselineSemanticIssue(`$.samples[${index}].runtimeObservation`, 'missing-runtime-observation')];
        }
        if (environment === null) {
            return [rtcBaselineIssue('$.environment.observation', 'missing-runtime-observation', 'Required.')];
        }
        return validateRtcBaselineReconciliation(environment, sample.runtimeObservation).map(
            (problem) => ({
                ...problem,
                path: `$.samples[${index}].runtimeObservation${problem.path.slice(1)}`
            })
        );
    });
}

export function validateRtcBaselineArtifactReconciliation(input: {
    baselineId: string;
    environment: RtcBaselineEnvironmentDto;
    manifest: RtcBaselineCaptureManifestDto;
    summary: RtcBaselineSummaryArtifactRecord;
}) {
    const issues: RtcBaselineIssueDto[] = [];
    const { environment, manifest, summary } = input;
    const { request } = manifest;
    for (
        const [owner, label, actual] of [
            ['environment', 'Environment', environment.baselineId],
            ['manifest.request', 'Manifest', request.baselineId],
            ['summary', 'Summary', summary.baselineId]
        ] as const
    ) {
        appendRtcBaselineIssueIf(issues, actual !== input.baselineId, [
            `$.${owner}.baselineId`,
            'artifact-baseline-id-mismatch',
            `${label} baseline ID differs.`
        ]);
    }
    if (!jsonEquals(manifest.workloadIds, request.workloadIds)) {
        issues.push(toRtcBaselineSemanticIssue('$.manifest.workloadIds', 'artifact-workload-list-mismatch'));
    }
    const facts = [
        ['workloadIds', request.workloadIds, 'workload-list', 'workload list differs'],
        ['environmentId', request.environmentId, 'environment-id', 'environment differs'],
        ['repeatLink', manifest.repeatLink, 'repeat-link', 'repeat link differs'],
        [
            'conditionalEnvironmentDecisions',
            request.conditionalEnvironmentDecisions,
            'decisions',
            'decisions differ'
        ]
    ] as const;
    for (
        const [owner, label, artifact] of [
            ['environment', 'Environment', environment],
            ['summary', 'Summary', summary]
        ] as const
    ) {
        for (const [field, expected, code, description] of facts) {
            appendRtcBaselineIssueIf(issues, !jsonEquals(Reflect.get(artifact, field), expected), [
                `$.${owner}.${field}`,
                `artifact-${code}-mismatch`,
                `${label} ${description}.`
            ]);
        }
    }
    return issues;
}

export function validateRtcBaselineStoredArtifact(value: RtcBaselineStoredArtifact) {
    if (value.schema === 'rallar.rtc-baseline.environment.v1' && value.observation !== null) {
        return validateRtcBaselineRuntimeObservation(value.observation);
    }
    if (value.schema === 'rallar.rtc-baseline.environment.v1') {
        return [];
    }
    if (value.schema === 'rallar.rtc-baseline.manifest.v1') {
        return validateRtcBaselineManifest(value);
    }
    if (value.schema === 'rallar.rtc-baseline.sample.v1') {
        const observationIssues = value.runtimeObservation
            ? validateRtcBaselineRuntimeObservation(value.runtimeObservation)
            : [];
        return [...validateRtcBaselineSample(value), ...observationIssues];
    }
    if (value.schema === 'rallar.rtc-baseline.external-attempt.v1') {
        return validateRtcBaselineExternalAttempt(value);
    }
    if (value.schema === 'rallar.rtc-baseline.external-cohort.v1') {
        return validateRtcBaselineExternalCohort(value);
    }
    if (value.schema === 'rallar.rtc-baseline.finalization-failure.v1') {
        return validateRtcBaselineFinalizationFailure(value);
    }
    return validateRtcBaselineSummary(value);
}

function appendRtcBaselineIssueIf(issues: RtcBaselineIssueDto[], invalid: boolean, problem: IssueInput) {
    if (invalid) {
        issues.push(rtcBaselineIssue(...problem));
    }
}

function toRtcBaselineSemanticIssue(path: string, code: SemanticCode): RtcBaselineIssueDto {
    return rtcBaselineIssue(path, code, semanticMessages[code]);
}

function computeRtcBaselineSampleId(identity: RtcBaselineSampleIdentityDto) {
    const workload = String(identity.workloadId).slice(4).toLowerCase();
    const outer = String(identity.outerOrdinal).padStart(3, '0');
    const inner = String(identity.innerOrdinal).padStart(3, '0');
    const sampleCase = `${workload}-${identity.caseId}-${identity.inputKey}`;
    return `rtc-${sampleCase}-${identity.intendedPhase}-${outer}-${inner}`;
}

function resolveRtcBaselineAccountingId(identity: AccountingIdentity, kind: AccountingKind) {
    if (kind === 'sample' && 'sampleId' in identity) {
        return identity.sampleId;
    }
    if (kind === 'cohort' && 'cohortId' in identity) {
        return identity.cohortId;
    }
    return '';
}

function toRtcBaselineOutcomeIssue(kind: AccountingKind, index: number, problem: OutcomeProblem) {
    const label = kind === 'sample' ? 'Sample' : 'Cohort';
    const identityMismatch = problem === 'identity';
    return rtcBaselineIssue(
        `$.${kind}Outcomes[${index}]${identityMismatch ? '.identity' : ''}`,
        identityMismatch ? `${kind}-identity-mismatch` : `${problem}-${kind}-outcome`,
        identityMismatch
            ? `${label} identity differs.`
            : `${label} outcome is ${problem === 'duplicate' ? 'duplicated' : 'extra'}.`
    );
}

function validateOutcomeSet(
    expected: readonly AccountingIdentity[],
    outcomes: readonly RtcBaselineAccountingOutcomeRecord[],
    kind: AccountingKind
) {
    const seen = new Set<string>();
    const expectedById = new Map(
        expected.map((identity) => [resolveRtcBaselineAccountingId(identity, kind), identity])
    );
    const issues: RtcBaselineIssueDto[] = [];
    outcomes.forEach((outcome, index) => {
        const id = resolveRtcBaselineAccountingId(outcome.identity, kind);
        const expectedIdentity = expectedById.get(id);
        const problem: OutcomeProblem | null = seen.has(id)
            ? 'duplicate'
            : !expectedIdentity
            ? 'extra'
            : !jsonEquals(expectedIdentity, outcome.identity)
            ? 'identity'
            : null;
        if (problem !== null) {
            issues.push(toRtcBaselineOutcomeIssue(kind, index, problem));
        }
        seen.add(id);
    });
    if (expected.some((identity) => !seen.has(resolveRtcBaselineAccountingId(identity, kind)))) {
        issues.push(
            rtcBaselineIssue(
                `$.${kind}Outcomes`,
                `missing-${kind}-outcome`,
                `${kind === 'sample' ? 'Sample' : 'Cohort'} outcome is missing.`
            )
        );
    }
    return issues;
}
