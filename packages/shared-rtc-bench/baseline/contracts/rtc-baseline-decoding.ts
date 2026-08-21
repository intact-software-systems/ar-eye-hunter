import type {
    RtcBaselineCaptureRequestDto,
    RtcBaselineCohortIdentityDto,
    RtcBaselineConditionalEnvironmentDecisionDto,
    RtcBaselineEnvironmentId,
    RtcBaselineIssueDto,
    RtcBaselineJson,
    RtcBaselineRepeatLinkDto,
    RtcBaselineResult,
    RtcBaselineSampleIdentityDto,
    RtcBaselineWorkloadId
} from './rtc-baseline-contracts.ts';

type PlainObject = Record<string, RtcBaselineJson>;
const environments = ['E1-local', 'E2-browser', 'E3-memory', 'E4-pg', 'E5-remote'] as const;
const workloads = ['RTC-B01', 'RTC-B02', 'RTC-B03', 'RTC-B04', 'RTC-B05', 'RTC-B06'] as const;
const environmentMessage = 'Expected one of E1-local, E2-browser, E3-memory, E4-pg, E5-remote.';
const workloadMessage = 'Expected RTC-B01 through RTC-B06.';
const denseArrayMessage = 'Array entries must be dense JSON values.';

function issue(path: string, code: string, message: string) {
    return { path, code, message };
}

function isObject(value: RtcBaselineJson | object): value is PlainObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(
    value: RtcBaselineJson | object,
    path: string,
    issues: ReturnType<typeof issue>[]
): RtcBaselineJson {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (Number.isFinite(value)) {
            return value;
        }
        issues.push(issue(path, 'non-json-number', 'Numbers must be finite.'));
        return null;
    }
    if (Array.isArray(value)) {
        const result: RtcBaselineJson[] = [];
        for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) {
                issues.push(
                    issue(`${path}[${index}]`, 'sparse-array', 'Array entries must be dense JSON values.')
                );
                result.push(null);
            }
            else {
                result.push(normalize(value[index], `${path}[${index}]`, issues));
            }
        }
        return result;
    }
    if (isObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
        const result: Record<string, RtcBaselineJson> = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = normalize(entry, `${path}.${key}`, issues);
        }
        return result;
    }
    issues.push(issue(path, 'non-json-value', 'Expected a plain JSON value.'));
    return null;
}

export function normalizeRtcBaselineJson(
    value: RtcBaselineJson | object
): RtcBaselineResult<RtcBaselineJson> {
    const issues: ReturnType<typeof issue>[] = [];
    const normalized = normalize(value, '$', issues);
    return issues.length === 0 ? { ok: true, value: normalized } : { ok: false, issues };
}

function unexpectedFields(value: PlainObject, allowed: readonly string[], path = '$') {
    return Object.keys(value)
        .filter((key) => !allowed.includes(key))
        .map((key) => issue(`${path}.${key}`, 'unexpected-field', `Field ${key} is not allowed.`));
}

export function decodeRtcBaselineConditionalEnvironmentDecision(
    value: RtcBaselineJson | object,
    path = '$'
): RtcBaselineResult<RtcBaselineConditionalEnvironmentDecisionDto> {
    if (!isObject(value)) {
        return { ok: false, issues: [issue(path, 'expected-object', 'Expected a plain object.')] };
    }
    const issues = [] as ReturnType<typeof issue>[];
    const environmentId = environments.find((candidate) => candidate === value.environmentId);
    if (!environmentId) {
        issues.push(issue(`${path}.environmentId`, 'unsupported-value', environmentMessage));
    }
    const decision = value.decision === 'required' || value.decision === 'not-required' ? value.decision : null;
    if (!decision) {
        issues.push(
            issue(`${path}.decision`, 'unsupported-value', 'Expected required or not-required.')
        );
    }
    const reason = requiredString(value.reason, `${path}.reason`, issues);
    issues.push(...unexpectedFields(value, ['environmentId', 'decision', 'reason'], path));
    return issues.length === 0 && environmentId && decision
        ? { ok: true, value: { environmentId, decision, reason } }
        : { ok: false, issues };
}

