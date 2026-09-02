import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';

import { isPresenceTimestampWithinSkew } from '../../../presence/presence-lease.ts';
import type { GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { isExactlyAdmitted, validateActiveGroup } from '../aggregate/group-aggregate-mutation-policy.ts';
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
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    const group = requireGroup(read, command.aggregateRef);
    const issues = [...validateActiveGroup(group.value, facts.nowEpochMs)];
    const existing = read.targetPresence;
    if (!existing) {
        issues.push({
            path: 'read.targetPresence',
            cause: new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`)
        });
        return Either.ofLeft(issues);
    }
    issues.push(...validateGroupPresenceMutationAuthority(command, existing.value.principalId, facts));
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    if (
        existing.value.generationId !== command.input.generationId ||
        existing.value.disconnectedAtEpochMs !== null
    ) {
        return Either.ofRight(noOp(command, read, facts));
    }
    if (!isExactlyAdmitted(read.targetAdmission?.value, existing.value)) {
        return Either.ofRight(noOp(command, read, facts));
    }
    const member = read.targetMember ?? undefined;
    if (!member || member.status !== 'active') {
        return Either.ofRight(noOp(command, read, facts));
    }
    const projection = computeHeartbeatSession(command, existing.value, facts);
    if (projection.left !== undefined) {
        return Either.ofLeft(projection.left);
    }
    const session = projection.right!;
    if (session === null) {
        return Either.ofRight(noOp(command, read, facts));
    }
    return Either.ofRight(computeGroupPresenceWrite({
        command,
        read,
        facts,
        session,
        operation: 'update',
        eventType: 'session-heartbeat',
        presenceSummaryWork: isPureLeaseRenewalHeartbeat(command, read, facts) ? 'none' : 'enqueue'
    }));
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

function computeHeartbeatSession(
    command: Extract<GroupMutationCommand, { operation: 'heartbeatPresence'; }>,
    existing: GroupPresenceSession,
    facts: GroupMutationFacts
): Either<readonly GroupStateValidationIssue[], GroupPresenceSession | null> {
    const issues: GroupStateValidationIssue[] = [];
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (!isPresenceTimestampWithinSkew(heartbeatAt, facts.nowEpochMs)) {
        issues.push({
            path: 'command.input.lastHeartbeatAtEpochMs',
            cause: new GroupMutationRejectedError(
                'Group presence lastHeartbeatAtEpochMs is too far in the future.'
            )
        });
    }
    if (heartbeatAt < existing.lastHeartbeatAtEpochMs) {
        return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(null);
    }
    const expiresAt = Math.max(
        existing.expiresAtEpochMs,
        command.input.expiresAtEpochMs ?? existing.expiresAtEpochMs
    );
    if (expiresAt < heartbeatAt) {
        issues.push({
            path: 'read.targetPresence.expiresAtEpochMs',
            cause: new GroupMutationRejectedError(
                'Presence heartbeat expiry must not predate the heartbeat.'
            )
        });
    }
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const session: GroupPresenceSession = {
        ...existing,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: expiresAt
    };
    if (jsonEquals(existing, session)) {
        return Either.ofRight(null);
    }
    return Either.ofRight(session);
}
