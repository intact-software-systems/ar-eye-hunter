import type { GroupLifecyclePolicy, GroupStageTrigger } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    MAX_GROUP_ADMISSION_MEMBER_COUNT,
    MAX_GROUP_CONCURRENT_EDGE_SETUPS,
    MAX_GROUP_FORMATION_ATTEMPTS,
    MAX_GROUP_FORMATION_DEADLINE_MS,
    MAX_GROUP_MANAGERS,
    MAX_GROUP_STAGE_TRIGGER_DELAY_MS,
    MAX_GROUP_TOPOLOGY_DEBOUNCE_WINDOW_MS,
    MAX_GROUP_TOPOLOGY_REPLAN_WAIT_MS
} from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import { validateGroupLifecyclePolicy } from '@shared/api/group-lifecycle/validate-group-lifecycle-policy.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    validateNonEmptyString,
    validateOneOf,
    validateRecord,
    type GroupStateValidationIssue
} from '../group-state-validation-issues.ts';

export interface StoredGroupLifecyclePolicy {
    readonly groupRef: GroupRef;
    readonly policy: GroupLifecyclePolicy;
}

interface BoundedIntegerInput {
    readonly value: unknown;
    readonly minimum: number;
    readonly maximum: number;
    readonly label: string;
}

export function decodeStoredGroupLifecyclePolicy(
    value: JsonWireValue,
    expectedRef: GroupRef
): StoredGroupLifecyclePolicy {
    if (!isGroupStateRecord(value)) {
        throw new TypeError('Stored group lifecycle policy must be an object');
    }
    const issues = validatePolicyKeys(value, ['groupRef', 'policy'], 'Stored group lifecycle policy');
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    const groupRef = decodeStoredGroupRef(value.groupRef);
    if (
        groupRef.applicationId !== expectedRef.applicationId ||
        groupRef.workspaceId !== expectedRef.workspaceId ||
        groupRef.groupId !== expectedRef.groupId
    ) {
        throw new TypeError('Stored group lifecycle policy identity differs from the requested group');
    }
    return { groupRef, policy: decodeCurrentGroupLifecyclePolicy(value.policy as JsonWireValue) };
}

export function decodeCurrentGroupLifecyclePolicy(value: JsonWireValue): GroupLifecyclePolicy {
    const issues = validateCurrentGroupLifecyclePolicy(value);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    return computeCanonicalGroupLifecyclePolicy(value as GroupLifecyclePolicy);
}

export function computeCanonicalGroupLifecyclePolicy(policy: GroupLifecyclePolicy): GroupLifecyclePolicy {
    return {
        formation: policy.formation,
        initiator: policy.initiator,
        manager: {
            selection: policy.manager.selection,
            assignedPrincipalIds: [...policy.manager.assignedPrincipalIds],
            count: policy.manager.count,
            succession: policy.manager.succession
        },
        establishment: {
            transports: policy.establishment.transports,
            maxConcurrentEdgeSetups: policy.establishment.maxConcurrentEdgeSetups,
            planTrigger: copyStageTrigger(policy.establishment.planTrigger),
            connectTrigger: copyStageTrigger(policy.establishment.connectTrigger)
        },
        activation: {
            mode: policy.activation.mode,
            successRate: policy.activation.successRate,
            minimumViableRate: policy.activation.minimumViableRate,
            deadlineMs: policy.activation.deadlineMs,
            maxFormationAttempts: policy.activation.maxFormationAttempts,
            strictConfirmation: policy.activation.strictConfirmation
        },
        admission: {
            mode: policy.admission.mode,
            untilEpochMs: policy.admission.untilEpochMs,
            untilMemberCount: policy.admission.untilMemberCount
        },
        topology: {
            replanning: policy.topology.replanning,
            reconfigureLanding: policy.topology.reconfigureLanding,
            debounceWindowMs: policy.topology.debounceWindowMs,
            maxReplanWaitMs: policy.topology.maxReplanWaitMs
        },
        data: { preActivationAppData: policy.data.preActivationAppData }
    };
}

export function validateCurrentGroupLifecyclePolicy(value: unknown): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, 'Group lifecycle policy');
    }
    const issues = [
        ...validatePolicyKeys(value, [
            'formation',
            'initiator',
            'manager',
            'establishment',
            'activation',
            'admission',
            'topology',
            'data'
        ], 'Group lifecycle policy'),
        ...validateOneOf(value.formation, ['phased', 'immediate'], 'Policy formation'),
        ...validateOneOf(value.initiator, ['manager', 'any-member', 'server-auto'], 'Policy initiator'),
        ...validateManagerPolicy(value.manager),
        ...validateEstablishmentPolicy(value.establishment),
        ...validateActivationPolicy(value.activation),
        ...validateAdmissionPolicy(value.admission),
        ...validateTopologyPolicy(value.topology),
        ...validateDataPolicy(value.data)
    ];
    if (issues.length > 0) {
        return issues;
    }
    const coherence = validateGroupLifecyclePolicy(value as unknown as GroupLifecyclePolicy).left ?? [];
    const message = 'Group lifecycle policy is incoherent: ' + coherence.map((issue) => issue.code).join(', ');
    return coherence.map((issue) => toGroupStateValidationIssue(issue.field, message));
}

