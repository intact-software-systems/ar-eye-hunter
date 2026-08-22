import {
    computeRtcDataChannelBrowserSoakAttempt,
    RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT
} from '../../workloads/browser-lifecycle/rtc-data-channel-browser-soak-validation.ts';
import type {
    RtcBaselineAcceptedArtifact,
    RtcBaselineAttemptInputLocatorDto,
    RtcBaselineCaptureManifestDto,
    RtcBaselineExternalAttemptDto,
    RtcBaselineExternalCohortDto,
    RtcBaselineFailureArtifact,
    RtcBaselineFailureOutcomeArtifact,
    RtcBaselineFailureOwner,
    RtcBaselineFailureSequenceInput,
    RtcBaselineIssueDto,
    RtcBaselineJson,
    RtcBaselineNotRunArtifact,
    RtcBaselineOuterAttemptDto,
    RtcBaselineResult,
    RtcBaselineSampleDto,
    RtcBaselineSampleFailureOutcomeArtifact,
    RtcBaselineSampleFailureOwner,
    RtcBaselineSampleIdentityDto,
    RtcBaselineWorkloadId
} from '../contracts/rtc-baseline-contracts.ts';
import {
    RTC_BASELINE_ACCEPTED_ARTIFACT_DIRECTORIES,
    RTC_BASELINE_CAUSAL_NOT_RUN_ISSUE,
    RTC_BASELINE_FAILURE_ARTIFACT_FIELDS,
    rtcBaselineIssue,
    validateRtcBaselineDecoded
} from '../contracts/rtc-baseline-contracts.ts';
export { RTC_BASELINE_ACCEPTED_ARTIFACT_DIRECTORIES } from '../contracts/rtc-baseline-contracts.ts';
export type {
    RtcBaselineAcceptedArtifact,
    RtcBaselineFailureArtifact,
    RtcBaselineFailureOutcomeArtifact,
    RtcBaselineFailureOutcomeDecodingResult,
    RtcBaselineFailureOwner,
    RtcBaselineNotRunArtifact,
    RtcBaselineSampleFailureOutcomeArtifact,
    RtcBaselineSampleFailureOwner
} from '../contracts/rtc-baseline-contracts.ts';
import {
    decodeRtcBaselineExternalAttempt,
    decodeRtcBaselineExternalCohort
} from '../contracts/rtc-baseline-artifact-decoding.ts';
import {
    validateRtcBaselineExternalAttempt,
    validateRtcBaselineExternalCohort
} from '../contracts/rtc-baseline-artifact-validation.ts';
import {
    decodeRtcBaselineFailureIdentity,
    decodeRtcBaselineIssueArray,
    normalizeRtcBaselineJson
} from '../contracts/rtc-baseline-decoding.ts';
import {
    rtcBaselineFailureArtifactPath,
    rtcBaselineSampleArtifactPath
} from '../evidence/rtc-baseline-evidence-layout.ts';

export interface RtcBaselineAcceptedWorkerIdentityInput {
    readonly workloadId: RtcBaselineWorkloadId;
    readonly caseId: string;
    readonly inputKey: string;
    readonly intendedPhase: RtcBaselineSampleIdentityDto['intendedPhase'];
    readonly outerOrdinal: number;
    readonly sampleIds: readonly string[];
}

interface CreateRtcBaselineAcceptedWorkerSampleInput<Result> {
    readonly identity: RtcBaselineSampleIdentityDto;
    readonly result: Result | null;
    readonly issues: readonly RtcBaselineIssueDto[];
}

export function createRtcBaselineAcceptedWorkerSampleIdentity(
    worker: RtcBaselineAcceptedWorkerIdentityInput,
    index: number
): RtcBaselineSampleIdentityDto {
    return {
        sampleId: worker.sampleIds[index]!,
        workloadId: worker.workloadId,
        caseId: worker.caseId,
        inputKey: worker.inputKey,
        intendedPhase: worker.intendedPhase,
        outerOrdinal: worker.outerOrdinal,
        innerOrdinal: index + 1
    };
}

