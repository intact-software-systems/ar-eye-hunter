import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import {
    CrdtMutationConflictError,
    type CrdtMutationCommand,
    type CrdtMutationComputed,
    type CrdtMutationComputedWrite,
    type CrdtMutationRead,
    type CrdtMutationRepository
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';
import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
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
    it('keeps command and read provenance while writing mutation before final outbox', async () => {
        const repository = new MemoryCrdtMutationRepository();
        const service = createCrdtMutationService({
            repository,
            createWriter: () => repository,
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
        await expect(service.write(repository.transaction, computed)).resolves.toBe(computed.result);
        expect(repository.operations).toEqual(['write-mutation', 'write-final-outbox']);
        expect(repository.metadata?.documentRevision).toBe(1);
        expect(repository.outbox).toHaveLength(2);
        expect(repository.updates.map((update) => update.updateId)).toEqual(['update-1']);
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
            createWriter: () => repository,
            serviceId: 'server-1'
        });
        await applyCrdtMutation(service, repository, await createAppendCommand('append-first', 'update-1'));

        const replay = await readComputeValidateCrdtMutation(service, await createAppendCommand('append-replay', 'update-1'));
        const collision = await readComputeValidateCrdtMutation(service, await createAppendCommand('append-collision', 'update-1', 'different'));

        expect(replay.outcome).toBe('replay');
        expect(collision).toMatchObject({
            outcome: 'rejected',
            code: 'duplicate-hash-mismatch'
        });
        expect(repository.operations).toEqual(['write-mutation', 'write-final-outbox']);
    });

    it('recomputes lifecycle and quota policy after a write conflict', async () => {
        const repository = new MemoryCrdtMutationRepository();
        const service = createCrdtMutationService({
            repository,
            createWriter: () => repository,
            serviceId: 'server-1'
        });
        const command = await createAppendCommand('append-conflict', 'update-1');
        const first = await readComputeValidateCrdtMutation(service, command);
        repository.failNextConflict = true;

        await expect(service.write(repository.transaction, first)).rejects.toBeInstanceOf(CrdtMutationConflictError);
        repository.metadata = createMetadata({
            lifecycle: 'archived',
            documentRevision: 1,
            archivedAtEpochMs: 1_000
        });
        const retried = await readComputeValidateCrdtMutation(service, command);

        expect(retried).toMatchObject({
            outcome: 'rejected',
            code: 'document-archived'
        });
        expect(repository.readCalls).toBe(2);
        expect(repository.operations).toEqual(['write-mutation']);
    });

    it('computes each administrative operation in its named decision phase', async () => {
        const repository = new MemoryCrdtMutationRepository();
        repository.metadata = createMetadata();
        const service = createCrdtMutationService({
            repository,
            createWriter: () => repository,
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

    it('returns ordered command and read provenance issues without throwing', async () => {
        const repository = new MemoryCrdtMutationRepository();
        const service = createCrdtMutationService({
            repository,
            createWriter: () => repository,
            serviceId: 'server-1'
        });
        const command = await createAppendCommand('append-validation', 'update-validation');
        const read = await service.read(command);
        const computed = service.compute({ command, read });
        const commandMismatch = { ...computed, command: { ...command } };
        const readMismatch = { ...computed, read: { ...read } };
        const persistenceMismatch = { ...computed, outboxWrites: [] };

        expect(service.validate({ command, read, computed: commandMismatch })).toMatchObject([{ code: 'computed-identity-differs' }]);
        expect(service.validate({ command, read, computed: readMismatch })).toMatchObject([{ code: 'computed-identity-differs' }]);
        expect(service.validate({ command, read, computed: persistenceMismatch })).toMatchObject([{ code: 'computed-persistence-differs' }]);
    });

    it('returns all ordered validation issues for a malformed compact accepted result', async () => {
        const repository = new MemoryCrdtMutationRepository();
        repository.metadata = createMetadata();
        const service = createCrdtMutationService({
            repository,
            createWriter: () => repository,
            serviceId: 'server-1'
        });
        const command = await createCrdtMutationCommand({
            operation: 'compact',
            commandId: 'compact-validation',
            actor: createActor(),
            capturedAtEpochMs: 1_000,
            expireAtEpochMs: 61_000,
            document: DOCUMENT,
            snapshotId: 'snapshot-validation',
            snapshot: null,
            reason: 'validation',
            responseAudience: createAudience()
        });
        const read = await service.read(command);
        const computed = service.compute({ command, read });
        const malformed = {
            ...computed,
            command: { ...command },
            expectedDocumentRevision: 99
        };
        Reflect.set(malformed, 'snapshot', {});
        Reflect.set(malformed, 'result', {
            ...computed.result,
            snapshot: null,
            metadata: null
        });

        expect(() => service.validate({ command, read, computed: malformed })).not.toThrow();
        expect(service.validate({ command, read, computed: malformed }).map((issue) => issue.code)).toEqual([
            'computed-identity-differs',
            'computed-predecessor-differs',
            'compact-reason-differs',
            'result-codec-invalid',
            'computed-persistence-differs'
        ]);
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

async function createAppendCommand(commandId: string, updateId: string, title = 'accepted') {
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

function createUpdate(updateId: string, title: string): RallarCrdtUpdateEnvelope {
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
    append: CrdtMutationComputedWrite['append'] = null;
    outbox: CrdtMutationComputed['outboxEntries'][number][] = [];
    operations: string[] = [];
    readCalls = 0;
    failNextConflict = false;
    readonly transaction = createUnusedTransaction();

    readMutation(_command: CrdtMutationCommand): Promise<CrdtMutationRead> {
        this.readCalls += 1;
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

    writeMutation(computed: CrdtMutationComputedWrite): Promise<void> {
        this.operations.push('write-mutation');
        if (this.failNextConflict) {
            this.failNextConflict = false;
            throw new CrdtMutationConflictError(computed.documentKey);
        }
        this.metadata = computed.document;
        if (computed.operation === 'append') {
            if (!computed.update) {
                throw new Error('Expected append mutation update');
            }
            this.updates.push(computed.update);
            this.append = computed.append;
        }
        return Promise.resolve();
    }

    writeOutbox(writes: readonly AppOutboxInsert[]): Promise<void> {
        this.operations.push('write-final-outbox');
        this.outbox.push(...writes.map(({ entry }) => entry));
        return Promise.resolve();
    }
}

function createUnusedTransaction(): PSqlSql {
    const transaction: PSqlSql = Object.assign(
        <T>(_stringsOrValues: TemplateStringsArray | readonly unknown[], ..._values: unknown[]): Promise<T> =>
            Promise.reject(new Error('Unexpected SQL execution in mutation unit test')),
        {
            begin: <T>(_run: (sql: PSqlSql) => Promise<T>): Promise<T> => Promise.reject(new Error('Unexpected nested transaction in mutation unit test'))
        }
    );
    return transaction;
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

async function applyCrdtMutation(
    service: ReturnType<typeof createCrdtMutationService>,
    repository: MemoryCrdtMutationRepository,
    command: Awaited<ReturnType<typeof createAppendCommand>>
) {
    const computed = await readComputeValidateCrdtMutation(service, command);
    return await service.write(repository.transaction, computed);
}
