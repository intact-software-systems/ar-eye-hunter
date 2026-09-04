import { describe, expect, it } from 'vitest';

import { computeCrdtMutation } from '@shared-server/rallar-system/crdt/mutation/compute-crdt-mutation.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import {
    type CrdtAppendCommand,
    type CrdtMutationCommand,
    type CrdtMutationComputed,
    type CrdtMutationRead
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';
import {
    hashRallarCrdtUpdateEnvelope,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtTrustedAppendMetadata,
    type RallarCrdtUpdateEnvelope
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
        groupId: 'group-1'
    }
};

const SUBSTITUTED_DOCUMENT: RallarCrdtDocumentRef = {
    ...DOCUMENT,
    documentId: 'substituted-document'
};

interface AppendCommandInput {
    readonly commandId: string;
    readonly updateId: string;
    readonly title: string;
    readonly document: RallarCrdtDocumentRef;
}

describe('CRDT mutation exact validation', () => {
    it('rejects an accepted outcome computed from coordinated substituted inputs', async () => {
        const command = await createAppendCommand({
            commandId: 'accepted-original',
            updateId: 'accepted-update',
            title: 'accepted',
            document: DOCUMENT
        });
        const read = createMutationRead();
        const substitutedCommand = await createAppendCommand({
            commandId: 'accepted-substituted',
            updateId: 'accepted-substituted-update',
            title: 'substituted',
            document: SUBSTITUTED_DOCUMENT
        });
        const substituted = computeCrdtMutation({
            command: substitutedCommand,
            read: createMutationRead(),
            serviceId: 'substituted-server'
        });

        expect(substituted.outcome).toBe('write');
        expect(validate(command, read, restoreOriginalProvenance(substituted, command, read))[0])
            .toMatchObject({ code: 'computed-mutation-differs' });
    });

    it('rejects a replay outcome computed from coordinated substituted inputs', async () => {
        const command = await createAppendCommand({
            commandId: 'replay-original',
            updateId: 'replay-update',
            title: 'accepted',
            document: DOCUMENT
        });
        const read = createReplayRead(command);
        const substitutedCommand = await createAppendCommand({
            commandId: 'replay-substituted',
            updateId: 'replay-substituted-update',
            title: 'substituted',
            document: SUBSTITUTED_DOCUMENT
        });
        const substituted = computeCrdtMutation({
            command: substitutedCommand,
            read: createReplayRead(substitutedCommand),
            serviceId: 'substituted-server'
        });

        expect(substituted.outcome).toBe('replay');
        expect(validate(command, read, restoreOriginalProvenance(substituted, command, read))[0])
            .toMatchObject({ code: 'computed-mutation-differs' });
    });

    it('rejects a rejected outcome computed from coordinated substituted inputs', async () => {
        const command = await createAppendCommand({
            commandId: 'rejected-original',
            updateId: 'rejected-update',
            title: 'accepted',
            document: DOCUMENT
        });
        const read = createMutationRead({ featureDecision: disabledFeature('original policy') });
        const substitutedCommand = await createAppendCommand({
            commandId: 'rejected-substituted',
            updateId: 'rejected-substituted-update',
            title: 'substituted',
            document: SUBSTITUTED_DOCUMENT
        });
        const substituted = computeCrdtMutation({
            command: substitutedCommand,
            read: createMutationRead({ featureDecision: disabledFeature('substituted policy') }),
            serviceId: 'substituted-server'
        });

        expect(substituted.outcome).toBe('rejected');
        expect(validate(command, read, restoreOriginalProvenance(substituted, command, read))[0])
            .toMatchObject({ code: 'computed-mutation-differs' });
    });

    it('rejects every altered accepted result, row, outbox, and conflict fact', async () => {
        const command = await createAppendCommand({
            commandId: 'accepted-validation',
            updateId: 'accepted-validation-update',
            title: 'accepted',
            document: DOCUMENT
        });
        const read = createMutationRead();
        const computed = computeCrdtMutation({ command, read, serviceId: 'server-1' });
        if (computed.outcome !== 'write' || computed.updateWrite === null) {
            throw new TypeError('Expected an accepted append mutation');
        }
        const firstOutboxWrite = computed.outboxWrites[0];
        if (firstOutboxWrite === undefined) {
            throw new TypeError('Expected an append outbox write');
        }
        const resultMismatch = { ...computed };
        Reflect.set(resultMismatch, 'result', {
            ...computed.result,
            documentRevision: 99
        });
        const candidates = [
            { ...computed, command: { ...command } },
            { ...computed, read: { ...read } },
            {
                ...computed,
                documentWrite: { ...computed.documentWrite, retentionJson: '{"kind":"tampered"}' }
            },
            {
                ...computed,
                updateWrite: { ...computed.updateWrite, updateEnvelopeJson: '{"kind":"tampered"}' }
            },
            {
                ...computed,
                outboxWrites: [
                    { ...firstOutboxWrite, createdAt: '2000-01-01T00:00:00.000Z' },
                    ...computed.outboxWrites.slice(1)
                ]
            },
            resultMismatch
        ];

        for (const candidate of candidates) {
            expect(validate(command, read, candidate)[0]).toMatchObject({
                code: 'computed-mutation-differs'
            });
        }
    });

    it('rejects altered compact snapshot rows and malformed results without throwing', async () => {
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
        const read = createMutationRead({ document: createMetadata() });
        const computed = computeCrdtMutation({ command, read, serviceId: 'server-1' });
        if (computed.outcome !== 'write' || computed.snapshotWrite === null) {
            throw new TypeError('Expected an accepted compact mutation');
        }
        const snapshotMismatch = {
            ...computed,
            snapshotWrite: {
                ...computed.snapshotWrite,
                snapshotEnvelopeJson: '{"kind":"tampered"}'
            }
        };
        const malformedResult = { ...computed };
        Reflect.set(malformedResult, 'result', {
            ...computed.result,
            snapshot: null,
            metadata: null
        });

        expect(() => validate(command, read, malformedResult)).not.toThrow();
        expect(validate(command, read, snapshotMismatch)[0]).toMatchObject({
            code: 'computed-mutation-differs'
        });
        expect(validate(command, read, malformedResult)[0]).toMatchObject({
            code: 'computed-mutation-differs'
        });
    });

    it('rejects a proxy candidate without executing its traps', async () => {
        const command = await createAppendCommand({
            commandId: 'proxy-validation',
            updateId: 'proxy-validation-update',
            title: 'accepted',
            document: DOCUMENT
        });
        const read = createMutationRead();
        const computed = computeCrdtMutation({ command, read, serviceId: 'server-1' });
        let propertyReads = 0;
        const candidate = new Proxy(computed, {
            get(target, property, receiver) {
                propertyReads += 1;
                return Reflect.get(target, property, receiver);
            }
        });

        expect(validate(command, read, candidate)[0]).toMatchObject({
            code: 'computed-mutation-differs'
        });
        expect(propertyReads).toBe(0);
    });
});

