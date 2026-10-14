import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    AppInboxType,
    type AppInboxExecutionMetadata
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    assertAuthorisedWsConnectOperation,
    assertClientMutationOperation,
    assertExpiredSessionsOperation,
    computeAuthorisedWsConnectOperation,
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
import { assertClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation.ts';
import { validateClientMutationAuthorityPolicy } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import { validateComputedProjection } from '@shared-server/rallar-system/computed-data-validation.ts';
import { computeClientStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

import {
    authorisedConnectOperationInput,
    connectCommand,
    emptyRead,
    entryValue,
    expiryCommand,
    principalCommand,
    readAfterWrite,
    requireWrite
} from './client-mutation-compute-test-fixtures.ts';

vi.mock('@shared-server/rallar-system/computed-data-validation.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('@shared-server/rallar-system/computed-data-validation.ts')>();
    return { ...original, validateComputedProjection: vi.fn(original.validateComputedProjection) };
});

describe('client mutation result validation', () => {
    it('keeps missing authority as policy issues after asserting a canonical result', () => {
        const command = principalCommand();
        const read = { ...emptyRead(command), authoritySession: null };
        const computed = computeClientMutation({ command, read });

        expect(() => assertClientMutation({ command, read, computed })).not.toThrow();
        expect(validateClientMutationAuthorityPolicy(command, read).map(({ path }) => path))
            .toEqual(['read.authoritySession']);
    });

    it('returns both actor denials as policy issues rather than invariant exceptions', () => {
        const original = connectCommand();
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

    it('accepts the canonical computed result', () => {
        const command = principalCommand();
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));

        assertClientMutation({ command, read, computed });
    });

    it('rejects altered outbox values, page membership, and receipt identities', () => {
        const command = principalCommand();
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

    it('rejects an accessor-backed computed result without invoking the accessor', () => {
        const command = principalCommand('accessor-backed-computed');
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

    it('preserves structural result validation order and exact error details', () => {
        const command = principalCommand();
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

    it('accepts a canonical idempotency conflict as validated data', () => {
        const command = principalCommand();
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

    it('rejects self-consistent state sync and outbox values that differ from canonical computation', () => {
        const command = principalCommand();
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
                .map(({ entry }) => computeAppOutboxInsert(entry))
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
    it('projects an authorised connect once and still rejects a changed candidate', () => {
        const input = authorisedConnectOperationInput();
        const computed = computeAuthorisedWsConnectOperation(input);
        if (computed.outcome !== 'completed' || computed.mutation.outcome !== 'write') {
            throw new Error('Expected a completed authorised connect write');
        }
        vi.mocked(validateComputedProjection).mockClear();

        assertAuthorisedWsConnectOperation({ ...input, computed });

        // Each projection walks the complete operation; one walk over one full recompute is the validation cost contract.
        expect(validateComputedProjection).toHaveBeenCalledTimes(1);
        const changed = { ...computed.mutation, outboxMessages: computed.mutation.outboxMessages.slice(1) };
        expect(() => assertAuthorisedWsConnectOperation({ ...input, computed: { ...computed, mutation: changed } }))
            .toThrow(/outboxMessages/);
    });

    it('rejects an unexpected unicast row even when accepted state sync has no live session', () => {
        const command = principalCommand();
        const read = emptyRead(command);
        const input = {
            command,
            read,
            completionFacts: { entry: createExecutionMetadata().entry, completedAtEpochMs: 8_000 },
            lifecycle: undefined
        };
        const computed = computeClientMutationOperation(input);
        if (computed.outcome !== 'completed' || computed.mutation.outcome !== 'write') {
            throw new Error('Expected completed mutation');
        }
        const mutation = computed.mutation;
        const first = mutation.outboxWrites[0]!;
        const message = decodePersistedALMessage(first.entry.resource);
        const unexpectedUnicast = computeAppOutboxInsert({
            ...first.entry,
            resource: JSON.stringify({ ...message, targets: { mode: 'unicast', toPeerId: 'late-session' } })
        });
        const forgedMutation = { ...mutation, outboxWrites: [unexpectedUnicast, ...mutation.outboxWrites.slice(1)] };
        expect(() =>
            assertClientMutationOperation({
                ...input,
                computed: {
                    ...computed,
                    mutation: forgedMutation,
                    writes: [forgedMutation]
                }
            })
        ).toThrow(/outboxWrites/);
    });

    it('rejects missing, duplicated, wrong-scope and wrong-recipient snapshot proof writes before transaction entry', () => {
        const command = connectCommand();
        const input = {
            command,
            read: emptyRead(command),
            completionFacts: { entry: createExecutionMetadata().entry, completedAtEpochMs: 8_000 },
            lifecycle: undefined
        };
        const computed = computeClientMutationOperation(input);
        if (computed.outcome !== 'completed') {
            throw new Error('Expected a completed mutation');
        }
        const proofs = computed.sidecarWrites;
        const proof = proofs.find((candidate) => JSON.parse(candidate.value).target.kind === 'scoped-unicast');
        if (!proof) {
            throw new Error('Expected a frozen unicast snapshot proof');
        }
        const variants = [
            proofs.filter((candidate) => candidate !== proof),
            [...proofs, proof],
            proofs.map((candidate) =>
                candidate === proof
                    ? { ...proof, value: proof.value.replace('workspace-1', 'wrong-workspace') }
                    : candidate
            ),
            proofs.map((candidate) =>
                candidate === proof
                    ? { ...proof, value: proof.value.replaceAll('session-1', 'late-session') }
                    : candidate
            ),
            proofs.map((candidate) => candidate === proof ? { ...proof, key: 'wrong-slot' } : candidate),
            proofs.map((candidate) =>
                candidate === proof
                    ? { ...proof, expiresAt: '1970-01-01T00:00:01Z' }
                    : candidate
            )
        ];
        for (const sidecarWrites of variants) {
            expect(() => assertClientMutationOperation({ ...input, computed: { ...computed, sidecarWrites } }))
                .toThrow(/sidecarWrites/);
        }
    });

    it('retains no sidecar writes when a fresh inbox delivery replays a durable client command', () => {
        const command = connectCommand();
        const connected = requireWrite(computeClientMutation({ command, read: emptyRead(command) }));
        if (connected.idempotency === null) {
            throw new Error('Expected an idempotent command');
        }
        const input = {
            command,
            read: { ...readAfterWrite(command, connected), idempotency: entryValue(connected.idempotency, 0) },
            completionFacts: { entry: createExecutionMetadata().entry, completedAtEpochMs: 8_000 },
            lifecycle: undefined
        };
        const computed = computeClientMutationOperation(input);
        assertClientMutationOperation({ ...input, computed });
        expect(computed).toMatchObject({ outcome: 'completed', mutation: { outcome: 'replay' }, writes: [], sidecarWrites: [] });
    });

    it('rejects a changed prepared payload at the operation projection', () => {
        const command = principalCommand();
        const input = {
            command,
            read: emptyRead(command),
            completionFacts: { entry: createExecutionMetadata().entry, completedAtEpochMs: 8_000 },
            lifecycle: undefined
        };
        const computed = computeClientMutationOperation(input);
        if (computed.outcome !== 'completed' || computed.mutation.outcome !== 'write') {
            throw new Error('Expected a completed mutation');
        }
        const [first, ...remaining] = computed.mutation.outboxWrites;
        if (!first) {
            throw new Error('Expected a state-sync write');
        }
        const mutation = {
            ...computed.mutation,
            outboxWrites: [{ ...first, entry: { ...first.entry, resource: 'altered' } }, ...remaining]
        };
        expect(() => assertClientMutationOperation({ ...input, computed: { ...computed, mutation, writes: [mutation] } }))
            .toThrow(/outboxWrites/);
    });

    it('rejects altered completion, write membership and committed snapshots', () => {
        const command = principalCommand();
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

    it('rejects an accessor-backed mutation before reading it', () => {
        const command = principalCommand();
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

    it('rejects missing or duplicate expired mutations before validating individual reads', () => {
        const connectedCommand = connectCommand();
        const connected = requireWrite(computeClientMutation({ command: connectedCommand, read: emptyRead(connectedCommand) }));
        const command = expiryCommand();
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
            id: { v: 3, msgId: entry.key.resourceId, ts: 1_000, senderId: 'client-service' },
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
