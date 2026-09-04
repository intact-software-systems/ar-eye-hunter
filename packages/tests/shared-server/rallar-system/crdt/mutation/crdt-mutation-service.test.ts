import { describe, expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import {
    type CrdtMutationCommand,
    type CrdtMutationComputed,
    type CrdtMutationRead,
    type CrdtMutationRepository
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';
import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import { PSqlCrdtMutationRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts';
import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1'
    }
};

describe('CRDT mutation service', () => {
    it('does not expose a write path outside AppInbox transaction ownership', () => {
        const transaction = createUnusedTransaction();
        const repository = new PSqlCrdtMutationRepository(
            { sql: transaction, authorize: () => Promise.resolve(true) },
            { policies: [] }
        );
        const service = createCrdtMutationService({
            repository,
            serviceId: 'server-1'
        });

        expect(service).not.toHaveProperty('write');
        expect(repository).not.toHaveProperty('writeMutation');
        expect(repository).not.toHaveProperty('writeOutbox');
    });

    it('keeps command and read provenance in the complete computed mutation', async () => {
        const repository = new MemoryCrdtMutationRepository();
        const service = createCrdtMutationService({
            repository,
            serviceId: 'server-1'
        });
        const command = await createAppendCommand('append-accepted', 'update-1');

        const read = await service.read(command);
        const computed = service.compute({ command, read });

        expect(computed.command).toBe(command);
        expect(computed.read).toBe(read);
        expect(computed).toMatchObject({
            outcome: 'write',
            operation: 'append',
            expectedDocumentRevision: 'absent',
            document: { documentRevision: 1, lastAppendSequence: 1, updateCount: 1 }
        });
        expect(computed.outboxEntries.every((entry) => entry.typeId === 'WS_OUTBOX')).toBe(true);
        expect(service.validate({ command, read, computed })).toEqual([]);
        expect(decodeCrdtMutationResult(computed.result)).toMatchObject({
            status: 'accepted',
            documentRevision: 1,
            appendSequence: 1
        });
    });

    it('replays identical updates and rejects collisions without mutation writes', async () => {
        const repository = new MemoryCrdtMutationRepository();
        const service = createCrdtMutationService({
            repository,
            serviceId: 'server-1'
        });
        const first = await readComputeValidateCrdtMutation(
            service,
            await createAppendCommand('append-first', 'update-1')
        );
        if (first.outcome !== 'write' || first.update === null) {
            throw new TypeError('Expected an accepted append mutation');
        }
        repository.metadata = first.document;
        repository.updates = [first.update];
        repository.append = first.append;

        const replay = await readComputeValidateCrdtMutation(
            service,
            await createAppendCommand('append-replay', 'update-1')
        );
        const collision = await readComputeValidateCrdtMutation(
            service,
            await createAppendCommand('append-collision', 'update-1', 'different')
        );

        expect(replay.outcome).toBe('replay');
        expect(collision).toMatchObject({
            outcome: 'rejected',
            code: 'duplicate-hash-mismatch'
        });
    });

    it('computes each administrative operation in its named decision phase', async () => {
        const repository = new MemoryCrdtMutationRepository();
        repository.metadata = createMetadata();
        const service = createCrdtMutationService({
            repository,
            serviceId: 'server-1'
        });

        const rebuild = await createCrdtMutationCommand({
            operation: 'rebuild-projection',
            commandId: 'rebuild',
            actor: createActor(),
            capturedAtEpochMs: 1_000,
            expireAtEpochMs: 61_000,
            document: DOCUMENT,
            projectionId: 'projection-1',
            responseAudience: createAudience()
        });
        const compact = await createCrdtMutationCommand({
            operation: 'compact',
            commandId: 'compact',
            actor: createActor(),
            capturedAtEpochMs: 1_000,
            expireAtEpochMs: 61_000,
            document: DOCUMENT,
            snapshotId: 'snapshot-1',
            snapshot: null,
            reason: 'compact-test',
            responseAudience: createAudience()
        });
        const lifecycle = await createCrdtMutationCommand({
            operation: 'lifecycle',
            commandId: 'lifecycle',
            actor: createActor(),
            capturedAtEpochMs: 1_000,
            expireAtEpochMs: 61_000,
            document: DOCUMENT,
            lifecycle: 'archived',
            retentionAction: { kind: 'preserve' },
            quotaAction: { kind: 'preserve' },
            projectionIdsAction: { kind: 'preserve' },
            responseAudience: createAudience()
        });
        const erase = await createCrdtMutationCommand({
            operation: 'erase',
            commandId: 'erase',
            actor: createActor(),
            capturedAtEpochMs: 1_000,
            expireAtEpochMs: 61_000,
            document: DOCUMENT,
            mode: 'destroy-document',
            reason: 'erase-test',
            responseAudience: createAudience()
        });

        for (const command of [rebuild, compact, lifecycle, erase]) {
            const read = await service.read(command);
            expect(service.compute({ command, read })).toMatchObject({
                outcome: 'write',
                operation: command.operation
            });
        }
    });

});

function createActor() {
    return {
        actorId: 'actor-1',
        principalId: 'principal-1',
        sessionId: 'session-1',
        serverId: 'server-1'
    };
}

function createAudience() {
    return {
        kind: 'room' as const,
        senderSessionId: 'session-1',
        topicId: 'room.crdt',
        contextId: 'group-1'
    };
}

async function createAppendCommand(
    commandId: string,
    updateId: string,
    title = 'accepted'
) {
    return await createCrdtMutationCommand({
        operation: 'append',
        commandId,
        actor: createActor(),
        capturedAtEpochMs: 1_000,
        expireAtEpochMs: 61_000,
        document: DOCUMENT,
        update: createUpdate(updateId, title),
        authorizationScope: 'room',
        responseAudience: createAudience()
    });
}

function createUpdate(
    updateId: string,
    title: string
): RallarCrdtUpdateEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: DOCUMENT,
        updateId,
        replicaId: 'replica-1',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 900,
        payload: {
            kind: 'batch',
            operations: [
                {
                    kind: 'register.set',
                    path: ['title'],
                    policy: 'lww',
                    value: title
                }
            ]
        }
    };
}

