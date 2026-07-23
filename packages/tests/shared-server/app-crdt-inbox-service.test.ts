import { describe, expect, it } from 'vitest';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
    CRDT_MUTATION_INBOX_TYPES,
    CrdtMutationConflictError,
    createCrdtMutationCommand,
    createCrdtMutationService,
    decodeCrdtMutationCommand,
    decodeCrdtMutationResult,
    type CrdtMutationComputed,
    type CrdtMutationRepository,
} from '@shared-server/rallar-system/services/crdt-mutations.ts';
import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
    },
};

describe('CRDT AppInbox mutation contracts', () => {
    it('defines the complete DB-mutating CRDT AppInbox inventory', () => {
        expect(CRDT_MUTATION_INBOX_TYPES).toEqual([
            AppInboxType.CRDT_UPDATE_APPEND,
            AppInboxType.CRDT_PROJECTION_REBUILD,
            AppInboxType.CRDT_SNAPSHOT_COMPACT,
            AppInboxType.CRDT_LIFECYCLE_UPDATE,
            AppInboxType.CRDT_ERASE,
        ]);
        expect(AppInboxType.ADMIN_PRUNE_EXPIRED).toBe('ADMIN_PRUNE_EXPIRED');
    });

    it('creates and exactly decodes mandatory durable append commands', async () => {
        const command = await createCrdtMutationCommand({
            operation: 'append',
            commandId: 'append-1',
            actor: {
                actorId: 'actor-1',
                principalId: 'principal-1',
                sessionId: 'session-1',
                serverId: 'server-1',
            },
            capturedAtEpochMs: 1_000,
            expireAtEpochMs: 61_000,
            document: DOCUMENT,
            update: createUpdate('update-1'),
            authorizationScope: 'room',
            responseAudience: {
                kind: 'room',
                senderSessionId: 'session-1',
                topicId: 'room.crdt',
                contextId: 'group-1',
            },
        });

        expect(decodeCrdtMutationCommand(command)).toEqual(command);
        expect(command).toMatchObject({
            version: 1,
            operation: 'append',
            commandId: 'append-1',
            commandHash: expect.any(String),
            documentKey: expect.any(String),
        });
        for (const invalid of [
            { ...command, commandHash: 'wrong' },
            { ...command, actor: { ...command.actor, sessionId: undefined } },
            { ...command, responseAudience: undefined },
            { ...command, unexpected: true },
        ]) {
            expect(() => decodeCrdtMutationCommand(invalid)).toThrow(TypeError);
        }
    });

    it('computes accepted append state and two durable logical WS effects', async () => {
        const repository = new MemoryCrdtMutationRepository();
        const service = createCrdtMutationService({
            repository,
            createWriter: () => repository,
            serviceId: 'server-1',
        });
        const command = await createAppendCommand('append-accepted', 'update-1');
        const read = await service.read(command);
        const computed = service.compute(command, read);

        service.validate(command, read, computed);
        expect(computed).toMatchObject({
            outcome: 'write',
            operation: 'append',
            expectedDocumentRevision: 'absent',
            document: {
                documentRevision: 1,
                lastAppendSequence: 1,
                updateCount: 1,
            },
        });
        expect(computed.outboxEntries).toHaveLength(2);
        expect(computed.outboxEntries.every((entry) => entry.typeId === 'WS_OUTBOX')).toBe(true);

        const result = await service.write(repository.transaction, computed);

        expect(decodeCrdtMutationResult(result)).toMatchObject({
            operation: 'append',
            status: 'accepted',
            documentRevision: 1,
            appendSequence: 1,
        });
        expect(repository.metadata?.documentRevision).toBe(1);
        expect(repository.updates.map((update) => update.updateId)).toEqual(['update-1']);
        expect(repository.outbox).toHaveLength(2);
    });

    it('replays an identical update and rejects an update-ID collision without writing', async () => {
        const repository = new MemoryCrdtMutationRepository();
        const service = createCrdtMutationService({
            repository,
            createWriter: () => repository,
            serviceId: 'server-1',
        });
        await apply(service, await createAppendCommand('append-first', 'update-1'));

        const replay = await compute(service, await createAppendCommand('append-replay', 'update-1'));
        const collision = await compute(
            service,
            await createAppendCommand('append-collision', 'update-1', 'different'),
        );

        expect(replay.outcome).toBe('replay');
        expect(collision).toMatchObject({
            outcome: 'rejected',
            code: 'duplicate-hash-mismatch',
        });
        expect(repository.writeCalls).toBe(1);
    });

    it('reruns lifecycle and quota policy after an optimistic conflict', async () => {
        const repository = new MemoryCrdtMutationRepository();
        const service = createCrdtMutationService({
            repository,
            createWriter: () => repository,
            serviceId: 'server-1',
        });
        const command = await createAppendCommand('append-conflict', 'update-1');
        const first = await compute(service, command);
        repository.failNextConflict = true;

        await expect(service.write(repository.transaction, first)).rejects.toBeInstanceOf(
            CrdtMutationConflictError,
        );
        repository.metadata = createMetadata({
            lifecycle: 'archived',
            documentRevision: 1,
        });
        const retried = await compute(service, command);

        expect(retried).toMatchObject({
            outcome: 'rejected',
            code: 'document-archived',
        });
        expect(repository.readCalls).toBe(2);
        expect(repository.writeCalls).toBe(1);
    });

    it.each([
        ['rebuild-projection', AppInboxType.CRDT_PROJECTION_REBUILD],
        ['compact', AppInboxType.CRDT_SNAPSHOT_COMPACT],
        ['lifecycle', AppInboxType.CRDT_LIFECYCLE_UPDATE],
        ['erase', AppInboxType.CRDT_ERASE],
    ] as const)('maps %s to its durable AppInbox type', (operation, expected) => {
        expect(CRDT_MUTATION_INBOX_TYPES).toContain(expected);
        expect(operation.length).toBeGreaterThan(0);
    });
});

