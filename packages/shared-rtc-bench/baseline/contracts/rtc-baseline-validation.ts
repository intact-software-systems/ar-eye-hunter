import type {
    RtcBaselineCaptureRequestDto,
    RtcBaselineConditionalEnvironmentDecisionDto,
    RtcBaselineConfigurationFieldDescriptorDto,
    RtcBaselineJson,
    RtcBaselineOuterAttemptDto,
    RtcBaselineRepeatLinkDto,
    RtcBaselineResolvedConfigurationValueDto,
    RtcBaselineResult,
    RtcBaselineWorkerCommandDto
} from './rtc-baseline-contracts.ts';
import { decodeRtcBaselineCaptureRequest } from './rtc-baseline-decoding.ts';
import { isRtcBaselineId } from './rtc-baseline-id.ts';

function issue(path: string, code: string, message: string) {
    return { path, code, message };
}

const shaPattern = /^[0-9a-f]{64}$/;
const workloads = new Set(['RTC-B01', 'RTC-B02', 'RTC-B03', 'RTC-B04', 'RTC-B05', 'RTC-B06']);

export function validateRtcBaselineId(baselineId: string) {
    return isRtcBaselineId(baselineId)
        ? []
        : [
            issue(
                '$.baselineId',
                'invalid-baseline-id',
                'Baseline ID does not match the canonical grammar.'
            )
        ];
}

export function isRtcBaselineConfinedArtifactPath(baselineId: string, relativePath: string) {
    const components = relativePath.split('/');
    return (
        isRtcBaselineId(baselineId) &&
        relativePath.length > 0 &&
        !relativePath.startsWith('/') &&
        !relativePath.includes('\\') &&
        components.every((component) => component !== '' && component !== '.' && component !== '..')
    );
}

export function validateRtcBaselineConditionalEnvironmentDecision(
    decision: RtcBaselineConditionalEnvironmentDecisionDto
) {
    return decision.reason.trim().length === 0
        ? [
            issue(
                '$.reason',
                'empty-decision-reason',
                'Conditional environment decisions require a nonempty reason.'
            )
        ]
        : [];
}

export function validateRtcBaselineRepeatLink(
    repeatBaselineId: string,
    link: RtcBaselineRepeatLinkDto
) {
    const issues = [] as ReturnType<typeof issue>[];
    if (link.primaryBaselineId !== repeatBaselineId.replace(/-repeat-01$/, '')) {
        issues.push(
            issue(
                '$.repeatLink.primaryBaselineId',
                'repeat-primary-mismatch',
                'Repeat baseline must link to its exact suffix-free primary baseline.'
            )
        );
    }
    if (!shaPattern.test(link.primarySummarySha256)) {
        issues.push(
            issue(
                '$.repeatLink.primarySummarySha256',
                'invalid-sha256',
                'Expected a lowercase 64-character SHA-256 digest.'
            )
        );
    }
    return issues;
}

type CaptureRequestValidationInput = Omit<RtcBaselineCaptureRequestDto, 'workloadIds'> & {
    workloadIds: readonly string[];
};

export function validateRtcBaselineCaptureRequest(request: CaptureRequestValidationInput) {
    const issues = [...validateRtcBaselineId(request.baselineId)];
    const seen = new Set<string>();
    request.workloadIds.forEach((workloadId, index) => {
        if (seen.has(workloadId)) {
            issues.push(
                issue(
                    `$.workloadIds[${index}]`,
                    'duplicate-workload',
                    `Workload ${workloadId} appears more than once.`
                )
            );
        }
        if (!workloads.has(workloadId)) {
            issues.push(
                issue(
                    `$.workloadIds[${index}]`,
                    'unsupported-workload',
                    `Workload ${workloadId} is not in the frozen catalog.`
                )
            );
        }
        seen.add(workloadId);
    });
    if (request.baselineId.endsWith('-repeat-01')) {
        if (request.retainedSampleMultiplier !== 2) {
            issues.push(
                issue(
                    '$.retainedSampleMultiplier',
                    'invalid-repeat-multiplier',
                    'A repeat baseline requires retained sample multiplier 2.'
                )
            );
        }
        if (request.repeatLink === null) {
            issues.push(
                issue(
                    '$.repeatLink',
                    'missing-repeat-link',
                    'A repeat baseline requires an exact primary summary link.'
                )
            );
        }
        else {
            issues.push(...validateRtcBaselineRepeatLink(request.baselineId, request.repeatLink));
        }
    }
    else {
        if (request.retainedSampleMultiplier !== 1) {
            issues.push(
                issue(
                    '$.retainedSampleMultiplier',
                    'unexpected-repeat-multiplier',
                    'A primary baseline requires retained sample multiplier 1.'
                )
            );
        }
        if (request.repeatLink !== null) {
            issues.push(
                issue(
                    '$.repeatLink',
                    'unexpected-repeat-link',
                    'A primary baseline cannot carry a repeat link.'
                )
            );
        }
    }
    return issues;
}

