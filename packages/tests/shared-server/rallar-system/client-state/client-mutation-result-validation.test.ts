import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    AppInboxType,
    type AppInboxExecutionMetadata
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    assertClientMutationOperation,
    assertExpiredSessionsOperation,
    computeClientMutationOperation,
    computeExpiredSessionsOperation
} from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-computation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { computeResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { computeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { assertClientMutationResult } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation-result.ts';
import {
    assertClientMutation,
    assertClientMutationComparison
} from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation.ts';
import { validateClientMutationAuthorityPolicy } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import { computeClientStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';

import {
    connectCommand,
    emptyRead,
    entryValue,
    expiryCommand,
    principalCommand,
    readAfterWrite,
    requireWrite
} from './client-mutation-compute-test-fixtures.ts';

describe('client mutation result validation', () => {
    it('keeps missing authority as policy issues after asserting a canonical result', async () => {
        const command = await principalCommand();
        const read = { ...emptyRead(command), authoritySession: null };
        const computed = computeClientMutation({ command, read });

        expect(() => assertClientMutation({ command, read, computed })).not.toThrow();
        expect(validateClientMutationAuthorityPolicy(command, read).map(({ path }) => path))
            .toEqual(['read.authoritySession']);
    });

    it('returns both actor denials as policy issues rather than invariant exceptions', async () => {
        const original = await connectCommand();
        if (original.operation !== 'connectSession') {
            throw new Error('Expected a connect command');
        }
        const command = {
            ...original,
            input: { ...original.input, actorPrincipalId: 'other-principal', actorSessionId: 'other-session' }
        };
        const read = emptyRead(command);
        const computed = computeClientMutation({ command, read });

        expect(() => assertClientMutation({ command, read, computed })).not.toThrow();
        expect(validateClientMutationAuthorityPolicy(command, read).map(({ path }) => path))
            .toEqual(['command.input.actorPrincipalId', 'command.input.actorSessionId']);
    });

    it('accepts the canonical computed result', async () => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));

        assertClientMutation({ command, read, computed });
    });

    it('rejects altered outbox values, page membership, and receipt identities', async () => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));
        const [first, ...remaining] = computed.outboxWrites;
        if (!first || remaining.length === 0) {
            throw new Error('Expected snapshot and event outbox writes');
        }
        const variants = [
            { name: 'payload', outboxWrites: [{ ...first, entry: { ...first.entry, resource: 'altered' } }, ...remaining] },
            {
                name: 'physical key',
                outboxWrites: [{ ...first, entry: { ...first.entry, key: { ...first.entry.key, resourceId: 'another-message' } } }, ...remaining]
            },
            { name: 'prepared timestamp', outboxWrites: [{ ...first, createdAt: '2020-01-01 00:00:00' }, ...remaining] },
            { name: 'missing page', outboxWrites: remaining },
            { name: 'duplicate page', outboxWrites: [first, first, ...remaining] },
            { name: 'reordered pages', outboxWrites: [...remaining, first] },
            { name: 'receipt identities', receipt: { ...computed.receipt, outboxIds: ['another-message'] } }
        ];

        for (const { name, ...changes } of variants) {
            expect(() => assertClientMutation({ command, read, computed: { ...computed, ...changes } }), name)
                .toThrowError(ClientMutationRejectedError);
        }
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

        expect(() => assertClientMutation({ command, read, computed: accessorBacked })).toThrow(
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

        assertClientMutation({ command: conflicting, read, computed });
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
            assertClientMutation({
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

describe('client mutation operation validation', () => {
    it('compares a mutation against the owner-computed value and rejects a changed prepared payload', async () => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const expected = requireWrite(computeClientMutation({ command, read }));
        assertClientMutationComparison({ command, read, expected, computed: expected });

        const [first, ...remaining] = expected.outboxWrites;
        if (!first) {
            throw new Error('Expected a state-sync write');
        }
        const computed = {
            ...expected,
            outboxWrites: [{ ...first, entry: { ...first.entry, resource: 'altered' } }, ...remaining]
        };
        expect(() => assertClientMutationComparison({ command, read, expected, computed }))
            .toThrowError(ClientMutationRejectedError);
    });

    it('rejects altered completion, write membership and committed snapshots', async () => {
        const command = await principalCommand();
        const input = {
            command,
            read: emptyRead(command),
            completionFacts: { entry: createExecutionMetadata().entry, completedAtEpochMs: 8_000 },
            lifecycle: undefined
        };
        const computed = computeClientMutationOperation(input);
        if (computed.outcome !== 'completed') {
            throw new Error('Expected a completed operation');
        }
        assertClientMutationOperation({ ...input, computed });
        const variants = [
            { ...computed, completion: { ...computed.completion, encodedResult: 'altered' } },
            { ...computed, writes: [] },
            { ...computed, committedSnapshots: [] }
        ];
        for (const candidate of variants) {
            expect(() => assertClientMutationOperation({ ...input, computed: candidate })).toThrow(TypeError);
        }
    });

    it('rejects an accessor-backed mutation before reading it', async () => {
        const command = await principalCommand();
        const input = {
            command,
            read: emptyRead(command),
            completionFacts: { entry: createExecutionMetadata().entry, completedAtEpochMs: 8_000 },
            lifecycle: undefined
        };
        const computed = computeClientMutationOperation(input);
        let accessorRead = false;
        const candidate = Object.defineProperty({ ...computed }, 'mutation', {
            get: () => {
                accessorRead = true;
                return computed.mutation;
            }
        });
        expect(() => assertClientMutationOperation({ ...input, computed: candidate }))
            .toThrow('Client mutation operation computed.mutation must be a data property');
        expect(accessorRead).toBe(false);
    });

    it('rejects missing or duplicate expired mutations before validating individual reads', async () => {
        const connectedCommand = await connectCommand();
        const connected = requireWrite(computeClientMutation({ command: connectedCommand, read: emptyRead(connectedCommand) }));
        const command = await expiryCommand();
        const context = createExecutionMetadata();
        const input = {
            context,
            pageInput: { atEpochMs: 8_000, afterKey: null },
            page: {
                candidates: [{
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    principalId: 'alice',
                    clientInstanceId: 'browser',
                    sessionId: 'session-1',
                    generationId: 'generation-1',
                    generationVersion: 1,
                    observedExpiresAtEpochMs: 8_000
                }],
                nextAfterKey: null
            },
            reads: [{ command, read: readAfterWrite(command, connected) }],
            completionFacts: { entry: context.entry, completedAtEpochMs: 8_000 }
        };
        const computed = computeExpiredSessionsOperation(input);
        if (computed.outcome !== 'completed') {
            throw new Error('Expected completed expiry');
        }
        assertExpiredSessionsOperation({ ...input, computed });
        for (const mutations of [[], [...computed.mutations, ...computed.mutations]]) {
            expect(() => assertExpiredSessionsOperation({ ...input, computed: { ...computed, mutations } }))
                .toThrow(/Expired client sessions operation computed.mutations/);
        }
    });
});

function createExecutionMetadata(): AppInboxExecutionMetadata {
    const entry: ResourceEntry = {
        key: { topicId: 'app-inbox.client-state', resourceId: 'operation-test', contextId: 'client-state' },
        resource: '{}',
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('00:00:01'),
            createdBy: 'client-service',
            createdTs: Temporal.PlainDateTime.from('1970-01-01T00:00:01'),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1 }
    };
    return {
        enqueue: { type: AppInboxType.CLIENT_EXPIRED_SESSIONS, data: { atEpochMs: 8_000, afterKey: null } },
        message: {
            id: { v: 2, msgId: entry.key.resourceId, ts: 1_000, senderId: 'client-service' },
            route: entry.key,
            payload: { typeId: AppInboxType.CLIENT_EXPIRED_SESSIONS, contentType: 'application/json', resource: '{}' }
        },
        entry,
        attemptTelemetry: computeResourceInboxAttempt({
            entry,
            selectedLane: Reservator.NEW,
            selectedAtEpochMs: 1_000,
            selectedDueAtEpochMs: undefined
        }).telemetry
    };
}
