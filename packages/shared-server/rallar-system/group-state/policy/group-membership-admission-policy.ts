import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { denyUnlessGroupLifecycleManager } from './group-lifecycle-manager-policy.ts';
import {
    denyForBlockedGroupMember,
    denyUnlessActiveGroupMember,
    findActorGroupMember,
    findGroupMember,
    isLiveGroupPresenceSession,
    requireActiveGroup
} from './group-policy-primitives.ts';
import { denyGroupPolicy, GROUP_POLICY_ALLOWED, type GroupPolicyActor } from './group-policy-result.ts';

export interface GroupPolicyCapacityConfig {
    readonly defaultMaxMembers: number | null;
}

export interface CanJoinGroupInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly nowEpochMs?: number;
    readonly capacity?: GroupPolicyCapacityConfig;
    readonly inviteToken?: string;
    readonly expectedInviteToken?: string;
    readonly joinCode?: string;
    readonly expectedJoinCode?: string;
    readonly joinCodeVerifier?: string;
    readonly expectedJoinCodeVerifier?: string;
    readonly joinCodeExpiresAtEpochMs?: number;
}

export interface CanConnectGroupPresenceSessionInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly sessionId: string;
    readonly nowEpochMs?: number;
}

export interface CanActivateGroupMemberInput {
    readonly snapshot: GroupSnapshot;
    readonly targetPrincipalId: string;
    readonly nowEpochMs?: number;
    readonly capacity?: GroupPolicyCapacityConfig;
}

export interface CanDecideGroupAdmissionInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly policy: GroupLifecyclePolicy;
    readonly activeMemberPrincipalIds: readonly string[];
    readonly nowEpochMs?: number;
}

export function canJoinGroup(input: CanJoinGroupInput): GroupPolicyResult {
    const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
    if (lifecycleDenial) {
        return lifecycleDenial;
    }
    const principalId = input.actor.principalId;
    if (!principalId) {
        return denyGroupPolicy('group-policy-denied', 'A principal is required to join a group.');
    }
    const member = findGroupMember(input.snapshot, principalId);
    const memberDenial = denyForBlockedGroupMember(member);
    if (memberDenial) {
        return memberDenial;
    }
    if (wouldExceedMemberCap(input.snapshot, member, input.capacity)) {
        return denyGroupPolicy('group-full', 'Group member capacity has been reached.');
    }
    switch (input.snapshot.group.joinMode) {
        case 'open':
            return GROUP_POLICY_ALLOWED;
        case 'invite-only':
            return canUseInvite(input, member);
        case 'code':
            return canUseJoinCode(input);
    }
}

export function canConnectGroupPresenceSession(
    input: CanConnectGroupPresenceSessionInput
): GroupPolicyResult {
    const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
    if (lifecycleDenial) {
        return lifecycleDenial;
    }
    const principalId = input.actor.principalId;
    if (!principalId) {
        return denyGroupPolicy(
            'member-not-active',
            'An active group member is required for presence.'
        );
    }
    const memberDenial = denyUnlessActiveGroupMember(
        findGroupMember(input.snapshot, principalId)
    );
    if (memberDenial) {
        return memberDenial;
    }
    const cap = input.snapshot.group.maxSessionsPerMember;
    if (cap !== null) {
        const liveSessions = input.snapshot.activeSessions.filter(
            (session) =>
                session.principalId === principalId &&
                isLiveGroupPresenceSession(session, input.nowEpochMs)
        );
        const alreadyConnected = liveSessions.some(
            (session) => session.sessionId === input.sessionId
        );
        if (!alreadyConnected && liveSessions.length >= cap) {
            return denyGroupPolicy(
                'member-session-limit-reached',
                'Group member session capacity has been reached.'
            );
        }
    }
    return GROUP_POLICY_ALLOWED;
}

export function canChangeOwnGroupMembership(
    storedMember: GroupMember | undefined
): GroupPolicyResult {
    return denyForBlockedGroupMember(storedMember) ?? GROUP_POLICY_ALLOWED;
}

export function canActivateGroupMember(
    input: CanActivateGroupMemberInput
): GroupPolicyResult {
    const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
    if (lifecycleDenial) {
        return lifecycleDenial;
    }
    const member = findGroupMember(input.snapshot, input.targetPrincipalId);
    return wouldExceedMemberCap(input.snapshot, member, input.capacity)
        ? denyGroupPolicy('group-full', 'Group member capacity has been reached.')
        : GROUP_POLICY_ALLOWED;
}

export function canDecideGroupAdmission(
    input: CanDecideGroupAdmissionInput
): GroupPolicyResult {
    const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
    if (lifecycleDenial) {
        return lifecycleDenial;
    }
    const blocked = denyUnlessActiveGroupMember(
        findActorGroupMember(input.snapshot, input.actor)
    );
    if (blocked) {
        return blocked;
    }
    return denyUnlessGroupLifecycleManager(
        input,
        'Only a group manager can decide admissions.'
    ) ?? GROUP_POLICY_ALLOWED;
}

function canUseInvite(
    input: CanJoinGroupInput,
    member: GroupMember | undefined
): GroupPolicyResult {
    if (member?.status === 'active') {
        return GROUP_POLICY_ALLOWED;
    }
    if (
        input.inviteToken &&
        input.expectedInviteToken !== undefined &&
        input.inviteToken === input.expectedInviteToken
    ) {
        return GROUP_POLICY_ALLOWED;
    }
    if (member?.status !== 'invited') {
        return denyGroupPolicy('group-invite-required', 'A valid invite is required to join.');
    }
    if (
        member.invitationExpiresAtEpochMs !== null &&
        input.nowEpochMs !== undefined &&
        member.invitationExpiresAtEpochMs <= input.nowEpochMs
    ) {
        return denyGroupPolicy('group-invite-expired', 'Group invite has expired.');
    }
    return GROUP_POLICY_ALLOWED;
}

function canUseJoinCode(input: CanJoinGroupInput): GroupPolicyResult {
    if (!input.joinCode) {
        return denyGroupPolicy('group-code-required', 'A join code is required to join.');
    }
    if (
        input.joinCodeExpiresAtEpochMs !== undefined &&
        input.nowEpochMs !== undefined &&
        input.joinCodeExpiresAtEpochMs <= input.nowEpochMs
    ) {
        return denyGroupPolicy('group-code-invalid', 'Join code is invalid.');
    }
    if (input.expectedJoinCode !== undefined && input.joinCode !== input.expectedJoinCode) {
        return denyGroupPolicy('group-code-invalid', 'Join code is invalid.');
    }
    if (
        input.expectedJoinCodeVerifier !== undefined &&
        input.joinCodeVerifier !== input.expectedJoinCodeVerifier
    ) {
        return denyGroupPolicy('group-code-invalid', 'Join code is invalid.');
    }
    return GROUP_POLICY_ALLOWED;
}

function wouldExceedMemberCap(
    snapshot: GroupSnapshot,
    member: GroupMember | undefined,
    capacity: GroupPolicyCapacityConfig | undefined
): boolean {
    const cap = snapshot.group.maxMembers ?? capacity?.defaultMaxMembers ?? null;
    return cap !== null &&
        member?.status !== 'active' &&
        snapshot.group.activeMemberCount >= cap;
}
