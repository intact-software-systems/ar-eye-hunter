import { describe, expect, it } from 'vitest';

import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/client-state-validation-primitives.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { validateClientMutationAuthorityPolicy } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts';
import { validateClientMutationRead } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-read.ts';
import { validateClientMutationResult } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-result.ts';
import {
    ClientMutationIdempotencyConflictError,
    validateClientMutation
} from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import {
    ClientMutationIdempotencyConflictError as LegacyConflictError,
    validateClientMutation as legacyValidateClientMutation
} from '@shared-server/rallar-system/services/client-state-mutations.ts';

import { emptyRead, entryValue, principalCommand, readAfterWrite, requireWrite } from './client-mutation-compute-test-fixtures.ts';

describe('client mutation result validation', () => {
    it('accepts a complete computed result through each named validation owner', async () => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));

        expect(() => validateClientMutationRead(command, read)).not.toThrow();
        expect(() => validateClientMutationAuthorityPolicy(command, read)).not.toThrow();
        expect(() => validateClientMutationResult(computed)).not.toThrow();
        expect(() => validateClientMutation({ command, read, computed })).not.toThrow();
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

        expect(() => validateClientMutationResult(malformed)).toThrowError(
            new ClientMutationRejectedError(
                'Client mutation computed.receipt.commandHash must be a canonical SHA-256 digest'
            )
        );
    });

    it('throws the canonical conflict error after validating a conflict result', async () => {
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

        expect(() => validateClientMutation({ command: conflicting, read, computed })).toThrow(
            ClientMutationIdempotencyConflictError
        );
        expect(LegacyConflictError).toBe(ClientMutationIdempotencyConflictError);
        expect(legacyValidateClientMutation).toBe(validateClientMutation);
    });
});
