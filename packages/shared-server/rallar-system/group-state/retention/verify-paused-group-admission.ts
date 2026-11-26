import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { GroupStateMutationCommand } from '../group-state-service-contracts.ts';
import { isExactlyAdmitted } from '../mutation/aggregate/group-aggregate-mutation-policy.ts';
import { GroupMutationRejectedError, type GroupMutationRead } from '../mutation/group-mutation-contracts.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import { computeEmptyGroupLifetime, readArrivalRetention } from './compute-empty-group-lifetime.ts';

export async function verifyPausedGroupAdmission(
    repository: GroupStateRepository, ingress: GroupStateMutationCommand, read: GroupMutationRead
): Promise<void> {
    const operation = ingress.command.operation;
    if (operation !== 'connectPresence' && operation !== 'heartbeatPresence' &&
        operation !== 'joinGroup' && operation !== 'acceptGroupInvite') return;
    if (!read.group || read.idempotency) return;
    const now = ingress.facts.attemptAtEpochMs;
    const target = read.targetPresence?.value;
    if (target?.status === 'active' && target.expiresAtEpochMs > now && read.targetMember?.status === 'active' &&
        isExactlyAdmitted(read.targetAdmission?.value, target)) return;
    const policy = readArrivalRetention(read.group.value);
    if (!policy) return;
    const authority = await repository.readPresenceSummaryEntries(ingress.command.aggregateRef);
    if (authority.group?.entry.revision !== read.group.entry.revision) {
        throw new RuntimeStateWriteConflictError();
    }
    if (computeEmptyGroupLifetime(authority, policy, now) === 'expired') {
        throw new GroupMutationRejectedError('This room is no longer available.');
    }
}