export async function runRtcBaselineAcceptedWorkerSamples<Result>(input: {
    readonly worker: RtcBaselineAcceptedWorkerIdentityInput;
    readonly run: () => Promise<Result> | Result;
    readonly validate: (result: Result) => readonly RtcBaselineIssueDto[];
    readonly createSample: (
        input: CreateRtcBaselineAcceptedWorkerSampleInput<Result>
    ) => RtcBaselineSampleDto;
}): Promise<RtcBaselineSampleDto[]> {
    const samples: RtcBaselineSampleDto[] = [];
    let failureId: string | undefined;
    for (let index = 0; index < input.worker.sampleIds.length; index += 1) {
        const identity = createRtcBaselineAcceptedWorkerSampleIdentity(input.worker, index);
        if (failureId !== undefined) {
            samples.push(
                input.createSample({
                    identity,
                    result: null,
                    issues: [rtcBaselineIssue('$.rawEvidence', 'causal-not-run', failureId)]
                })
            );
            continue;
        }
        const result = await input.run();
        const issues = input.validate(result);
        if (issues.length > 0) {
            failureId = identity.sampleId;
        }
        samples.push(input.createSample({ identity, result, issues }));
    }
    return samples;
}

export function deriveRtcBaselineSampleIdentities(
    outerAttempts: readonly RtcBaselineOuterAttemptDto[]
) {
    return outerAttempts.flatMap((outer) =>
        outer.sampleIds.map((sampleId, index) => ({
            sampleId,
            workloadId: outer.workloadId,
            caseId: outer.caseId,
            inputKey: outer.inputKey,
            intendedPhase: outer.intendedPhase,
            outerOrdinal: outer.outerOrdinal,
            innerOrdinal: index + 1
        }))
    );
}

export function rtcBaselineSampleIdentityEquals(
    left: RtcBaselineJson | RtcBaselineSampleIdentityDto,
    right: RtcBaselineSampleIdentityDto
) {
    if (typeof left !== 'object' || left === null || Array.isArray(left)) {
        return false;
    }
    return Object.entries(right).every(([field, value]) => Reflect.get(left, field) === value);
}

export function findRtcBaselineAttemptFailureOwner(
    manifest: RtcBaselineCaptureManifestDto,
    locator: RtcBaselineAttemptInputLocatorDto
): RtcBaselineSampleFailureOwner | null {
    const attempt = manifest.outerAttempts.find((entry) =>
        Object.entries(locator).every(([field, value]) => Reflect.get(entry, field) === value)
    );
    return attempt
        ? { kind: 'sample', identity: deriveRtcBaselineSampleIdentities([attempt])[0]! }
        : null;
}

export function validateRtcBaselineAcceptedAttempt(input: {
    attempt: RtcBaselineExternalAttemptDto;
    expectedOuter: RtcBaselineOuterAttemptDto;
    rawResultRelativePath: string;
    producerExitStatus: number;
}) {
    const expectedLocator = {
        workloadId: input.expectedOuter.workloadId,
        caseId: input.expectedOuter.caseId,
        inputKey: input.expectedOuter.inputKey,
        environmentId: input.expectedOuter.environmentId,
        intendedPhase: input.expectedOuter.intendedPhase,
        outerOrdinal: input.expectedOuter.outerOrdinal,
        rawResultRelativePath: input.rawResultRelativePath
    };
    const locatorIssues = Object.entries(expectedLocator).flatMap(([field, expected]) =>
        issueWhen(
            Reflect.get(input.attempt.locator, field) !== expected,
            { path: `$.locator.${field}`, code: 'attempt-locator-mismatch' },
            `Staged attempt field ${field} does not match its manifest locator.`
        )
    );
    const expectedIdentities = deriveRtcBaselineSampleIdentities([input.expectedOuter]);
    const identityIssues = expectedIdentities.flatMap((identity, index) =>
        issueWhen(
            !rtcBaselineSampleIdentityEquals(
                input.attempt.sampleOutcomes[index]?.identity ?? null,
                identity
            ),
            { path: `$.sampleOutcomes[${index}].identity`, code: 'attempt-identity-mismatch' },
            'Staged sample identity does not match the manifest inner sample.'
        )
    );
    return [
        ...locatorIssues,
        ...issueWhen(
            input.attempt.producerExitStatus !== input.producerExitStatus,
            { path: '$.producerExitStatus', code: 'producer-status-mismatch' },
            'Staged producer status does not match the controller input.'
        ),
        ...issueWhen(
            input.attempt.sampleOutcomes.length !== input.expectedOuter.sampleIds.length,
            { path: '$.sampleOutcomes', code: 'attempt-outcome-cardinality' },
            'Staged sample outcomes must exactly cover the manifest outer attempt.'
        ),
        ...identityIssues
    ];
}

