import type { GroupPresenceSession } from '@shared/api/group-types.ts';

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
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const existing = read.targetPresence;
    if (!existing) {
        if (facts.internalAuthority === 'expiry') {
            return noOp(command, read, facts);
        }
        throw new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`);
    }
    validateGroupPresenceMutationAuthority(command, existing.value.principalId, facts);
    if (
        existing.value.generationId !== command.input.generationId ||
        (command.input.generationVersion !== null &&
            existing.value.generationVersion !== command.input.generationVersion) ||
        (command.input.observedExpiresAtEpochMs !== null &&
            existing.value.expiresAtEpochMs !== command.input.observedExpiresAtEpochMs) ||
        existing.value.disconnectedAtEpochMs !== null
    ) {
        return noOp(command, read, facts);
    }
    const disconnectedAt = command.input.disconnectedAtEpochMs ?? facts.nowEpochMs;
    if (disconnectedAt < existing.value.lastHeartbeatAtEpochMs) {
        return noOp(command, read, facts);
    }
    if (facts.internalAuthority === 'expiry') {
        return computeGroupPresenceWrite({
            command,
            read,
            facts,
            session: existing.value,
            operation: 'delete',
            eventType: 'session-disconnected',
            presenceAdmission: computeDisconnectPresenceAdmission({
                read,
                session: existing.value,
                facts
            })
        });
    }
    const session: GroupPresenceSession = {
        ...existing.value,
        status: 'disconnected',
        disconnectedAtEpochMs: disconnectedAt,
        disconnectReason: command.input.reason ?? 'closed'
    };
    return computeGroupPresenceWrite({
        command,
        read,
        facts,
        session,
        operation: 'update',
        eventType: 'session-disconnected',
        presenceAdmission: computeDisconnectPresenceAdmission({
            read,
            session: existing.value,
            facts
        })
    });
}
