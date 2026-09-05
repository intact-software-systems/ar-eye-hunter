import { describe, expect, it } from 'vitest';

import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import { probeTopologyConfigMutationIdempotency } from '@shared-server/rallar-system/topology/config/mutation/probe-topology-config-mutation-idempotency.ts';
import { validateTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts';
import { createDefaultTopologyConfigMutationTestInput } from './group-topology-config-mutation-test-fixtures.ts';

describe('topology config mutation idempotency', () => {
    it('returns a durable replay for the same command hash', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput();
        const accepted = computeTopologyConfigMutation(mutation);
        if (accepted.outcome !== 'write' || accepted.idempotency === null) {
            throw new Error('Expected an idempotent topology config write');
        }
        const read = {
            ...mutation.read,
            idempotency: runtimeEntry(accepted.idempotency)
        };
        const replay = probeTopologyConfigMutationIdempotency(
            mutation.command,
            read,
            mutation.command.commandHash
        );

        expect(replay).toMatchObject({ outcome: 'replay', receipt: accepted.receipt });
        if (replay.outcome !== 'replay') {
            throw new Error('Expected topology config replay');
        }
        expect(validateTopologyConfigMutation({ ...mutation, read, computed: replay })).toEqual([]);
    });

    it('returns a typed conflict for divergent same-request semantics', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput();
        const accepted = computeTopologyConfigMutation(mutation);
        if (accepted.outcome !== 'write' || accepted.idempotency === null) {
            throw new Error('Expected an idempotent topology config write');
        }
        const conflict = probeTopologyConfigMutationIdempotency(
            mutation.command,
            { ...mutation.read, idempotency: runtimeEntry(accepted.idempotency) },
            `sha256:${'d'.repeat(64)}`
        );

        expect(conflict).toEqual({
            outcome: 'idempotency-conflict',
            existingCommandHash: mutation.command.commandHash,
            receivedCommandHash: `sha256:${'d'.repeat(64)}`
        });
    });

    it('rejects compact replay receipt operation corruption against the verified command', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput({
            durableDegreeLimit: 5,
            overrideDegreeLimit: null
        });
        const accepted = computeTopologyConfigMutation(mutation);
        if (accepted.outcome !== 'write') {
            throw new Error('Expected topology config write');
        }
        if (mutation.command.requestId === null) {
            throw new Error('Expected topology config request id');
        }
        const corruptRecord = {
            groupRef: mutation.command.aggregateRef,
            requestId: mutation.command.requestId,
            commandHash: mutation.command.commandHash,
            receipt: {
                ...accepted.receipt,
                operation: 'putOverride' as const,
                target: 'override' as const,
                acceptedExpiresAtEpochMs: accepted.receipt.acceptedUpdatedAtEpochMs! + 1
            }
        };
        const read = { ...mutation.read, idempotency: runtimeEntry(corruptRecord) };

        const replay = probeTopologyConfigMutationIdempotency(
            mutation.command,
            read,
            mutation.command.commandHash
        );
        if (replay.outcome === 'miss') {
            throw new Error('Expected topology config replay');
        }
        expect(validateTopologyConfigMutation({ ...mutation, read, computed: replay })).toEqual([
            expect.objectContaining({ code: 'idempotency-operation-mismatch' })
        ]);
    });
});

function runtimeEntry<T>(value: T) {
    return {
        key: 'idempotency',
        value,
        entry: {
            key: 'idempotency',
            value: JSON.stringify(value),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: new Date(0).toISOString(),
            revision: 0
        }
    };
}
