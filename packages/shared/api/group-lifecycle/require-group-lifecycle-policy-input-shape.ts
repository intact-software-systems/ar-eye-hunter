import { GROUP_LIFECYCLE_POLICY_PRESET_NAMES } from './group-lifecycle-policy.ts';

/**
 * Boundary enforcement for the sparse `lifecyclePolicy` input. Unknown keys
 * and unknown discriminants are rejected loudly here because the normalizer
 * is silent and total: without this gate a retired input key (such as the
 * pre-move `establishment.initiator`) would be dropped rather than answered,
 * silently widening the resolved policy, and a malformed trigger would
 * survive normalization only to throw from the persistence codec inside the
 * write transaction. Range problems stay with the clamps and cross-field
 * contradictions with validateGroupLifecyclePolicy; this owns shape alone.
 */
export function requireGroupLifecyclePolicyInputShape(value: unknown): void {
    const input = requireShapeRecord(value, 'Group lifecyclePolicy');
    requireAllowedKeys(input, [
        'preset',
        'formation',
        'initiator',
        'manager',
        'establishment',
        'activation',
        'admission',
        'topology',
        'data'
    ], 'Group lifecyclePolicy');
    requireOptionalEnum(input.preset, GROUP_LIFECYCLE_POLICY_PRESET_NAMES, 'Group lifecyclePolicy preset');
    requireOptionalEnum(input.formation, ['phased', 'immediate'], 'Group lifecyclePolicy formation');
    requireOptionalEnum(
        input.initiator,
        ['manager', 'any-member', 'server-auto'],
        'Group lifecyclePolicy initiator'
    );
    requireManagerShape(input.manager);
    requireEstablishmentShape(input.establishment);
    requireActivationShape(input.activation);
    requireAdmissionShape(input.admission);
    requireTopologyShape(input.topology);
    requireDataShape(input.data);
}

function requireManagerShape(value: unknown): void {
    if (value === undefined) {
        return;
    }
    const manager = requireShapeRecord(value, 'Group lifecyclePolicy manager');
    requireAllowedKeys(
        manager,
        ['selection', 'assignedPrincipalIds', 'count', 'succession'],
        'Group lifecyclePolicy manager'
    );
    requireOptionalEnum(
        manager.selection,
        ['none', 'creator', 'assigned', 'elected-by-rank', 'elected-random-deterministic'],
        'Group lifecyclePolicy manager selection'
    );
    if (manager.assignedPrincipalIds !== undefined) {
        if (
            !Array.isArray(manager.assignedPrincipalIds) ||
            manager.assignedPrincipalIds.some(
                (principalId) => typeof principalId !== 'string' || principalId.length === 0
            )
        ) {
            throw new TypeError('Group lifecyclePolicy manager assignedPrincipalIds must be non-empty strings');
        }
    }
    requireOptionalNumber(manager.count, 'Group lifecyclePolicy manager count');
    requireOptionalEnum(
        manager.succession,
        ['next-by-selection', 'none'],
        'Group lifecyclePolicy manager succession'
    );
}

function requireEstablishmentShape(value: unknown): void {
    if (value === undefined) {
        return;
    }
    const establishment = requireShapeRecord(value, 'Group lifecyclePolicy establishment');
    requireAllowedKeys(
        establishment,
        ['transports', 'maxConcurrentEdgeSetups', 'planTrigger', 'connectTrigger'],
        'Group lifecyclePolicy establishment'
    );
    requireOptionalEnum(
        establishment.transports,
        ['rtc-and-ws', 'ws-only', 'rtc-preferred'],
        'Group lifecyclePolicy establishment transports'
    );
    requireOptionalNumber(
        establishment.maxConcurrentEdgeSetups,
        'Group lifecyclePolicy establishment maxConcurrentEdgeSetups'
    );
    requireTriggerShape(establishment.planTrigger, 'planTrigger');
    requireTriggerShape(establishment.connectTrigger, 'connectTrigger');
}

function requireTriggerShape(value: unknown, label: string): void {
    if (value === undefined) {
        return;
    }
    const trigger = requireShapeRecord(value, `Group lifecyclePolicy establishment ${label}`);
    const kind = trigger.kind;
    if (kind === 'manual' || kind === 'immediate') {
        requireAllowedKeys(trigger, ['kind'], `Group lifecyclePolicy establishment ${label}`);
        return;
    }
    if (kind === 'after') {
        requireAllowedKeys(trigger, ['kind', 'settleMs'], `Group lifecyclePolicy establishment ${label}`);
        requireNumber(trigger.settleMs, `Group lifecyclePolicy establishment ${label} settleMs`);
        return;
    }
    if (kind === 'presence') {
        requireAllowedKeys(
            trigger,
            ['kind', 'memberCount', 'fallbackMs'],
            `Group lifecyclePolicy establishment ${label}`
        );
        requireNumber(trigger.memberCount, `Group lifecyclePolicy establishment ${label} memberCount`);
        requireNumber(trigger.fallbackMs, `Group lifecyclePolicy establishment ${label} fallbackMs`);
        return;
    }
    throw new TypeError(`Group lifecyclePolicy establishment ${label} kind is not a known trigger kind`);
}