function decodeStoredGroupRef(value: unknown): GroupRef {
    if (!isGroupStateRecord(value)) {
        throw new TypeError('Stored group lifecycle policy groupRef must be an object');
    }
    const issues = [
        ...validatePolicyKeys(
            value,
            ['applicationId', 'workspaceId', 'groupId'],
            'Stored group lifecycle policy groupRef'
        ),
        ...validateNonEmptyString(value.applicationId, 'Stored group lifecycle policy applicationId'),
        ...validateNonEmptyString(value.workspaceId, 'Stored group lifecycle policy workspaceId'),
        ...validateNonEmptyString(value.groupId, 'Stored group lifecycle policy groupId')
    ];
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    return {
        applicationId: value.applicationId as string,
        workspaceId: value.workspaceId as string,
        groupId: value.groupId as string
    };
}

function validateManagerPolicy(value: unknown): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, 'Group lifecycle manager policy');
    }
    return [
        ...validatePolicyKeys(
            value,
            ['selection', 'assignedPrincipalIds', 'count', 'succession'],
            'Group lifecycle manager policy'
        ),
        ...(Array.isArray(value.assignedPrincipalIds)
            ? value.assignedPrincipalIds.flatMap((id, index) =>
                validateNonEmptyString(id, `Group lifecycle manager assignedPrincipalIds[${index}]`)
            )
            : [toGroupStateValidationIssue(
                'manager.assignedPrincipalIds',
                'Group lifecycle manager assignedPrincipalIds must be an array'
            )]),
        ...validateOneOf(value.selection, [
            'none',
            'creator',
            'assigned',
            'elected-by-rank',
            'elected-random-deterministic'
        ], 'Group lifecycle manager selection'),
        ...validateBoundedInteger({
            value: value.count,
            minimum: 1,
            maximum: MAX_GROUP_MANAGERS,
            label: 'Group lifecycle manager count'
        }),
        ...validateOneOf(value.succession, ['next-by-selection', 'none'], 'Group lifecycle manager succession')
    ];
}

function validateEstablishmentPolicy(value: unknown): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, 'Group lifecycle establishment policy');
    }
    return [
        ...validatePolicyKeys(
            value,
            ['transports', 'maxConcurrentEdgeSetups', 'planTrigger', 'connectTrigger'],
            'Group lifecycle establishment policy'
        ),
        ...validateOneOf(
            value.transports,
            ['rtc-and-ws', 'ws-only', 'rtc-preferred'],
            'Group lifecycle establishment transports'
        ),
        ...validateBoundedInteger({
            value: value.maxConcurrentEdgeSetups,
            minimum: 1,
            maximum: MAX_GROUP_CONCURRENT_EDGE_SETUPS,
            label: 'Group lifecycle establishment maxConcurrentEdgeSetups'
        }),
        ...validateStageTrigger(value.planTrigger, 'planTrigger'),
        ...validateStageTrigger(value.connectTrigger, 'connectTrigger')
    ];
}

function validateStageTrigger(value: unknown, name: string): readonly GroupStateValidationIssue[] {
    const label = `Group lifecycle establishment ${name}`;
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, label);
    }
    const issues = [...validateOneOf(value.kind, ['manual', 'immediate', 'after', 'presence'], `${label} kind`)];
    if (value.kind === 'after') {
        issues.push(...validatePolicyKeys(value, ['kind', 'settleMs'], label));
        issues.push(
            ...validateBoundedInteger({
                value: value.settleMs,
                minimum: 0,
                maximum: MAX_GROUP_STAGE_TRIGGER_DELAY_MS,
                label: `${label} settleMs`
            })
        );
    }
    else if (value.kind === 'presence') {
        issues.push(...validatePolicyKeys(value, ['kind', 'memberCount', 'fallbackMs'], label));
        issues.push(
            ...validateBoundedInteger({
                value: value.memberCount,
                minimum: 1,
                maximum: MAX_GROUP_ADMISSION_MEMBER_COUNT,
                label: `${label} memberCount`
            })
        );
        issues.push(
            ...validateBoundedInteger({
                value: value.fallbackMs,
                minimum: 0,
                maximum: MAX_GROUP_STAGE_TRIGGER_DELAY_MS,
                label: `${label} fallbackMs`
            })
        );
    }
    else if (value.kind === 'manual' || value.kind === 'immediate') {
        issues.push(...validatePolicyKeys(value, ['kind'], label));
    }
    return issues;
}