function parseEnvironmentValue(
    descriptor: RtcBaselineConfigurationFieldDescriptorDto,
    value: string
): RtcBaselineResult<boolean | number | string> {
    if (descriptor.scalarKind === 'string') {
        return { ok: true, value };
    }
    if (descriptor.scalarKind === 'nonnegative-integer') {
        if (/^\d+$/.test(value)) {
            return { ok: true, value: Number(value) };
        }
        return {
            ok: false,
            issues: [
                issue(
                    '',
                    'invalid-environment-value',
                    'Integer environment values must be nonnegative integers.'
                )
            ]
        };
    }
    const normalized = value.toLowerCase();
    if (normalized === '1' || normalized === 'true') {
        return { ok: true, value: true };
    }
    if (normalized === '0' || normalized === 'false') {
        return { ok: true, value: false };
    }
    return {
        ok: false,
        issues: [
            issue(
                '',
                'invalid-environment-value',
                'Boolean environment values must be 0, 1, false, or true.'
            )
        ]
    };
}

export function resolveRtcBaselineConfiguration(
    descriptor: RtcBaselineConfigurationFieldDescriptorDto,
    input: { cliValue: boolean | number | string | undefined; environmentValue: string | undefined; }
): RtcBaselineResult<RtcBaselineResolvedConfigurationValueDto> {
    if (input.cliValue !== undefined) {
        return {
            ok: true,
            value: {
                caseKey: descriptor.caseKey,
                field: descriptor.field,
                value: input.cliValue,
                source: 'cli'
            }
        };
    }
    const environmentName = descriptor.allowlistedEnvironmentVariable;
    if (input.environmentValue !== undefined) {
        const parsed = parseEnvironmentValue(descriptor, input.environmentValue);
        if (!parsed.ok) {
            parsed.issues[0]!.path = `$.environment.${environmentName}`;
            return parsed;
        }
        return {
            ok: true,
            value: {
                caseKey: descriptor.caseKey,
                field: descriptor.field,
                value: parsed.value,
                source: 'environment'
            }
        };
    }
    if (descriptor.environmentUnsetBehavior === 'reject') {
        return {
            ok: false,
            issues: [
                issue(
                    `$.environment.${environmentName}`,
                    'missing-required-environment',
                    'Required allowlisted environment value is unset.'
                )
            ]
        };
    }
    return {
        ok: true,
        value: {
            caseKey: descriptor.caseKey,
            field: descriptor.field,
            value: descriptor.defaultValue,
            source: 'default'
        }
    };
}

export function deriveRtcBaselineWorkerProjection(
    argumentsList: readonly string[],
    workerStartIndex: number
) {
    const worker = argumentsList.slice(workerStartIndex);
    const issues = [] as ReturnType<typeof issue>[];
    worker.forEach((argument, index) => {
        if (argument.startsWith('--') && !argument.includes('=')) {
            issues.push(
                issue(
                    `$.redactedArgv.arguments[${workerStartIndex + index}]`,
                    'two-token-option',
                    'Worker options must use one --name=value token.'
                )
            );
        }
    });
    if (issues.length > 0) {
        return { ok: false as const, issues };
    }
    const fixedNames = [
        'capture',
        'baseline-id',
        'workload',
        'case-id',
        'input-key',
        'intended-phase',
        'outer-ordinal',
        'sample-ids'
    ];
    const fixedWorkerFlags = worker.filter((argument) => fixedNames.some((name) => argument.startsWith(`--${name}=`)));
    const configurationFlags = worker.filter((argument) => argument.startsWith('--rtc-')).sort();
    return { ok: true as const, value: { fixedWorkerFlags, configurationFlags } };
}

interface WorkerCaseEntry {
    runtime: { executable: string; prefixArguments: readonly string[]; };
    configuration: readonly RtcBaselineConfigurationFieldDescriptorDto[];
}