export function validateRtcBaselineAcceptedCohort(
    cohort: RtcBaselineExternalCohortDto,
    expected: RtcBaselineExternalCohortDto['identity']
) {
    return issueWhen(
        JSON.stringify(cohort.identity) !== JSON.stringify(expected),
        { path: '$.identity', code: 'cohort-identity-mismatch' },
        'Staged cohort identity must exactly match manifest membership and order.'
    );
}

export function decodeRtcBaselineAcceptedAttempt(
    value: RtcBaselineJson,
    input: Omit<Parameters<typeof validateRtcBaselineAcceptedAttempt>[0], 'attempt'> & {
        readonly baselineId: string;
    }
) {
    const decoded = validateRtcBaselineDecoded(decodeRtcBaselineExternalAttempt(value), (attempt) => [
        ...validateRtcBaselineExternalAttempt(attempt),
        ...validateRtcBaselineAcceptedAttempt({ ...input, attempt })
    ]);
    if (
        !decoded.ok ||
        input.expectedOuter.workloadId !== RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT.workloadId
    ) {
        return decoded;
    }
    return {
        ok: true as const,
        value: computeRtcDataChannelBrowserSoakAttempt(decoded.value, input.baselineId)
    };
}

export function decodeRtcBaselineAcceptedCohort(
    value: RtcBaselineJson,
    expected: RtcBaselineExternalCohortDto['identity']
) {
    return validateRtcBaselineDecoded(decodeRtcBaselineExternalCohort(value), (cohort) => [
        ...validateRtcBaselineExternalCohort(cohort),
        ...validateRtcBaselineAcceptedCohort(cohort, expected)
    ]);
}

function causalFailureIssue(message: string) {
    return rtcBaselineIssue('$.causalFailureId', 'invalid-causal-failure-id', message);
}
function issueWhen(
    invalid: boolean,
    owner: Pick<RtcBaselineIssueDto, 'path' | 'code'>,
    message: string
) {
    return invalid ? [rtcBaselineIssue(owner.path, owner.code, message)] : [];
}

