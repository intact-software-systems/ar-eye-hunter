import { validateClientMutationReceipt } from '@shared-server/rallar-system/client-state/client-mutation-receipt-validation.ts';
import type { ClientMutationReceipt } from '@shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import { describe, expect, it } from 'vitest';

describe('client mutation receipt outbox identities', () => {
    it.each([2, 3, 600])('accepts %i immutable event and snapshot carrier identities', (count) => {
        const receipt = createReceipt({
            outboxIds: Array.from({ length: count }, (_, index) => `durable-outbox-${index}`)
        });
        expect(() => validateClientMutationReceipt(receipt, 'receipt')).not.toThrow();
        expect(receipt.outboxIds).toHaveLength(count);
    });

    it.each([
        { outboxIds: [] },
        { outboxIds: ['only-event'] },
        { outboxIds: ['event', 'snapshot', 'snapshot'] },
        { outboxIds: ['event', 'snapshot', ''] }
    ])('rejects incomplete or non-unique applied identities $outboxIds', ({ outboxIds }) => {
        expect(() => validateClientMutationReceipt(createReceipt({ outboxIds }), 'receipt'))
            .toThrow(ClientMutationRejectedError);
    });

    it('accepts an immutable no-op with no event or durable delivery', () => {
        const receipt = createReceipt({ outcome: 'no-op', eventId: null, outboxIds: [] });
        expect(() => validateClientMutationReceipt(receipt, 'receipt')).not.toThrow();
    });

    it.each(
        [
            { outcome: 'no-op', eventId: null, outboxIds: ['unexpected'] },
            { outcome: 'no-op', eventId: 'unexpected', outboxIds: [] },
            { outcome: 'applied', eventId: null, outboxIds: ['event', 'snapshot'] }
        ] as const
    )('rejects event and outbox identities inconsistent with $outcome', (changes) => {
        expect(() => validateClientMutationReceipt(createReceipt(changes), 'receipt'))
            .toThrow(ClientMutationRejectedError);
    });
});

function createReceipt(changes: Partial<ClientMutationReceipt>): ClientMutationReceipt {
    return Object.freeze({
        commandId: 'command',
        requestId: 'command',
        commandHash: `sha256:${'a'.repeat(64)}`,
        aggregateRef: Object.freeze({ applicationId: 'app', workspaceId: 'workspace', principalId: 'alice' }),
        outcome: 'applied',
        attemptCount: 1,
        acceptedStorageRevision: 0,
        stateRevision: 1,
        snapshotVersion: 1,
        presenceVersion: 1,
        eventId: 'event',
        ...changes,
        outboxIds: Object.freeze([...(changes.outboxIds ?? ['event-outbox', 'snapshot-outbox'])])
    });
}