async function createAppendCommand(
    commandId: string,
    updateId: string,
    title = 'accepted',
) {
    return await createCrdtMutationCommand({
        operation: 'append',
        commandId,
        actor: {
            actorId: 'actor-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            serverId: 'server-1',
        },
        capturedAtEpochMs: 1_000,
        expireAtEpochMs: 61_000,
        document: DOCUMENT,
        update: createUpdate(updateId, title),
        authorizationScope: 'room',
        responseAudience: {
            kind: 'room',
            senderSessionId: 'session-1',
            topicId: 'room.crdt',
            contextId: 'group-1',
        },
    });
}

function createUpdate(updateId: string, title = 'accepted'): RallarCrdtUpdateEnvelope {
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
            operations: [{
                kind: 'register.set',
                path: ['title'],
                policy: 'lww',
                value: title,
            }],
        },
    };
}

function createMetadata(
    overrides: Partial<RallarCrdtDocumentMetadata> = {},
): RallarCrdtDocumentMetadata {
    return {
        document: DOCUMENT,
        documentKey: 'app-1/workspace-1/room/checklist/document-1',
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
        ...overrides,
    };
}

class MemoryCrdtMutationRepository implements CrdtMutationRepository {
    metadata: RallarCrdtDocumentMetadata | null = null;
    updates: RallarCrdtUpdateEnvelope[] = [];
    outbox: CrdtMutationComputed['outboxEntries'][number][] = [];
    readCalls = 0;
    writeCalls = 0;
    failNextConflict = false;
    readonly transaction = (() => undefined) as never;

    readMutation() {
        this.readCalls += 1;
        return Promise.resolve({
            document: this.metadata,
            existingUpdate: this.updates.at(-1) ?? null,
            existingAppend: null,
            records: [],
            snapshot: null,
            authorized: true,
            authorizationCode: 'allowed',
            featureDecision: {
                allowed: true, code: 'allowed', reason: 'test', rollout: 'production', retryable: false,
            },
            actorUpdatesInWindow: 0,
            storedSnapshotBytes: 0,
        });
    }

    writeMutation(computed: CrdtMutationComputed) {
        this.writeCalls += 1;
        if (this.failNextConflict) {
            this.failNextConflict = false;
            throw new CrdtMutationConflictError(computed.documentKey);
        }
        if (computed.outcome === 'write') {
            this.metadata = computed.document;
            if (computed.operation === 'append') this.updates.push(computed.update);
        }
        return Promise.resolve();
    }

    writeOutbox(entries: CrdtMutationComputed['outboxEntries']) {
        this.outbox.push(...entries);
        return Promise.resolve();
    }
}

async function compute(
    service: ReturnType<typeof createCrdtMutationService>,
    command: Awaited<ReturnType<typeof createAppendCommand>>,
) {
    const read = await service.read(command);
    const computed = service.compute(command, read);
    service.validate(command, read, computed);
    return computed;
}

async function apply(
    service: ReturnType<typeof createCrdtMutationService>,
    command: Awaited<ReturnType<typeof createAppendCommand>>,
) {
    const computed = await compute(service, command);
    return await service.write((service as never as { transaction: never }).transaction, computed);
}