export function decodeRtcBaselineFailureOutcome(
    input: RtcBaselineJson | object,
    relativePath: string
): RtcBaselineResult<RtcBaselineFailureOutcomeArtifact> {
    const normalized = normalizeRtcBaselineJson(input);
    if (!normalized.ok) {
        return normalized;
    }
    const value = normalized.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {
            ok: false,
            issues: [rtcBaselineIssue('$', 'expected-object', 'Expected a failure outcome object.')]
        };
    }
    const issues: RtcBaselineIssueDto[] = Object.keys(value)
        .filter((field) => !RTC_BASELINE_FAILURE_ARTIFACT_FIELDS.includes(field))
        .map((field) => rtcBaselineIssue(`$.${field}`, 'unexpected-field', `Field ${field} is not allowed.`));
    const artifactKind = value.artifactKind === 'failure' || value.artifactKind === 'not-run'
        ? value.artifactKind
        : null;
    if (artifactKind === null) {
        issues.unshift(
            rtcBaselineIssue('$.artifactKind', 'unsupported-value', 'Expected failure or not-run.')
        );
    }
    const failureId = typeof value.failureId === 'string' && value.failureId.length > 0 ? value.failureId : null;
    if (failureId === null) {
        issues.push(rtcBaselineIssue('$.failureId', 'expected-string', 'Expected a string.'));
    }
    const identity = decodeRtcBaselineFailureIdentity(value.identity);
    if (!identity.ok) {
        issues.push(...identity.issues);
    }
    const expectedOutcome = artifactKind === 'not-run' ? 'not-run' : 'failed';
    if (value.outcome !== expectedOutcome) {
        issues.push(
            rtcBaselineIssue(
                '$.outcome',
                'unsupported-value',
                `Expected ${expectedOutcome} for a ${artifactKind ?? 'failure'} artifact.`
            )
        );
    }
    const causalFailureId = typeof value.causalFailureId === 'string' ? value.causalFailureId : null;
    if (artifactKind === 'not-run') {
        if (causalFailureId === null || causalFailureId.length === 0 || causalFailureId !== failureId) {
            issues.push(
                causalFailureIssue('Not-run artifacts require their causal failure ID as failureId.')
            );
        }
    }
    else {
        if (value.causalFailureId !== null) {
            issues.push(causalFailureIssue('Failure artifacts require a null causal failure ID.'));
        }
    }
    const decodedIssues = decodeRtcBaselineIssueArray(value.issues);
    if (!decodedIssues.ok) {
        issues.push(...decodedIssues.issues);
    }
    const hasRawEvidence = Object.hasOwn(value, 'rawEvidence');
    if (!hasRawEvidence) {
        issues.push(rtcBaselineIssue('$.rawEvidence', 'expected-json-value', 'Expected a JSON value.'));
    }
    if (artifactKind === 'not-run' && value.rawEvidence !== null) {
        issues.push(
            rtcBaselineIssue(
                '$.rawEvidence',
                'invalid-not-run-evidence',
                'Not-run evidence must be null.'
            )
        );
    }
    if (identity.ok && failureId !== null) {
        const identityId = 'sampleId' in identity.value ? identity.value.sampleId : identity.value.cohortId;
        if (artifactKind === 'failure') {
            const owner = 'sampleId' in identity.value
                ? { kind: 'sample' as const, identity: identity.value }
                : { kind: 'cohort' as const, identity: identity.value };
            if (failureId !== computeRtcBaselineFailureId(owner)) {
                issues.push(
                    rtcBaselineIssue(
                        '$.failureId',
                        'failure-id-mismatch',
                        'Failure ID does not match its identity.'
                    )
                );
            }
        }
        else if (artifactKind === 'not-run' && !('sampleId' in identity.value)) {
            issues.push(
                rtcBaselineIssue(
                    '$.identity',
                    'not-run-cohort',
                    'Not-run artifacts require a sample identity.'
                )
            );
        }
        const expectedPath = `results/${rtcBaselineFailureArtifactPath(failureId, identityId)}`;
        if (relativePath !== expectedPath) {
            issues.push(
                rtcBaselineIssue(
                    '$.path',
                    'failure-path-mismatch',
                    'Failure artifact path does not match its identity.'
                )
            );
        }
    }
    if (
        issues.length > 0 ||
        !identity.ok ||
        !decodedIssues.ok ||
        artifactKind === null ||
        failureId === null
    ) {
        return { ok: false, issues };
    }
    if (artifactKind === 'not-run') {
        if (!('sampleId' in identity.value) || causalFailureId === null) {
            return { ok: false, issues };
        }
        return {
            ok: true,
            value: createRtcBaselineNotRunArtifact(identity.value, causalFailureId, decodedIssues.value)
        };
    }
    return {
        ok: true,
        value: createRtcBaselineFailureArtifact(
            'sampleId' in identity.value
                ? { kind: 'sample', identity: identity.value }
                : { kind: 'cohort', identity: identity.value },
            decodedIssues.value,
            hasRawEvidence && value.rawEvidence !== undefined ? value.rawEvidence : null
        )
    };
}

