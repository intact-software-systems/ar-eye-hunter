import type { GroupEventType, GroupPresenceSession } from '@shared/api/group-types.ts';

import { toExpiredAwareInsertCandidate } from '../../presence/group-expired-state-authority.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead,
    PresenceAdmissionCandidate,
    PresenceGuardCandidate
} from '../group-mutation-contracts.ts';
import { computeGroupMutationWriteResult, requireGroup } from '../group-mutation-result.ts';

interface ComputeGroupPresenceWriteInput {
    readonly command: Extract<GroupMutationCommand, {
        operation: 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence';
    }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly session: GroupPresenceSession;
    readonly operation: 'insert' | 'update' | 'delete';
    readonly eventType: GroupEventType;
    readonly presenceAdmission?: PresenceAdmissionCandidate | null;
    readonly presenceSummaryWork?: 'enqueue' | 'none';
}

export function computeGroupPresenceWrite({
    command,
    read,
    facts,
    session,
    operation,
    eventType,
    presenceAdmission = null,
    presenceSummaryWork = 'enqueue'
}: ComputeGroupPresenceWriteInput): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    let guard: PresenceGuardCandidate;
    if (operation === 'insert') {
        guard = {
            kind: 'presence',
            ...toExpiredAwareInsertCandidate(read.expiredTargetPresenceEntry, session)
        };
    }
    else {
        const predecessor = read.targetPresence;
        if (predecessor === null) {
            throw new TypeError('Group presence write is missing its predecessor');
        }
        guard = operation === 'update'
            ? {
                kind: 'presence',
                operation: 'update',
                value: session,
                expectedRevision: predecessor.entry.revision
            }
            : {
                kind: 'presence',
                operation: 'delete',
                value: session,
                expectedRevision: predecessor.entry.revision
            };
    }
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard,
        members: [],
        initialPresenceSummary: null,
        eventType,
        eventGroup: stored.value,
        presenceAdmission,
        presenceSummaryWork
    });
}