function requireActivationShape(value: unknown): void {
    if (value === undefined) {
        return;
    }
    const activation = requireShapeRecord(value, 'Group lifecyclePolicy activation');
    requireAllowedKeys(
        activation,
        ['mode', 'successRate', 'minimumViableRate', 'deadlineMs', 'maxFormationAttempts', 'strictConfirmation'],
        'Group lifecyclePolicy activation'
    );
    requireOptionalEnum(
        activation.mode,
        ['threshold', 'deadline', 'manual', 'threshold-or-deadline'],
        'Group lifecyclePolicy activation mode'
    );
    requireOptionalNumber(activation.successRate, 'Group lifecyclePolicy activation successRate');
    requireOptionalNumber(activation.minimumViableRate, 'Group lifecyclePolicy activation minimumViableRate');
    requireOptionalNumber(activation.deadlineMs, 'Group lifecyclePolicy activation deadlineMs');
    requireOptionalNumber(
        activation.maxFormationAttempts,
        'Group lifecyclePolicy activation maxFormationAttempts'
    );
    if (activation.strictConfirmation !== undefined && typeof activation.strictConfirmation !== 'boolean') {
        throw new TypeError('Group lifecyclePolicy activation strictConfirmation must be a boolean');
    }
}

function requireAdmissionShape(value: unknown): void {
    if (value === undefined) {
        return;
    }
    const admission = requireShapeRecord(value, 'Group lifecyclePolicy admission');
    requireAllowedKeys(
        admission,
        ['mode', 'untilEpochMs', 'untilMemberCount'],
        'Group lifecyclePolicy admission'
    );
    requireOptionalEnum(
        admission.mode,
        ['open', 'manager-approval', 'closed'],
        'Group lifecyclePolicy admission mode'
    );
    requireOptionalNullableNumber(admission.untilEpochMs, 'Group lifecyclePolicy admission untilEpochMs');
    requireOptionalNullableNumber(
        admission.untilMemberCount,
        'Group lifecyclePolicy admission untilMemberCount'
    );
}

function requireTopologyShape(value: unknown): void {
    if (value === undefined) {
        return;
    }
    const topology = requireShapeRecord(value, 'Group lifecyclePolicy topology');
    requireAllowedKeys(
        topology,
        ['replanning', 'reconfigureLanding', 'debounceWindowMs', 'maxReplanWaitMs'],
        'Group lifecyclePolicy topology'
    );
    requireOptionalEnum(
        topology.replanning,
        ['auto', 'debounced', 'commanded'],
        'Group lifecyclePolicy topology replanning'
    );
    requireOptionalEnum(
        topology.reconfigureLanding,
        ['apply', 'hold'],
        'Group lifecyclePolicy topology reconfigureLanding'
    );
    requireOptionalNumber(topology.debounceWindowMs, 'Group lifecyclePolicy topology debounceWindowMs');
    requireOptionalNumber(topology.maxReplanWaitMs, 'Group lifecyclePolicy topology maxReplanWaitMs');
}

function requireDataShape(value: unknown): void {
    if (value === undefined) {
        return;
    }
    const data = requireShapeRecord(value, 'Group lifecyclePolicy data');
    requireAllowedKeys(data, ['preActivationAppData'], 'Group lifecyclePolicy data');
    requireOptionalEnum(
        data.preActivationAppData,
        ['allowed', 'blocked-until-active'],
        'Group lifecyclePolicy data preActivationAppData'
    );
}

function requireShapeRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireAllowedKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    label: string
): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new TypeError(`${label} has an unknown key: ${key}`);
        }
    }
}

function requireOptionalEnum(
    value: unknown,
    allowed: readonly string[],
    label: string
): void {
    if (value === undefined) {
        return;
    }
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new TypeError(`${label} must be one of ${allowed.join(', ')}`);
    }
}

function requireNumber(value: unknown, label: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number`);
    }
}

function requireOptionalNumber(value: unknown, label: string): void {
    if (value !== undefined) {
        requireNumber(value, label);
    }
}

function requireOptionalNullableNumber(value: unknown, label: string): void {
    if (value !== undefined && value !== null) {
        requireNumber(value, label);
    }
}
