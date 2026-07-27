import { describe, expect, it } from 'vitest';
import { validateGroupMutationIdempotencyRecord } from
    '@shared-server/rallar-system/services/group-state-mutations.ts';

const groupRef = {
    applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1',
};

function idempotencyRecord() {
    const commandHash = `sha256:${'a'.repeat(64)}`;
    return {
        aggregateRef: groupRef,
        requestId: 'request-1',
        commandHash,
        receipt: {
            commandId: 'request-1',
            requestId: 'request-1',
            commandHash,
            aggregateRef: groupRef,
            outcome: 'no-op',
            attemptCount: 1,
            acceptedStorageRevision: 0,
            stateRevision: 1,
            snapshotVersion: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            eventId: null,
            outboxIds: [],
            joinCode: null,
            joinCodeExpiresAtEpochMs: null,
            rejection: null,
        },
    };
}

describe('group mutation receipt causal invariants', () => {
    it('requires receipt snapshotVersion to equal causal groupRevision', () => {
        const valid = idempotencyRecord();
        expect(() => validateGroupMutationIdempotencyRecord(valid, groupRef))
            .not.toThrow();

        expect(() => validateGroupMutationIdempotencyRecord({
            ...valid,
            receipt: { ...valid.receipt, snapshotVersion: 2 },
        }, groupRef)).toThrow(/snapshotVersion.*causalRevision/u);
    });
});
