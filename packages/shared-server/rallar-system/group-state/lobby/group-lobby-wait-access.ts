import { computeGroupAdmissionDecision } from '@shared/api/group-lifecycle/compute-group-admission-decision.ts';
import { isGroupSpectator } from '@shared/api/group-spectating.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { assertAllowed, toPolicySnapshot } from '../mutation/aggregate/group-aggregate-mutation-policy.ts';
import type { GroupMutationWriteInput } from '../mutation/group-mutation-result.ts';
import { resolveAdmittedMemberStatus } from '../mutation/membership/compute-group-admission-mutation.ts';
import { readJoinCode } from '../policy/group-join-code.ts';
import { canJoinGroup } from '../policy/group-membership-admission-policy.ts';
import { denyGroupPolicy, GroupPolicyDeniedError } from '../policy/group-policy-result.ts';
import type { GroupLobbyRead } from './group-lobby-storage.ts';

/** Membership and the queue use the same admission policy. Time-limited credentials also bound future offers. */
export function computeWaitRegistration(
    input: GroupMutationWriteInput,
    principalId: string,
    joinCode: string | undefined
): RoomLobby.Command {
    const { read, facts } = input;
    const group = read.group?.value;
    const policy = read.lifecyclePolicy;
    if (!group || policy?.status !== 'present') {
        throw new TypeError('A queue requires the room and its admission policy');
    }
    const storedCode = readJoinCode(group.metadata);
    assertAllowed(canJoinGroup({
        snapshot: toPolicySnapshot(read, group, facts.attemptAtEpochMs),
        actor: { principalId },
        participation: 'player',
        nowEpochMs: facts.attemptAtEpochMs,
        joinCode,
        joinCodeVerifier: facts.joinCodeVerifier ?? undefined,
        expectedJoinCodeVerifier: group.joinMode === 'code' ? storedCode?.verifier ?? '' : undefined,
        joinCodeExpiresAtEpochMs: storedCode?.expiresAtEpochMs,
        sessionReservations: read.sessionReservations?.value
    }));
    const member = read.actorMember ?? undefined;
    if (member?.status === 'active' && member.role !== 'spectator') {
        return { kind: 'wait', principalId, eligibleUntilEpochMs: null };
    }
    if (resolveAdmittedMemberStatus({ read, facts, existing: member }) !== 'active') {
        throw new GroupPolicyDeniedError(
            denyGroupPolicy('group-admission-closed', 'Admission approval is required before waiting for a place.')
        );
    }
    const deadlines = [
        policy.policy.admission.untilEpochMs,
        group.joinMode === 'code' ? storedCode?.expiresAtEpochMs : null,
        (group.joinMode === 'invite-only' || policy.policy.admission.mode === 'manager-approval') &&
            member?.status === 'invited'
            ? member.invitationExpiresAtEpochMs
            : null
    ].filter((value): value is number => value != null);
    return { kind: 'wait', principalId, eligibleUntilEpochMs: deadlines.length ? Math.min(...deadlines) : null };
}

interface LobbyAccessChange {
    readonly input: GroupMutationWriteInput;
    readonly next: Group;
    readonly state: GroupLobbyRead;
    readonly lobby: RoomLobby;
}

/** Losing an admission credential withdraws a waiting or offered place before a replacement may be allocated. */
export function revokedLobbyCandidates({ input, next, state, lobby }: LobbyAccessChange): readonly RoomLobby.Command[] {
    const previous = input.read.group?.value;
    if (!previous) {
        return [];
    }
    const oldCode = readJoinCode(previous.metadata);
    const nextCode = readJoinCode(next.metadata);
    const codeChanged = next.joinMode === 'code' &&
        (previous.joinMode !== 'code' || oldCode?.verifier !== nextCode?.verifier);
    const codeLimit =
        next.joinMode === 'code' && nextCode && oldCode && nextCode.expiresAtEpochMs < oldCode.expiresAtEpochMs
            ? nextCode.expiresAtEpochMs
            : null;
    const invitationRequired = next.joinMode === 'invite-only' && previous.joinMode !== 'invite-only';
    const policy = input.read.lifecyclePolicy;
    const admission = policy?.status === 'present' ? policy.policy.admission : null;
    const policyChanged = admission &&
        (next.lifecycleState !== previous.lifecycleState ||
            next.activeMemberCount !== previous.activeMemberCount && admission.untilMemberCount !== null);
    if (!codeChanged && codeLimit === null && !invitationRequired && !policyChanged) {
        return [];
    }
    const candidates = new Set([
        ...lobby.waiters.map((waiter) => waiter.principalId),
        ...lobby.seats.filter((seat) => seat.offerWindow).map((seat) => seat.principalId)
    ]);
    const members = new Map(
        [...state.candidateMembers, ...input.members].map((member) => [member.principalId, member])
    );
    const activeMembers = new Map((input.read.activeMembers ?? []).map((member) => [member.principalId, member]));
    for (const member of input.members) {
        activeMembers.set(member.principalId, member);
    }
    const playerCount = next.activeMemberCount - [...activeMembers.values()].filter(isGroupSpectator).length;
    const now = input.facts.attemptAtEpochMs;
    const changes: RoomLobby.Command[] = [];
    for (const principalId of candidates) {
        const member = members.get(principalId);
        if (member?.status === 'active' && member.role !== 'spectator') {
            continue;
        }
        const invited = member?.status === 'invited' &&
            (member.invitationExpiresAtEpochMs === null || member.invitationExpiresAtEpochMs > now);
        const decision = policyChanged
            ? computeGroupAdmissionDecision({
                admission,
                lifecycleState: next.lifecycleState,
                activeMemberCount: playerCount,
                invited,
                nowEpochMs: now
            })
            : null;
        if (codeChanged || invitationRequired && !invited || decision && decision.kind !== 'admit') {
            changes.push({ kind: 'release', principalId });
        }
        else if (invitationRequired && member?.invitationExpiresAtEpochMs != null) {
            changes.push({ kind: 'limit', principalId, eligibleUntilEpochMs: member.invitationExpiresAtEpochMs });
        }
        else if (codeLimit !== null) {
            changes.push({ kind: 'limit', principalId, eligibleUntilEpochMs: codeLimit });
        }
    }
    return changes;
}