function validate(
    command: CrdtMutationCommand,
    read: CrdtMutationRead,
    computed: CrdtMutationComputed
) {
    const service = createCrdtMutationService({
        repository: { readMutation: () => Promise.resolve(read) },
        serviceId: 'server-1'
    });
    return service.validate({ command, read, computed });
}

async function createAppendCommand(input: AppendCommandInput): Promise<CrdtAppendCommand> {
    const command = await createCrdtMutationCommand({
        operation: 'append',
        commandId: input.commandId,
        actor: createActor(),
        capturedAtEpochMs: 1_000,
        expireAtEpochMs: 61_000,
        document: input.document,
        update: createUpdate(input.updateId, input.title, input.document),
        authorizationScope: 'room',
        responseAudience: createAudience()
    });
    if (command.operation !== 'append') {
        throw new TypeError('Expected an append command');
    }
    return command;
}

function createUpdate(
    updateId: string,
    title: string,
    document: RallarCrdtDocumentRef
): RallarCrdtUpdateEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document,
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
                value: title
            }]
        }
    };
}

function createMutationRead(overrides: Partial<CrdtMutationRead> = {}): CrdtMutationRead {
    return {
        document: null,
        existingUpdate: null,
        existingAppend: null,
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
        storedSnapshotBytes: 0,
        ...overrides
    };
}

function createReplayRead(command: CrdtAppendCommand): CrdtMutationRead {
    const append: RallarCrdtTrustedAppendMetadata = {
        appendSequence: 1,
        acceptedAtEpochMs: command.capturedAtEpochMs,
        actorId: command.actor.actorId,
        principalId: command.actor.principalId,
        sessionId: command.actor.sessionId,
        serverId: command.actor.serverId,
        authorizationScope: command.authorizationScope,
        acceptedUpdateHash: hashRallarCrdtUpdateEnvelope(command.update)
    };
    return createMutationRead({
        document: createMetadata({
            document: command.document,
            documentKey: command.documentKey,
            documentRevision: 1,
            lastAppendSequence: 1,
            updateCount: 1
        }),
        existingUpdate: command.update,
        existingAppend: append
    });
}

function restoreOriginalProvenance(
    computed: CrdtMutationComputed,
    command: CrdtMutationCommand,
    read: CrdtMutationRead
): CrdtMutationComputed {
    return {
        ...computed,
        command,
        read,
        operation: command.operation,
        commandId: command.commandId,
        commandHash: command.commandHash,
        documentKey: command.documentKey,
        expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
        expectedDocumentLifecycle: read.document?.lifecycle ?? 'absent',
        expectedAppendSequence: read.document?.lastAppendSequence ?? 'absent'
    };
}

function createMetadata(
    overrides: Partial<RallarCrdtDocumentMetadata> = {}
): RallarCrdtDocumentMetadata {
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

function disabledFeature(reason: string): CrdtMutationRead['featureDecision'] {
    return {
        allowed: false,
        code: 'feature-disabled',
        reason,
        rollout: 'disabled',
        retryable: false
    };
}