function copyStageTrigger(trigger: GroupStageTrigger): GroupStageTrigger {
    switch (trigger.kind) {
        case 'after':
            return { kind: trigger.kind, settleMs: trigger.settleMs };
        case 'presence':
            return { kind: trigger.kind, memberCount: trigger.memberCount, fallbackMs: trigger.fallbackMs };
        default:
            return { kind: trigger.kind };
    }
}

function validateActivationPolicy(value: unknown): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, 'Group lifecycle activation policy');
    }
    return [
        ...validatePolicyKeys(value, [
            'mode',
            'successRate',
            'minimumViableRate',
            'deadlineMs',
            'maxFormationAttempts',
            'strictConfirmation'
        ], 'Group lifecycle activation policy'),
        ...(typeof value.strictConfirmation === 'boolean'
            ? []
            : [toGroupStateValidationIssue(
                'activation.strictConfirmation',
                'Group lifecycle activation strictConfirmation must be boolean'
            )]),
        ...validateOneOf(
            value.mode,
            ['threshold', 'deadline', 'manual', 'threshold-or-deadline'],
            'Group lifecycle activation mode'
        ),
        ...validateRate(value.successRate, 'Group lifecycle activation successRate'),
        ...validateRate(value.minimumViableRate, 'Group lifecycle activation minimumViableRate'),
        ...validateBoundedInteger({
            value: value.deadlineMs,
            minimum: 0,
            maximum: MAX_GROUP_FORMATION_DEADLINE_MS,
            label: 'Group lifecycle activation deadlineMs'
        }),
        ...validateBoundedInteger({
            value: value.maxFormationAttempts,
            minimum: 1,
            maximum: MAX_GROUP_FORMATION_ATTEMPTS,
            label: 'Group lifecycle activation maxFormationAttempts'
        })
    ];
}

function validateAdmissionPolicy(value: unknown): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, 'Group lifecycle admission policy');
    }
    return [
        ...validatePolicyKeys(value, ['mode', 'untilEpochMs', 'untilMemberCount'], 'Group lifecycle admission policy'),
        ...validateOneOf(value.mode, ['open', 'manager-approval', 'closed'], 'Group lifecycle admission mode'),
        ...(value.untilEpochMs === null
            ? []
            : validateBoundedInteger({
                value: value.untilEpochMs,
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                label: 'Group lifecycle admission untilEpochMs'
            })),
        ...(value.untilMemberCount === null
            ? []
            : validateBoundedInteger({
                value: value.untilMemberCount,
                minimum: 1,
                maximum: MAX_GROUP_ADMISSION_MEMBER_COUNT,
                label: 'Group lifecycle admission untilMemberCount'
            }))
    ];
}

function validateTopologyPolicy(value: unknown): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, 'Group lifecycle topology policy');
    }
    return [
        ...validatePolicyKeys(
            value,
            ['replanning', 'reconfigureLanding', 'debounceWindowMs', 'maxReplanWaitMs'],
            'Group lifecycle topology policy'
        ),
        ...validateOneOf(value.replanning, ['auto', 'debounced', 'commanded'], 'Group lifecycle topology replanning'),
        ...validateOneOf(value.reconfigureLanding, ['apply', 'hold'], 'Group lifecycle topology reconfigureLanding'),
        ...validateBoundedInteger({
            value: value.debounceWindowMs,
            minimum: 0,
            maximum: MAX_GROUP_TOPOLOGY_DEBOUNCE_WINDOW_MS,
            label: 'Group lifecycle topology debounceWindowMs'
        }),
        ...validateBoundedInteger({
            value: value.maxReplanWaitMs,
            minimum: 0,
            maximum: MAX_GROUP_TOPOLOGY_REPLAN_WAIT_MS,
            label: 'Group lifecycle topology maxReplanWaitMs'
        })
    ];
}

function validateDataPolicy(value: unknown): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, 'Group lifecycle data policy');
    }
    return [
        ...validatePolicyKeys(value, ['preActivationAppData'], 'Group lifecycle data policy'),
        ...validateOneOf(
            value.preActivationAppData,
            ['allowed', 'blocked-until-active'],
            'Group lifecycle data preActivationAppData'
        )
    ];
}

function validatePolicyKeys(
    value: object,
    keys: readonly string[],
    label: string
): readonly GroupStateValidationIssue[] {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key))
        ? []
        : [toGroupStateValidationIssue(label, `${label} fields are invalid`)];
}

function validateRate(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        ? []
        : [toGroupStateValidationIssue(label, `${label} must be between zero and one`)];
}

function validateBoundedInteger(input: BoundedIntegerInput): readonly GroupStateValidationIssue[] {
    const { value, minimum, maximum, label } = input;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
        ? []
        : [toGroupStateValidationIssue(label, `${label} is outside the current supported range`)];
}