export function createRtcBaselineWorkerCommand(input: {
    baselineId: string;
    caseEntry: WorkerCaseEntry;
    outerAttempt: RtcBaselineOuterAttemptDto;
    resolvedConfiguration: readonly RtcBaselineResolvedConfigurationValueDto[];
}): RtcBaselineResult<RtcBaselineWorkerCommandDto> {
    const configurationFlags: string[] = [];
    const issues = [] as ReturnType<typeof issue>[];
    for (const descriptor of input.caseEntry.configuration) {
        const resolved = input.resolvedConfiguration.find(
            (entry) =>
                entry.field === descriptor.field &&
                entry.caseKey.workloadId === descriptor.caseKey.workloadId &&
                entry.caseKey.caseId === descriptor.caseKey.caseId &&
                entry.caseKey.inputKey === descriptor.caseKey.inputKey
        );
        if (!resolved) {
            issues.push(
                issue(
                    `$.resolvedConfiguration.${descriptor.field}`,
                    'missing-resolved-configuration',
                    `Configuration field ${descriptor.field} was not resolved.`
                )
            );
            continue;
        }
        configurationFlags.push(`${descriptor.flag}=${String(resolved.value)}`);
    }
    if (issues.length > 0) {
        return { ok: false, issues };
    }
    configurationFlags.sort();
    const outer = input.outerAttempt;
    const fixedWorkerFlags = [
        '--capture=worker',
        `--baseline-id=${input.baselineId}`,
        `--workload=${outer.workloadId}`,
        `--case-id=${outer.caseId}`,
        `--input-key=${outer.inputKey}`,
        `--intended-phase=${outer.intendedPhase}`,
        `--outer-ordinal=${outer.outerOrdinal}`,
        `--sample-ids=${outer.sampleIds.join(',')}`
    ];
    return {
        ok: true,
        value: {
            redactedArgv: {
                executable: input.caseEntry.runtime.executable,
                arguments: [
                    ...input.caseEntry.runtime.prefixArguments,
                    ...fixedWorkerFlags,
                    ...configurationFlags
                ]
            },
            projection: { fixedWorkerFlags, configurationFlags }
        }
    };
}

export function validateRtcBaselineRepeatRequest(
    primary: RtcBaselineCaptureRequestDto,
    repeat: RtcBaselineCaptureRequestDto
) {
    const issues = [] as ReturnType<typeof issue>[];
    let last = -1;
    for (const workload of repeat.workloadIds) {
        const index = primary.workloadIds.indexOf(workload);
        if (index < 0 || index <= last) {
            issues.push(
                issue(
                    '$.workloadIds',
                    'repeat-workload-order',
                    'Repeat workloads must preserve primary subset order.'
                )
            );
            break;
        }
        last = index;
    }
    if (
        JSON.stringify(primary.conditionalEnvironmentDecisions) !==
            JSON.stringify(repeat.conditionalEnvironmentDecisions)
    ) {
        issues.push(
            issue(
                '$.conditionalEnvironmentDecisions',
                'repeat-decision-mismatch',
                'Repeat decisions must exactly inherit the primary decisions.'
            )
        );
    }
    return issues;
}

export function prepareRtcBaselineRepeatRequest(input: {
    primary: RtcBaselineCaptureRequestDto;
    request: RtcBaselineJson | object;
    repeatLink: RtcBaselineRepeatLinkDto;
    inheritedDecisions: readonly RtcBaselineConditionalEnvironmentDecisionDto[];
}) {
    if (typeof input.request !== 'object' || input.request === null || Array.isArray(input.request)) {
        return decodeRtcBaselineCaptureRequest(input.request);
    }
    const request = Object.fromEntries(
        Object.entries(input.request).filter(([name]) => name !== 'repeatOf')
    );
    const supplied = Reflect.get(input.request, 'conditionalEnvironmentDecisions');
    const decoded = decodeRtcBaselineCaptureRequest({
        ...request,
        repeatLink: input.repeatLink,
        conditionalEnvironmentDecisions: Array.isArray(supplied) && supplied.length > 0
            ? supplied
            : input.inheritedDecisions
    });
    if (!decoded.ok) {
        return decoded;
    }
    const issues = [
        ...validateRtcBaselineCaptureRequest(decoded.value),
        ...validateRtcBaselineRepeatRequest(input.primary, decoded.value)
    ];
    return issues.length > 0
        ? { ok: false as const, issues }
        : { ok: true as const, value: decoded.value };
}
