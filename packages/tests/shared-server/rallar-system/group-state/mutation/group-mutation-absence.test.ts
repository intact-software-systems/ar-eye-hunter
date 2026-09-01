import { describe, expect, it } from 'vitest';

import type { GroupMutationCommand, GroupMutationRead } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { assertGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/assert-group-mutation.ts';
import { groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';

import { createGroupAuthorityFacts, createGroupAuthorityRead, groupRef, storedEntry } from './group-mutation-test-runtime.ts';

const ACTOR = {
    actorPrincipalId: 'alice',
    actorSessionId: 'alice-session',
    reason: null,
    traceId: null
};

describe('group mutation absence', () => {
    it.each(['updateGroup', 'planGroupLayout', 'disconnectPresence'] as const)(
        'returns a typed missing-group denial for %s without mutation effects',
        (operation) => {
            const command = createMissingGroupCommand(operation);
            const read = createMissingGroupRead(operation);
            const facts = createGroupAuthorityFacts();

            const computed = computeGroupMutation({ command, read, facts });

            expect(computed).toEqual({
                outcome: 'rejected',
                rejectionCode: 'group-mutation-rejected',
                receipt: {
                    commandId: 'missing-group',
                    requestId: 'missing-group',
                    commandHash: facts.commandHash,
                    aggregateRef: groupRef('pure-room'),
                    outcome: 'rejected',
                    attemptCount: 1,
                    acceptedStorageRevision: null,
                    snapshotVersion: 0,
                    causalRevision: { groupRevision: 0, presenceRevision: 0 },
                    eventId: null,
                    outboxIds: [],
                    joinCode: null,
                    joinCodeExpiresAtEpochMs: null,
                    rejection: 'Group not found: pure-room'
                }
            });
            expect(() => assertGroupMutation({ command, read, facts, computed })).not.toThrow();
        }
    );

    it('permits creation without a group and replays its receipt after the group disappears', () => {
        const command = createNewGroupCommand();
        const read = createMissingGroupRead(command.operation);
        const facts = createGroupAuthorityFacts();
        const created = computeGroupMutation({ command, read, facts });
        expect(created.outcome).toBe('write');
        if (created.outcome !== 'write' || created.idempotency === null) {
            throw new Error('Expected group creation with immutable receipt');
        }
        const replayRead: GroupMutationRead = {
            ...read,
            idempotency: storedEntry(
                groupStateIdempotencyStorageKey(command.aggregateRef, 'create-absent'),
                created.idempotency
            )
        };
        const replay = computeGroupMutation({ command, read: replayRead, facts });
        expect(replay).toEqual({ outcome: 'replay', rejectionCode: null, receipt: created.receipt });
    });
});

function createNewGroupCommand(): GroupMutationCommand {
    return {
        operation: 'createGroup',
        aggregateRef: groupRef('pure-room'),
        commandId: 'create-absent',
        requestId: 'create-absent',
        input: {
            ...ACTOR,
            slug: null,
            displayName: 'Created',
            description: null,
            kind: 'room',
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            createdByPrincipalId: 'alice',
            expiresAtEpochMs: null,
            purgeAfterEpochMs: null
        }
    };
}

function createMissingGroupRead(operation: GroupMutationCommand['operation']): GroupMutationRead {
    const read = createGroupAuthorityRead({}, { actorIsMember: false });
    return {
        ...read,
        group: null,
        lifecyclePolicy: operation === 'planGroupLayout' ? { status: 'absent' } : null,
        activeMemberPrincipalIds: operation === 'planGroupLayout' ? [] : null
    };
}

function createMissingGroupCommand(
    operation: 'updateGroup' | 'planGroupLayout' | 'disconnectPresence'
): GroupMutationCommand {
    const identity = {
        aggregateRef: groupRef('pure-room'),
        commandId: 'missing-group',
        requestId: 'missing-group'
    };
    if (operation === 'planGroupLayout') {
        return { ...identity, operation, input: { ...ACTOR, expectedFormationEpoch: null } };
    }
    if (operation === 'disconnectPresence') {
        return {
            ...identity,
            operation,
            sessionId: 'alice-session',
            input: {
                ...ACTOR,
                principalId: 'alice',
                generationId: 'generation-1',
                generationVersion: null,
                observedExpiresAtEpochMs: null,
                disconnectedAtEpochMs: null,
                lastHeartbeatAtEpochMs: null,
                expiresAtEpochMs: null
            }
        };
    }
    return {
        ...identity,
        operation,
        input: {
            ...ACTOR,
            slug: null,
            displayName: 'Updated',
            description: null,
            kind: null,
            status: null,
            joinMode: null,
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: null,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null
        }
    };
}
