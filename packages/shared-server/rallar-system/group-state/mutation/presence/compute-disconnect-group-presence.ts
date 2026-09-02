import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { noOp, requireGroup } from '../group-mutation-result.ts';
import { computeDisconnectPresenceAdmission } from './compute-group-presence-admission.ts';
import { computeGroupPresenceWrite } from './compute-group-presence-write.ts';
import { validateGroupPresenceMutationAuthority } from './validate-group-presence-mutation-authority.ts';

export function computeDisconnectGroupPresence(
    command: Extract<GroupMutationCommand, { operation: 'disconnectPresence'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    requireGroup(read, command.aggregateRef);
    const existing = read.targetPresence;
    if (!existing) {
        if (facts.internalAuthority === 'expiry') {
            return Either.ofRight(noOp(command, read, facts));
        }
        return Either.ofLeft([{
            path: 'read.targetPresence',
            cause: new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`)
        }]);
    }
    const issues = validateGroupPresenceMutationAuthority(command, existing.value.principalId, facts);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    if (
        existing.value.generationId !== command.input.generationId ||
        (command.input.generationVersion !== null &&
            existing.value.generationVersion !== command.input.generationVersion) ||
        (command.input.observedExpiresAtEpochMs !== null &&
            existing.value.expiresAtEpochMs !== command.input.observedExpiresAtEpochMs) ||
        existing.value.disconnectedAtEpochMs !== null
    ) {
        return Either.ofRight(noOp(command, read, facts));
    }
    const disconnectedAt = command.input.disconnectedAtEpochMs ?? facts.nowEpochMs;
    if (disconnectedAt < existing.value.lastHeartbeatAtEpochMs) {
        return Either.ofRight(noOp(command, read, facts));
    }
    const admission = computeDisconnectPresenceAdmission({ read, session: existing.value, facts });
    if (admission.left !== undefined) {
        return Either.ofLeft(admission.left);
    }
    const isExpiry = facts.internalAuthority === 'expiry';
    const session: GroupPresenceSession = isExpiry ? existing.value : {
        ...existing.value,
        status: 'disconnected',
        disconnectedAtEpochMs: disconnectedAt,
        disconnectReason: command.input.reason ?? 'closed'
    };
    return Either.ofRight(computeGroupPresenceWrite({
        command,
        read,
        facts,
        session,
        operation: isExpiry ? 'delete' : 'update',
        eventType: 'session-disconnected',
        presenceAdmission: admission.right!
    }));
}