function createMetadata(overrides: Partial<RallarCrdtDocumentMetadata> = {}): RallarCrdtDocumentMetadata {
    return {
        document: DOCUMENT,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        documentRevision: 0,
        lifecycle: 'active',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 1_000,
        archivedAtEpochMs: null,
        destroyedAtEpochMs: null,
        lastAppendSequence: 0,
        updateCount: 0,
        snapshotCount: 0,
        storedUpdateBytes: 0,
        retention: null,
        quota: null,
        projectionIds: [],
        ...overrides
    };
}

class MemoryCrdtMutationRepository implements CrdtMutationRepository {
    metadata: RallarCrdtDocumentMetadata | null = null;
    updates: RallarCrdtUpdateEnvelope[] = [];
    append: CrdtMutationComputed['append'] = null;

    readMutation(_command: CrdtMutationCommand): Promise<CrdtMutationRead> {
        return Promise.resolve({
            document: this.metadata,
            existingUpdate: this.updates.at(-1) ?? null,
            existingAppend: this.append,
            records: [],
            snapshot: null,
            authorized: true,
            authorizationCode: 'allowed',
            featureDecision: {
                allowed: true,
                code: 'allowed',
                reason: 'test',
                rollout: 'production',
                retryable: false
            },
            actorUpdatesInWindow: 0,
            storedSnapshotBytes: 0
        });
    }
}

function createUnusedTransaction(): PSqlSql {
    function query<T>(_strings: TemplateStringsArray, ..._values: PSqlParameter[]): Promise<T>;
    function query(_values: readonly PSqlParameter[]): ReturnType<PSqlSql>;
    function query(): never {
        throw new Error('Unexpected SQL execution in mutation unit test');
    }
    return Object.assign(query, {
        begin: <T>(): Promise<T> =>
            Promise.reject(new Error('Unexpected nested transaction in mutation unit test'))
    });
}

async function readComputeValidateCrdtMutation(
    service: ReturnType<typeof createCrdtMutationService>,
    command: Awaited<ReturnType<typeof createAppendCommand>>
) {
    const read = await service.read(command);
    const computed = service.compute({ command, read });
    expect(service.validate({ command, read, computed })).toEqual([]);
    return computed;
}
