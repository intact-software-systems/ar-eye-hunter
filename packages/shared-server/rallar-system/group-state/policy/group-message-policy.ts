import type {
    GroupLifecycleState,
    GroupPreActivationAppData
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    denyUnlessActiveGroupMember,
    findGroupMember,
    isLiveGroupPresenceSession,
    requireActiveGroup
} from './group-policy-primitives.ts';
import { denyGroupPolicy, GROUP_POLICY_ALLOWED, type GroupPolicyActor } from './group-policy-result.ts';

/**
 * Whether `blocked-until-active` blocks application data in each stage. The
 * rows deliberately preserve today's `!== 'active'` behaviour, including for
 * the unreachable stages; the product forward gate — open in `reconfiguring`
 * and `reconnecting` (product decision 25), expressed by
 * `computeGroupDataGate` — replaces these rows in the transport-valve slice,
 * not before.
 */
const PRE_ACTIVATION_DATA_BLOCKS: Readonly<Record<GroupLifecycleState, boolean>> = {
    dormant: true,
    forming: true,
    planned: true,
    connecting: true,
    active: false,
    reconfiguring: true,
    reconnecting: true
};

/**
 * Fails closed: a stage the registry does not know blocks rather than flows,
 * because this is the one stage table whose miss would otherwise open a gate.
 */
export function blocksGroupPreActivationData(lifecycleState: GroupLifecycleState): boolean {
    return PRE_ACTIVATION_DATA_BLOCKS[lifecycleState] ?? true;
}

export interface CanSendGroupMessageInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly senderSessionId: string;
    readonly minSnapshotVersion?: number;
    readonly nowEpochMs?: number;
    readonly preActivationAppData?: GroupPreActivationAppData;
}

export function canSendGroupMessage(
    input: CanSendGroupMessageInput
): GroupPolicyResult {
    if (
        input.minSnapshotVersion !== undefined &&
        input.snapshot.group.snapshotVersion < input.minSnapshotVersion
    ) {
        return denyGroupPolicy('group-policy-denied', 'Group snapshot is not fresh enough.');
    }
    const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
    if (lifecycleDenial) {
        return lifecycleDenial;
    }
    const liveSession = input.snapshot.activeSessions.find(
        (session) =>
            session.sessionId === input.senderSessionId &&
            isLiveGroupPresenceSession(session, input.nowEpochMs)
    );
    const principalId = input.actor.principalId ?? liveSession?.principalId;
    if (!liveSession || !principalId || liveSession.principalId !== principalId) {
        return denyGroupPolicy(
            'member-not-active',
            'A live active group session is required to send group messages.'
        );
    }
    const memberDenial = denyUnlessActiveGroupMember(
        findGroupMember(input.snapshot, principalId)
    );
    if (memberDenial) {
        return memberDenial;
    }
    if (
        input.preActivationAppData === 'blocked-until-active' &&
        blocksGroupPreActivationData(input.snapshot.group.lifecycleState)
    ) {
        return denyGroupPolicy(
            'group-data-blocked-until-active',
            'Application data is blocked until the group activates.'
        );
    }
    return GROUP_POLICY_ALLOWED;
}
