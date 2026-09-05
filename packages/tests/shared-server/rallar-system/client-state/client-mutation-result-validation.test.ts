import { describe, expect, it } from 'vitest';

import { computeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { assertClientMutationResult } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation-result.ts';
import { validateClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import { computeClientStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';

import { emptyRead, entryValue, principalCommand, readAfterWrite, requireWrite } from './client-mutation-compute-test-fixtures.ts';

describe('client mutation result validation', () => {
    it('accepts the canonical computed result', async () => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));

        expect(validateClientMutation({ command, read, computed })).toEqual([]);
    });

    it('rejects an accessor-backed computed result without invoking the accessor', async () => {
        const command = await principalCommand('accessor-backed-computed');
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));
        let accessorRead = false;
        const accessorBacked = Object.defineProperty({ ...computed }, 'snapshot', {
            get: () => {
                accessorRead = true;
                return computed.snapshot;
            }
        });

        expect(() => validateClientMutation({ command, read, computed: accessorBacked })).toThrow(
            'Client mutation computed.snapshot must be a data property'
        );
        expect(accessorRead).toBe(false);
    });

    it('preserves structural result validation order and exact error details', async () => {
        const command = await principalCommand();
        const computed = requireWrite(
            computeClientMutation({
                command,
                read: emptyRead(command)
            })
        );
        const malformed = {
            ...structuredClone(computed),
            receipt: { ...computed.receipt, commandHash: 'not-a-hash' }
        };

        expect(() => assertClientMutationResult(malformed)).toThrowError(
            new ClientMutationRejectedError(
                'Client mutation computed.receipt.commandHash must be a canonical SHA-256 digest'
            )
        );
    });

    it('accepts a canonical idempotency conflict as validated data', async () => {
        const command = await principalCommand();
        const applied = requireWrite(computeClientMutation({ command, read: emptyRead(command) }));
        if (!applied.idempotency) {
            throw new Error('Expected idempotency record');
        }
        const conflicting = {
            ...command,
            facts: { ...command.facts, commandHash: `sha256:${'e'.repeat(64)}` }
        };
        const read = {
            ...readAfterWrite(conflicting, applied),
            idempotency: entryValue(applied.idempotency, 1)
        };
        const computed = computeClientMutation({ command: conflicting, read });

        expect(validateClientMutation({ command: conflicting, read, computed })).toEqual([]);
    });

    it('rejects self-consistent state sync and outbox values that differ from canonical computation', async () => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));
        const shiftedStateSync = computed.stateSync.map((stateSync) => ({
            ...stateSync,
            createdAtEpochMs: stateSync.createdAtEpochMs + 1
        }));
        const selfConsistentButNoncanonical = {
            ...computed,
            stateSync: shiftedStateSync,
            outboxWrites: shiftedStateSync
                .flatMap((stateSync) => computeClientStateSyncEntries(stateSync, command.facts.serviceId))
                .map(computeAppOutboxInsert)
        };

        expect(() =>
            validateClientMutation({
                command,
                read,
                computed: selfConsistentButNoncanonical
            })
        ).toThrowError(
            new ClientMutationRejectedError(
                'Client mutation computed.stateSync.0.createdAtEpochMs differs from the computed value'
            )
        );
    });
});
