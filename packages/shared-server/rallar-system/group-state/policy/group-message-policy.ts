import type { GroupPreActivationAppData } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    denyUnlessActiveGroupMember,
    findGroupMember,
    isLiveGroupPresenceSession,
    requireActiveGroup
} from './group-policy-primitives.ts';
import { denyGroupPolicy, GROUP_POLICY_ALLOWED, type GroupPolicyActor } from './group-policy-result.ts';

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
        input.snapshot.group.lifecycleState !== 'active'
    ) {
        return denyGroupPolicy(
            'group-data-blocked-until-active',
            'Application data is blocked until the group activates.'
        );
    }
    return GROUP_POLICY_ALLOWED;
}