export function decodeRtcBaselineRepeatLink(
    value: RtcBaselineJson | object,
    path = '$'
): RtcBaselineResult<RtcBaselineRepeatLinkDto> {
    if (!isObject(value)) {
        return { ok: false, issues: [issue(path, 'expected-object', 'Expected a plain object.')] };
    }
    const issues = [] as ReturnType<typeof issue>[];
    const primaryBaselineId = requiredString(
        value.primaryBaselineId,
        `${path}.primaryBaselineId`,
        issues
    );
    const primarySummarySha256 = requiredString(
        value.primarySummarySha256,
        `${path}.primarySummarySha256`,
        issues
    );
    issues.push(...unexpectedFields(value, ['primaryBaselineId', 'primarySummarySha256'], path));
    return issues.length === 0
        ? { ok: true, value: { primaryBaselineId, primarySummarySha256 } }
        : { ok: false, issues };
}

export function decodeRtcBaselineCaptureRequest(
    value: RtcBaselineJson | object
): RtcBaselineResult<RtcBaselineCaptureRequestDto> {
    if (!isObject(value)) {
        return { ok: false, issues: [issue('$', 'expected-object', 'Expected a plain object.')] };
    }
    const issues = [] as ReturnType<typeof issue>[];
    const decodedWorkloads: RtcBaselineWorkloadId[] = [];
    const decodedDecisions: RtcBaselineConditionalEnvironmentDecisionDto[] = [];
    let decodedRepeatLink: RtcBaselineRepeatLinkDto | null = null;
    let decodedEnvironmentId: RtcBaselineEnvironmentId | null = null;
    if (value.schema !== 'rallar.rtc-baseline.capture-request.v1') {
        issues.push(
            issue(
                '$.schema',
                typeof value.schema === 'string' ? 'unsupported-value' : 'expected-string',
                typeof value.schema === 'string'
                    ? 'Expected rallar.rtc-baseline.capture-request.v1.'
                    : 'Expected a string.'
            )
        );
    }
    if (typeof value.baselineId !== 'string') {
        issues.push(issue('$.baselineId', 'expected-string', 'Expected a string.'));
    }
    if (!Array.isArray(value.workloadIds)) {
        issues.push(issue('$.workloadIds', 'expected-array', 'Expected an array.'));
    }
    else if (value.workloadIds.length === 0) {
        issues.push(issue('$.workloadIds', 'empty-array', 'Expected a nonempty array.'));
    }
    else {
        const requestedWorkloads = value.workloadIds;
        const seen = new Set<string>();
        for (let index = 0; index < requestedWorkloads.length; index += 1) {
            if (!(index in requestedWorkloads)) {
                issues.push(issue(`$.workloadIds[${index}]`, 'sparse-array', denseArrayMessage));
                continue;
            }
            const workload = workloads.find((candidate) => candidate === requestedWorkloads[index]);
            if (!workload) {
                issues.push(issue(`$.workloadIds[${index}]`, 'unsupported-value', workloadMessage));
            }
            else {
                decodedWorkloads.push(workload);
                if (seen.has(workload)) {
                    issues.push(
                        issue(
                            `$.workloadIds[${index}]`,
                            'duplicate-workload',
                            `Workload ${workload} appears more than once.`
                        )
                    );
                }
            }
            if (workload) {
                seen.add(workload);
            }
        }
    }
    decodedEnvironmentId = environments.find((candidate) => candidate === value.environmentId) ?? null;
    if (!decodedEnvironmentId) {
        issues.push(issue('$.environmentId', 'unsupported-value', environmentMessage));
    }
    if (value.retainedSampleMultiplier !== 1 && value.retainedSampleMultiplier !== 2) {
        issues.push(issue('$.retainedSampleMultiplier', 'unsupported-value', 'Expected 1 or 2.'));
    }
    if (value.repeatLink !== null) {
        const decoded = decodeRtcBaselineRepeatLink(value.repeatLink, '$.repeatLink');
        if (!decoded.ok) {
            issues.push(...decoded.issues);
        }
        else {
            decodedRepeatLink = decoded.value;
        }
    }
    if (!Array.isArray(value.conditionalEnvironmentDecisions)) {
        issues.push(issue('$.conditionalEnvironmentDecisions', 'expected-array', 'Expected an array.'));
    }
    else {
        value.conditionalEnvironmentDecisions.forEach((entry, index) => {
            const decoded = decodeRtcBaselineConditionalEnvironmentDecision(
                entry,
                `$.conditionalEnvironmentDecisions[${index}]`
            );
            if (!decoded.ok) {
                issues.push(...decoded.issues);
            }
            else {
                decodedDecisions.push(decoded.value);
            }
        });
    }
    issues.push(
        ...unexpectedFields(value, [
            'schema',
            'baselineId',
            'workloadIds',
            'environmentId',
            'retainedSampleMultiplier',
            'repeatLink',
            'conditionalEnvironmentDecisions'
        ])
    );
    if (issues.length > 0) {
        return { ok: false, issues };
    }
    return {
        ok: true,
        value: {
            schema: 'rallar.rtc-baseline.capture-request.v1',
            baselineId: String(value.baselineId),
            workloadIds: decodedWorkloads,
            environmentId: decodedEnvironmentId!,
            retainedSampleMultiplier: value.retainedSampleMultiplier === 2 ? 2 : 1,
            repeatLink: decodedRepeatLink,
            conditionalEnvironmentDecisions: decodedDecisions
        }
    };
}

