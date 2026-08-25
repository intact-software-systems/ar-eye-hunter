import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { isPresenceTimestampWithinSkew } from '../../../presence/presence-lease.ts';
import { assertActive, isExactlyAdmitted } from '../aggregate/group-aggregate-mutation-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { noOp, requireGroup } from '../group-mutation-result.ts';
import { computeGroupPresenceWrite } from './compute-group-presence-write.ts';
import { validateGroupPresenceMutationAuthority } from './validate-group-presence-mutation-authority.ts';

export function computeHeartbeatGroupPresence(
    command: Extract<GroupMutationCommand, { operation: 'heartbeatPresence'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const group = requireGroup(read, command.aggregateRef);
    assertActive(group.value, facts.nowEpochMs);
    const existing = read.targetPresence;
    if (!existing) {
        throw new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`);
    }
    validateGroupPresenceMutationAuthority(command, existing.value.principalId, facts);
    if (
        existing.value.generationId !== command.input.generationId ||
        existing.value.disconnectedAtEpochMs !== null
    ) {
        return noOp(command, read, facts);
    }
    if (!isExactlyAdmitted(read.targetAdmission?.value, existing.value)) {
        return noOp(command, read, facts);
    }
    const member = read.targetMember ?? undefined;
    if (!member || member.status !== 'active') {
        return noOp(command, read, facts);
    }
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (!isPresenceTimestampWithinSkew(heartbeatAt, facts.nowEpochMs)) {
        throw new GroupMutationRejectedError(
            'Group presence lastHeartbeatAtEpochMs is too far in the future.'
        );
    }
    if (heartbeatAt < existing.value.lastHeartbeatAtEpochMs) {
        return noOp(command, read, facts);
    }
    const expiresAt = Math.max(
        existing.value.expiresAtEpochMs,
        command.input.expiresAtEpochMs ?? existing.value.expiresAtEpochMs
    );
    if (expiresAt < heartbeatAt) {
        throw new GroupMutationRejectedError(
            'Presence heartbeat expiry must not predate the heartbeat.'
        );
    }
    const session: GroupPresenceSession = {
        ...existing.value,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: expiresAt
    };
    if (jsonEquals(existing.value, session)) {
        return noOp(command, read, facts);
    }
    return computeGroupPresenceWrite({
        command,
        read,
        facts,
        session,
        operation: 'update',
        eventType: 'session-heartbeat',
        presenceSummaryWork: isPureLeaseRenewalHeartbeat(command, read, facts) ? 'none' : 'enqueue'
    });
}

/**
 * A pure lease renewal keeps the session row, event, and receipt but must not
 * expand a presence summary: the session is already listed by the stored
 * summary and its lease had not lapsed at read time, so no online/offline
 * transition can be observed. Anything not provably pure — including a
 * lapsed-lease revival — expands normally.
 */
export function isPureLeaseRenewalHeartbeat(
    command: Extract<GroupMutationCommand, { operation: 'heartbeatPresence'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): boolean {
    const existing = read.targetPresence;
    return (
        existing !== null &&
        existing.value.expiresAtEpochMs > facts.nowEpochMs &&
        (read.presenceSummary?.value.activeSessionIds ?? []).includes(command.sessionId)
    );
}
