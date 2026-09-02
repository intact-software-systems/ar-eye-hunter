import {
    GROUP_ESTABLISHMENT_TRANSPORTS,
    GROUP_LIFECYCLE_POLICY_PRESET_NAMES
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import { isGroupInputRecord, validateGroupInputJson } from './group-input-validation-issues.ts';

type PolicyShapeField =
    | { readonly key: string; readonly kind: 'number' | 'nullable-number' | 'boolean' | 'principal-ids' | 'trigger'; }
    | { readonly key: string; readonly kind: 'enum'; readonly values: readonly string[]; }
    | { readonly key: string; readonly kind: 'object'; readonly fields: readonly PolicyShapeField[]; };

const POLICY_FIELDS: readonly PolicyShapeField[] = [
    { key: 'preset', kind: 'enum', values: GROUP_LIFECYCLE_POLICY_PRESET_NAMES },
    { key: 'formation', kind: 'enum', values: ['phased', 'immediate'] },
    { key: 'initiator', kind: 'enum', values: ['manager', 'any-member', 'server-auto'] },
    {
        key: 'manager',
        kind: 'object',
        fields: [
            {
                key: 'selection',
                kind: 'enum',
                values: ['none', 'creator', 'assigned', 'elected-by-rank', 'elected-random-deterministic']
            },
            { key: 'assignedPrincipalIds', kind: 'principal-ids' },
            { key: 'count', kind: 'number' },
            { key: 'succession', kind: 'enum', values: ['next-by-selection', 'none'] }
        ]
    },
    {
        key: 'establishment',
        kind: 'object',
        fields: [
            { key: 'transports', kind: 'enum', values: GROUP_ESTABLISHMENT_TRANSPORTS },
            { key: 'maxConcurrentEdgeSetups', kind: 'number' },
            { key: 'planTrigger', kind: 'trigger' },
            { key: 'connectTrigger', kind: 'trigger' }
        ]
    },
    {
        key: 'activation',
        kind: 'object',
        fields: [
            { key: 'mode', kind: 'enum', values: ['threshold', 'deadline', 'manual', 'threshold-or-deadline'] },
            { key: 'successRate', kind: 'number' },
            { key: 'minimumViableRate', kind: 'number' },
            { key: 'deadlineMs', kind: 'number' },
            { key: 'maxFormationAttempts', kind: 'number' },
            { key: 'strictConfirmation', kind: 'boolean' }
        ]
    },
    {
        key: 'admission',
        kind: 'object',
        fields: [
            { key: 'mode', kind: 'enum', values: ['open', 'manager-approval', 'closed'] },
            { key: 'untilEpochMs', kind: 'nullable-number' },
            { key: 'untilMemberCount', kind: 'nullable-number' }
        ]
    },
    {
        key: 'topology',
        kind: 'object',
        fields: [
            { key: 'replanning', kind: 'enum', values: ['auto', 'debounced', 'commanded'] },
            { key: 'reconfigureLanding', kind: 'enum', values: ['apply', 'hold'] },
            { key: 'debounceWindowMs', kind: 'number' },
            { key: 'maxReplanWaitMs', kind: 'number' }
        ]
    },
    {
        key: 'data',
        kind: 'object',
        fields: [
            { key: 'preActivationAppData', kind: 'enum', values: ['allowed', 'blocked-until-active'] }
        ]
    }
];

/** Sparse input shape only; range clamps and policy contradictions keep their existing owners. */
export function validateGroupLifecyclePolicyInputShape(value: unknown): readonly TypeError[] {
    const jsonIssues = validateGroupInputJson(value, 'Group lifecyclePolicy');
    if (jsonIssues.length > 0) {
        return jsonIssues;
    }
    return validatePolicyObject(value, POLICY_FIELDS, 'Group lifecyclePolicy');
}

function validatePolicyObject(
    value: unknown,
    fields: readonly PolicyShapeField[],
    label: string
): readonly TypeError[] {
    if (!isGroupInputRecord(value)) {
        return [new TypeError(`${label} must be an object`)];
    }
    const issues = validatePolicyKeys(value, fields.map((field) => field.key), label);
    return [
        ...issues,
        ...fields.flatMap((field) =>
            value[field.key] === undefined ? [] : validatePolicyField(value[field.key], field, `${label} ${field.key}`)
        )
    ];
}

function validatePolicyField(value: unknown, field: PolicyShapeField, label: string): readonly TypeError[] {
    switch (field.kind) {
        case 'object':
            return validatePolicyObject(value, field.fields, label);
        case 'trigger':
            return validateTrigger(value, label);
        case 'enum':
            return typeof value === 'string' && field.values.includes(value)
                ? []
                : [new TypeError(`${label} must be one of ${field.values.join(', ')}`)];
        case 'number':
        case 'nullable-number':
            return field.kind === 'nullable-number' && value === null ? [] : validateNumber(value, label);
        case 'boolean':
            return typeof value === 'boolean' ? [] : [new TypeError(`${label} must be a boolean`)];
        case 'principal-ids':
            return Array.isArray(value) &&
                    value.every((principalId) => typeof principalId === 'string' && principalId.length > 0)
                ? []
                : [new TypeError(`${label} must be non-empty strings`)];
    }
}

function validateTrigger(value: unknown, label: string): readonly TypeError[] {
    if (!isGroupInputRecord(value)) {
        return [new TypeError(`${label} must be an object`)];
    }
    switch (value.kind) {
        case 'manual':
        case 'immediate':
            return validatePolicyKeys(value, ['kind'], label);
        case 'after':
            return [
                ...validatePolicyKeys(value, ['kind', 'settleMs'], label),
                ...validateNumber(value.settleMs, `${label} settleMs`)
            ];
        case 'presence':
            return [
                ...validatePolicyKeys(value, ['kind', 'memberCount', 'fallbackMs'], label),
                ...validateNumber(value.memberCount, `${label} memberCount`),
                ...validateNumber(value.fallbackMs, `${label} fallbackMs`)
            ];
        default:
            return [new TypeError(`${label} kind is not a supported trigger kind`)];
    }
}

function validatePolicyKeys(value: object, keys: readonly string[], label: string): readonly TypeError[] {
    return Object.keys(value).filter((key) => !keys.includes(key))
        .map((key) => new TypeError(`${label} has an unsupported key: ${key}`));
}

function validateNumber(value: unknown, label: string): readonly TypeError[] {
    return typeof value === 'number' && Number.isFinite(value)
        ? []
        : [new TypeError(`${label} must be a finite number`)];
}