export const RTC_BASELINE_WORKLOAD_IDS: readonly RtcBaselineWorkloadId[] = workloads;

function requiredString(
    value: RtcBaselineJson | undefined,
    path: string,
    issues: RtcBaselineIssueDto[]
) {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    issues.push(issue(path, 'expected-string', 'Expected a string.'));
    return '';
}

function requiredOrdinal(
    value: RtcBaselineJson | undefined,
    path: string,
    issues: RtcBaselineIssueDto[]
) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
    }
    issues.push(issue(path, 'expected-positive-integer', 'Expected a positive integer.'));
    return 0;
}

const sampleIdentityFields = [
    'sampleId',
    'workloadId',
    'caseId',
    'inputKey',
    'intendedPhase',
    'outerOrdinal',
    'innerOrdinal'
] as const;

export function decodeRtcBaselineIssue(
    value: RtcBaselineJson,
    path: string
): RtcBaselineResult<RtcBaselineIssueDto> {
    if (!isObject(value)) {
        return { ok: false, issues: [issue(path, 'expected-object', 'Expected an issue object.')] };
    }
    const issues: RtcBaselineIssueDto[] = [];
    const issuePath = requiredString(value.path, `${path}.path`, issues);
    const code = requiredString(value.code, `${path}.code`, issues);
    const message = requiredString(value.message, `${path}.message`, issues);
    issues.push(...unexpectedFields(value, ['path', 'code', 'message', 'details'], path));
    const details = Object.hasOwn(value, 'details') ? { details: value.details } : {};
    return issues.length > 0
        ? { ok: false, issues }
        : { ok: true, value: { path: issuePath, code, message, ...details } };
}

export function decodeRtcBaselineSampleIdentity(
    value: RtcBaselineJson,
    path: string
): RtcBaselineResult<RtcBaselineSampleIdentityDto> {
    if (!isObject(value)) {
        return { ok: false, issues: [issue(path, 'expected-object', 'Expected an identity object.')] };
    }
    const issues: RtcBaselineIssueDto[] = [];
    const sampleId = requiredString(value.sampleId, `${path}.sampleId`, issues);
    const decodedWorkload = workloads.find((candidate) => candidate === value.workloadId);
    if (decodedWorkload === undefined) {
        issues.push(issue(`${path}.workloadId`, 'unsupported-value', workloadMessage));
    }
    const caseId = requiredString(value.caseId, `${path}.caseId`, issues);
    const inputKey = requiredString(value.inputKey, `${path}.inputKey`, issues);
    const decodedPhase = value.intendedPhase === 'warmup' || value.intendedPhase === 'retained'
        ? value.intendedPhase
        : null;
    if (decodedPhase === null) {
        issues.push(
            issue(`${path}.intendedPhase`, 'unsupported-value', 'Expected warmup or retained.')
        );
    }
    const outerOrdinal = requiredOrdinal(value.outerOrdinal, `${path}.outerOrdinal`, issues);
    const innerOrdinal = requiredOrdinal(value.innerOrdinal, `${path}.innerOrdinal`, issues);
    issues.push(...unexpectedFields(value, sampleIdentityFields, path));
    if (issues.length > 0) {
        return { ok: false, issues };
    }
    const workloadId = decodedWorkload ?? 'RTC-B01';
    const intendedPhase = decodedPhase ?? 'retained';
    return {
        ok: true,
        value: { sampleId, workloadId, caseId, inputKey, intendedPhase, outerOrdinal, innerOrdinal }
    };
}