export function isRtcBaselineSampleFailureOutcomeArtifact(
    value: RtcBaselineFailureOutcomeArtifact
): value is RtcBaselineSampleFailureOutcomeArtifact {
    return 'sampleId' in value.identity;
}

export function resolveRtcBaselineAcceptedArtifactPath(
    artifact: RtcBaselineAcceptedArtifact
): RtcBaselineResult<string> {
    let relativePath: string;
    if ('artifactKind' in artifact) {
        const identity = 'sampleId' in artifact.identity ? artifact.identity.sampleId : artifact.identity.cohortId;
        relativePath = rtcBaselineFailureArtifactPath(artifact.failureId, identity);
    }
    else if (artifact.schema === 'rallar.rtc-baseline.sample.v1') {
        relativePath = rtcBaselineSampleArtifactPath(artifact.identity.sampleId);
    }
    else if (artifact.schema === 'rallar.rtc-baseline.external-attempt.v1') {
        const locator = artifact.locator;
        const stem = [
            locator.workloadId,
            locator.caseId,
            locator.inputKey,
            locator.intendedPhase,
            String(locator.outerOrdinal).padStart(3, '0')
        ].join('-');
        relativePath = `external-attempts/${stem}.json`;
    }
    else if (artifact.schema === 'rallar.rtc-baseline.external-cohort.v1') {
        relativePath = `external-cohorts/${artifact.identity.cohortId}.json`;
    }
    else {
        relativePath = `finalization-failures/${artifact.failureId}.json`;
    }
    return { ok: true, value: `results/${relativePath}` };
}

export function computeRtcBaselineFailureId(owner: RtcBaselineFailureOwner): string {
    return owner.kind === 'sample'
        ? `failure-sample-${owner.identity.sampleId}`
        : `failure-cohort-${owner.identity.cohortId}`;
}

export function createRtcBaselineFailureArtifact(
    owner: RtcBaselineFailureOwner,
    issues: readonly RtcBaselineIssueDto[],
    rawEvidence: RtcBaselineJson
): RtcBaselineFailureArtifact {
    return {
        artifactKind: 'failure' as const,
        failureId: computeRtcBaselineFailureId(owner),
        identity: owner.identity,
        outcome: 'failed' as const,
        causalFailureId: null,
        issues,
        rawEvidence
    };
}

export function createRtcBaselineNotRunArtifact(
    identity: RtcBaselineSampleIdentityDto,
    causalFailureId: string,
    issues: readonly RtcBaselineIssueDto[] = [RTC_BASELINE_CAUSAL_NOT_RUN_ISSUE]
): RtcBaselineNotRunArtifact {
    return {
        artifactKind: 'not-run' as const,
        failureId: causalFailureId,
        identity,
        outcome: 'not-run' as const,
        causalFailureId,
        issues,
        rawEvidence: null
    };
}

export function buildRtcBaselineFailureSequence(
    input: RtcBaselineFailureSequenceInput
): (RtcBaselineFailureArtifact | RtcBaselineNotRunArtifact)[] {
    const failureId = computeRtcBaselineFailureId(input.owner);
    const failure = createRtcBaselineFailureArtifact(input.owner, input.issues, input.rawEvidence);
    if (input.owner.kind !== 'sample' || !input.manifest) {
        return [failure];
    }
    const ownerIdentity = input.owner.identity;
    const identities = deriveRtcBaselineSampleIdentities(input.manifest.outerAttempts).filter(
        (identity) => identity.workloadId === ownerIdentity.workloadId
    );
    const ownerIndex = identities.findIndex((identity) => rtcBaselineSampleIdentityEquals(identity, ownerIdentity));
    return [
        failure,
        ...identities
            .slice(ownerIndex + 1)
            .map((identity) => createRtcBaselineNotRunArtifact(identity, failureId))
    ];
}
