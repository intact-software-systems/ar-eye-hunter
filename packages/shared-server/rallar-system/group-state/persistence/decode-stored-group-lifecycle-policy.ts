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

import { requireExactKeys, requireOneOf, requireString } from '../../protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';

export interface StoredGroupLifecyclePolicy {
    readonly groupRef: GroupRef;
    readonly policy: GroupLifecyclePolicy;
}

export function decodeStoredGroupLifecyclePolicy(
    value: JsonWireValue,
    expectedRef: GroupRef
): StoredGroupLifecyclePolicy {
    const stored = requireJsonWireObject(value, 'Stored group lifecycle policy');
    requireExactKeys(stored, ['groupRef', 'policy'], 'Stored group lifecycle policy');
    const groupRef = decodeStoredGroupRef(stored.groupRef);
    if (
        groupRef.applicationId !== expectedRef.applicationId ||
        groupRef.workspaceId !== expectedRef.workspaceId ||
        groupRef.groupId !== expectedRef.groupId
    ) {
        throw new TypeError('Stored group lifecycle policy identity differs from the requested group');
    }
    return {
        groupRef,
        policy: decodeCurrentGroupLifecyclePolicy(stored.policy)
    };
}

export function decodeCurrentGroupLifecyclePolicy(value: JsonWireValue): GroupLifecyclePolicy {
    const policy = requireJsonWireObject(value, 'Group lifecycle policy');
    requireExactKeys(
        policy,
        ['formation', 'initiator', 'manager', 'establishment', 'activation', 'admission', 'topology', 'data'],
        'Group lifecycle policy'
    );
    const decoded: GroupLifecyclePolicy = {
        formation: requireOneOf(policy.formation, ['phased', 'immediate'] as const, 'Policy formation'),
        initiator: requireOneOf(
            policy.initiator,
            ['manager', 'any-member', 'server-auto'] as const,
            'Policy initiator'
        ),
        manager: decodeManagerPolicy(policy.manager),
        establishment: decodeEstablishmentPolicy(policy.establishment),
        activation: decodeActivationCriterion(policy.activation),
        admission: decodeAdmissionPolicy(policy.admission),
        topology: decodeTopologyPolicy(policy.topology),
        data: decodeDataPolicy(policy.data)
    };
    return validateGroupLifecyclePolicy(decoded).fold(
        (issues) => {
            throw new TypeError(
                'Group lifecycle policy is incoherent: ' +
                    issues.map((issue) => issue.code).join(', ')
            );
        },
        (coherent) => coherent
    );
}

function decodeStoredGroupRef(value: JsonWireValue): GroupRef {
    const ref = requireJsonWireObject(value, 'Stored group lifecycle policy groupRef');
    requireExactKeys(
        ref,
        ['applicationId', 'workspaceId', 'groupId'],
        'Stored group lifecycle policy groupRef'
    );
    requireString(ref.applicationId, 'Stored group lifecycle policy applicationId');
    requireString(ref.workspaceId, 'Stored group lifecycle policy workspaceId');
    requireString(ref.groupId, 'Stored group lifecycle policy groupId');
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId
    };
}

function decodeManagerPolicy(value: JsonWireValue): GroupLifecyclePolicy['manager'] {
    const manager = requireJsonWireObject(value, 'Group lifecycle manager policy');
    requireExactKeys(
        manager,
        ['selection', 'assignedPrincipalIds', 'count', 'succession'],
        'Group lifecycle manager policy'
    );
    if (!Array.isArray(manager.assignedPrincipalIds)) {
        throw new TypeError('Group lifecycle manager assignedPrincipalIds must be an array');
    }
    const assignedPrincipalIds = manager.assignedPrincipalIds.map((principalId, index) => {
        requireString(principalId, `Group lifecycle manager assignedPrincipalIds[${index}]`);
        return principalId;
    });
    return {
        selection: requireOneOf(
            manager.selection,
            ['none', 'creator', 'assigned', 'elected-by-rank', 'elected-random-deterministic'] as const,
            'Group lifecycle manager selection'
        ),
        assignedPrincipalIds,
        count: requireBoundedInteger({
            value: manager.count,
            minimum: 1,
            maximum: MAX_GROUP_MANAGERS,
            label: 'Group lifecycle manager count'
        }),
        succession: requireOneOf(
            manager.succession,
            ['next-by-selection', 'none'] as const,
            'Group lifecycle manager succession'
        )
    };
}