export function decodeRtcBaselineCohortIdentity(
    value: RtcBaselineJson,
    path: string
): RtcBaselineResult<RtcBaselineCohortIdentityDto> {
    if (!isObject(value)) {
        return { ok: false, issues: [issue(path, 'expected-object', 'Expected an identity object.')] };
    }
    const issues: RtcBaselineIssueDto[] = [];
    const cohortId = requiredString(value.cohortId, `${path}.cohortId`, issues);
    const decodedWorkload = workloads.find((candidate) => candidate === value.workloadId);
    if (decodedWorkload === undefined) {
        issues.push(issue(`${path}.workloadId`, 'unsupported-value', workloadMessage));
    }
    const memberSampleIds: string[] = [];
    if (!Array.isArray(value.memberSampleIds)) {
        issues.push(issue(`${path}.memberSampleIds`, 'expected-array', 'Expected an array.'));
    }
    else {
        value.memberSampleIds.forEach((entry, index) => {
            const sampleId = requiredString(entry, `${path}.memberSampleIds[${index}]`, issues);
            if (sampleId.length > 0) {
                if (memberSampleIds.includes(sampleId)) {
                    issues.push(
                        issue(
                            `${path}.memberSampleIds[${index}]`,
                            'duplicate-sample-id',
                            'Cohort member sample IDs must be unique.'
                        )
                    );
                }
                memberSampleIds.push(sampleId);
            }
        });
    }
    issues.push(...unexpectedFields(value, ['cohortId', 'workloadId', 'memberSampleIds'], path));
    if (issues.length > 0) {
        return { ok: false, issues };
    }
    return {
        ok: true,
        value: { cohortId, workloadId: decodedWorkload ?? 'RTC-B01', memberSampleIds }
    };
}

export function decodeRtcBaselineFailureIdentity(value: RtcBaselineJson | undefined) {
    if (value === undefined || !isObject(value)) {
        return {
            ok: false as const,
            issues: [issue('$.identity', 'expected-object', 'Expected an identity object.')]
        };
    }
    if ('sampleId' in value) {
        return decodeRtcBaselineSampleIdentity(value, '$.identity');
    }
    if ('cohortId' in value) {
        return decodeRtcBaselineCohortIdentity(value, '$.identity');
    }
    return {
        ok: false as const,
        issues: [issue('$.identity', 'expected-object', 'Expected an identity object.')]
    };
}

export function decodeRtcBaselineIssueArray(value: RtcBaselineJson | undefined) {
    if (!Array.isArray(value)) {
        return {
            ok: false as const,
            issues: [issue('$.issues', 'expected-array', 'Expected an issue array.')]
        };
    }
    const decoded: RtcBaselineIssueDto[] = [];
    const issues: RtcBaselineIssueDto[] = [];
    value.forEach((entry, index) => {
        const result = decodeRtcBaselineIssue(entry, `$.issues[${index}]`);
        if (result.ok) {
            decoded.push(result.value);
        }
        else {
            issues.push(...result.issues);
        }
    });
    if (value.length === 0) {
        issues.push(issue('$.issues', 'empty-array', 'Expected at least one issue.'));
    }
    return issues.length > 0 ? { ok: false as const, issues } : { ok: true as const, value: decoded };
}

export function requireRtcBaselineDecodedType<T extends object>(
    result: RtcBaselineResult<T>,
    isExpected: (value: RtcBaselineJson | T) => value is T
): RtcBaselineResult<T> {
    if (!result.ok) {
        return result;
    }
    return isExpected(result.value)
        ? { ok: true, value: result.value }
        : {
            ok: false,
            issues: [
                {
                    path: '$.schema',
                    code: 'unexpected-artifact',
                    message: 'Decoded artifact did not match its named DTO.'
                }
            ]
        };
}