function decodeEstablishmentPolicy(value: JsonWireValue): GroupLifecyclePolicy['establishment'] {
    const establishment = requireJsonWireObject(value, 'Group lifecycle establishment policy');
    requireExactKeys(
        establishment,
        ['transports', 'maxConcurrentEdgeSetups', 'planTrigger', 'connectTrigger'],
        'Group lifecycle establishment policy'
    );
    return {
        transports: requireOneOf(
            establishment.transports,
            ['rtc-and-ws', 'ws-only', 'rtc-preferred'] as const,
            'Group lifecycle establishment transports'
        ),
        maxConcurrentEdgeSetups: requireBoundedInteger({
            value: establishment.maxConcurrentEdgeSetups,
            minimum: 1,
            maximum: MAX_GROUP_CONCURRENT_EDGE_SETUPS,
            label: 'Group lifecycle establishment maxConcurrentEdgeSetups'
        }),
        planTrigger: decodeStageTrigger(establishment.planTrigger, 'planTrigger'),
        connectTrigger: decodeStageTrigger(establishment.connectTrigger, 'connectTrigger')
    };
}

function decodeStageTrigger(value: JsonWireValue, label: string): GroupStageTrigger {
    const trigger = requireJsonWireObject(value, `Group lifecycle establishment ${label}`);
    const kind = requireOneOf(
        trigger.kind,
        ['manual', 'immediate', 'after', 'presence'] as const,
        `Group lifecycle establishment ${label} kind`
    );
    if (kind === 'after') {
        requireExactKeys(trigger, ['kind', 'settleMs'], `Group lifecycle establishment ${label}`);
        return {
            kind,
            settleMs: requireBoundedInteger({
                value: trigger.settleMs,
                minimum: 0,
                maximum: MAX_GROUP_STAGE_TRIGGER_DELAY_MS,
                label: `Group lifecycle establishment ${label} settleMs`
            })
        };
    }
    if (kind === 'presence') {
        requireExactKeys(
            trigger,
            ['kind', 'memberCount', 'fallbackMs'],
            `Group lifecycle establishment ${label}`
        );
        return {
            kind,
            memberCount: requireBoundedInteger({
                value: trigger.memberCount,
                minimum: 1,
                maximum: MAX_GROUP_ADMISSION_MEMBER_COUNT,
                label: `Group lifecycle establishment ${label} memberCount`
            }),
            fallbackMs: requireBoundedInteger({
                value: trigger.fallbackMs,
                minimum: 0,
                maximum: MAX_GROUP_STAGE_TRIGGER_DELAY_MS,
                label: `Group lifecycle establishment ${label} fallbackMs`
            })
        };
    }
    requireExactKeys(trigger, ['kind'], `Group lifecycle establishment ${label}`);
    return { kind };
}

function decodeTopologyPolicy(value: JsonWireValue): GroupLifecyclePolicy['topology'] {
    const topology = requireJsonWireObject(value, 'Group lifecycle topology policy');
    requireExactKeys(
        topology,
        ['replanning', 'reconfigureLanding', 'debounceWindowMs', 'maxReplanWaitMs'],
        'Group lifecycle topology policy'
    );
    return {
        replanning: requireOneOf(
            topology.replanning,
            ['auto', 'debounced', 'commanded'] as const,
            'Group lifecycle topology replanning'
        ),
        reconfigureLanding: requireOneOf(
            topology.reconfigureLanding,
            ['apply', 'hold'] as const,
            'Group lifecycle topology reconfigureLanding'
        ),
        debounceWindowMs: requireBoundedInteger({
            value: topology.debounceWindowMs,
            minimum: 0,
            maximum: MAX_GROUP_TOPOLOGY_DEBOUNCE_WINDOW_MS,
            label: 'Group lifecycle topology debounceWindowMs'
        }),
        maxReplanWaitMs: requireBoundedInteger({
            value: topology.maxReplanWaitMs,
            minimum: 0,
            maximum: MAX_GROUP_TOPOLOGY_REPLAN_WAIT_MS,
            label: 'Group lifecycle topology maxReplanWaitMs'
        })
    };
}

function decodeActivationCriterion(value: JsonWireValue): GroupLifecyclePolicy['activation'] {
    const activation = requireJsonWireObject(value, 'Group lifecycle activation policy');
    requireExactKeys(
        activation,
        [
            'mode',
            'successRate',
            'minimumViableRate',
            'deadlineMs',
            'maxFormationAttempts',
            'strictConfirmation'
        ],
        'Group lifecycle activation policy'
    );
    if (typeof activation.strictConfirmation !== 'boolean') {
        throw new TypeError('Group lifecycle activation strictConfirmation must be boolean');
    }
    return {
        mode: requireOneOf(
            activation.mode,
            ['threshold', 'deadline', 'manual', 'threshold-or-deadline'] as const,
            'Group lifecycle activation mode'
        ),
        successRate: requireRate(activation.successRate, 'Group lifecycle activation successRate'),
        minimumViableRate: requireRate(
            activation.minimumViableRate,
            'Group lifecycle activation minimumViableRate'
        ),
        deadlineMs: requireBoundedInteger({
            value: activation.deadlineMs,
            minimum: 0,
            maximum: MAX_GROUP_FORMATION_DEADLINE_MS,
            label: 'Group lifecycle activation deadlineMs'
        }),
        maxFormationAttempts: requireBoundedInteger({
            value: activation.maxFormationAttempts,
            minimum: 1,
            maximum: MAX_GROUP_FORMATION_ATTEMPTS,
            label: 'Group lifecycle activation maxFormationAttempts'
        }),
        strictConfirmation: activation.strictConfirmation
    };
}

function decodeAdmissionPolicy(value: JsonWireValue): GroupLifecyclePolicy['admission'] {
    const admission = requireJsonWireObject(value, 'Group lifecycle admission policy');
    requireExactKeys(
        admission,
        ['mode', 'untilEpochMs', 'untilMemberCount'],
        'Group lifecycle admission policy'
    );
    return {
        mode: requireOneOf(
            admission.mode,
            ['open', 'manager-approval', 'closed'] as const,
            'Group lifecycle admission mode'
        ),
        untilEpochMs: requireNullableBoundedInteger({
            value: admission.untilEpochMs,
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
            label: 'Group lifecycle admission untilEpochMs'
        }),
        untilMemberCount: requireNullableBoundedInteger({
            value: admission.untilMemberCount,
            minimum: 1,
            maximum: MAX_GROUP_ADMISSION_MEMBER_COUNT,
            label: 'Group lifecycle admission untilMemberCount'
        })
    };
}

function decodeDataPolicy(value: JsonWireValue): GroupLifecyclePolicy['data'] {
    const data = requireJsonWireObject(value, 'Group lifecycle data policy');
    requireExactKeys(data, ['preActivationAppData'], 'Group lifecycle data policy');
    return {
        preActivationAppData: requireOneOf(
            data.preActivationAppData,
            ['allowed', 'blocked-until-active'] as const,
            'Group lifecycle data preActivationAppData'
        )
    };
}

function requireJsonWireObject(value: JsonWireValue, label: string): JsonWireObject {
    if (!isJsonWireObject(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRate(value: JsonWireValue, label: string): number {
    if (typeof value !== 'number' || value < 0 || value > 1) {
        throw new TypeError(`${label} must be between zero and one`);
    }
    return value;
}

interface BoundedIntegerInput {
    readonly value: JsonWireValue;
    readonly minimum: number;
    readonly maximum: number;
    readonly label: string;
}

function requireBoundedInteger(input: BoundedIntegerInput): number {
    const { value, minimum, maximum, label } = input;
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new TypeError(`${label} is outside the current supported range`);
    }
    return value as number;
}

function requireNullableBoundedInteger(input: BoundedIntegerInput): number | null {
    return input.value === null ? null : requireBoundedInteger(input);
}
