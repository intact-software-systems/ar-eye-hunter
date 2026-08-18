import { describe, expect, it } from 'vitest';
import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    hashRallarCrdtUpdateEnvelope,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtAppendRejectionCode,
    type RallarCrdtUpdateEnvelope,
    toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS,
    RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS,
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AppCrdtInboxService } from '@shared-server/rallar-system/services/AppCrdtInboxService.ts';
import {
    createCrdtMutationCommand,
    createCrdtMutationService,
    decodeCrdtMutationResult,
} from '@shared-server/rallar-system/services/crdt-mutations.ts';
import { computeCrdtMutation } from '@shared-server/rallar-system/services/crdt-mutation-compute.ts';
import type {
    CrdtAppendMutationResult,
    CrdtMutationResult,
} from '@shared-server/rallar-system/services/crdt-mutation-contracts.ts';
import { appendRejectionReason } from '@shared-server/rallar-system/services/crdt-append-rejection.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'principal',
    documentType: 'checklist',
    documentId: 'document-1',
    principalId: 'alice',
};

describe('Task 9 correction 4 mutation contracts', () => {
    it('keeps semantic append identity stable while delivery identity and retry lifetime vary', async () => {
        const capturedAtEpochMs = 1_000;
        const service = appCrdt();
        const command = await service.createAndEnqueueAppend({
            update: update('semantic-update'),
            deliveryId: 'transport-delivery-1',
            actor: actor(),
            responseAudience: audience('principal'),
            capturedAtEpochMs,
            expireAtEpochMs: capturedAtEpochMs + 60_000,
        });

        expect(command.commandId).toBe('semantic-update');
        expect(command).toMatchObject({ deliveryId: 'transport-delivery-1' });
        expect(command.expireAtEpochMs).toBe(
            capturedAtEpochMs + DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS +
                RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS,
        );
    });

    it('allows replay only for append producers', async () => {
        const command = await lifecycleCommand();
        const computed = computeCrdtMutation(command, existingRead(), 'server-1');
        expect(computed.outcome).toBe('write');

        expect(() =>
            decodeCrdtMutationResult({
                ...computed.result,
                status: 'replay',
            })
        ).toThrow(/replay|operation|status/i);
    });

    it('requires exact producer update and rejection reason relationships', async () => {
        const command = await appendCommand();
        const rejected = computeCrdtMutation(command, {
            ...emptyRead(),
            authorized: false,
            authorizationCode: 'authorization-scope-denied',
        }, 'server-1');
        expect(rejected.outcome).toBe('rejected');
        const appendResult = (rejected.result as { appendResult: Record<string, unknown> })
            .appendResult;

        const { update: _update, ...missingUpdate } = appendResult;
        expect(() =>
            decodeCrdtMutationResult({
                ...rejected.result,
                appendResult: missingUpdate,
            })
        ).toThrow(/update|producer|rejection/i);
        expect(() =>
            decodeCrdtMutationResult({
                ...rejected.result,
                appendResult: { ...appendResult, reason: 'forged reason' },
            })
        ).toThrow(/reason|rejection/i);
    });

    it('produces and decodes retryability exactly for every append rejection code', async () => {
        const command = await appendCommand();
        const producerCases = [
            {
                read: {
                    ...emptyRead(),
                    authorized: false,
                    authorizationCode: 'authorization-scope-denied',
                },
                code: 'authorization-denied',
                retryable: false,
            },
            {
                read: {
                    ...existingRead(),
                    document: { ...metadata(), quota: { maxUpdateCount: 2 } },
                },
                code: 'quota-exceeded',
                retryable: false,
            },
            {
                read: {
                    ...existingRead(),
                    document: { ...metadata(), quota: { maxUpdatesPerMinutePerActor: 1 } },
                    actorUpdatesInWindow: 1,
                },
                code: 'rate-limited',
                retryable: true,
            },
        ] as const;
        for (const expected of producerCases) {
            const computed = computeCrdtMutation(command, expected.read, 'server-1');
            expect(requireAppendResult(computed.result)).toMatchObject({
                code: expected.code,
                retryable: expected.retryable,
            });
            expect(() => decodeCrdtMutationResult(computed.result)).not.toThrow();
        }

        const rejected = computeCrdtMutation(command, {
            ...emptyRead(),
            authorized: false,
            authorizationCode: 'authorization-denied',
        }, 'server-1');
        const appendResult = requireAppendResult(rejected.result);
        for (const code of appendRejectionCodes()) {
            const retryable = code === 'storage-failed' || code === 'rate-limited';
            expect(() => decodeCrdtMutationResult({
                ...rejected.result,
                code,
                appendResult: {
                    ...appendResult,
                    code,
                    reason: appendRejectionReason(code),
                    retryable: !retryable,
                },
            })).toThrow(/retryable|rejection/i);
        }
    });

    it('rejects retryability on an admin integrity result', async () => {
        const command = await rebuildCommand();
        const value = update('integrity-update');
        const rejected = computeCrdtMutation(command, {
            ...existingRead(),
            records: [{
                document: DOCUMENT,
                documentKey: toRallarCrdtDocumentKey(DOCUMENT),
                update: value,
                append: {
                    appendSequence: 1,
                    acceptedAtEpochMs: 1_000,
                    actorId: 'client-42',
                    principalId: 'alice',
                    sessionId: 'session-99',
                    serverId: 'server-1',
                    authorizationScope: 'principal',
                    acceptedUpdateHash: `${hashRallarCrdtUpdateEnvelope(value)}-corrupt`,
                },
            }],
        }, 'server-1');

        expect(rejected.result).toMatchObject({ status: 'rejected', code: 'integrity-invalid' });
        expect(() => decodeCrdtMutationResult({
            ...rejected.result,
            retryable: false,
        })).toThrow(/field|key|result/i);
    });

    it('binds compact and rebuild payloads to outer metadata revision and sequence', async () => {
        for (const operation of ['compact', 'rebuild-projection'] as const) {
            const command = operation === 'compact'
                ? await compactCommand()
                : await rebuildCommand();
            const computed = computeCrdtMutation(command, existingRead(), 'server-1');
            expect(computed.outcome).toBe('write');
            const result = computed.result;

            expect(result).toHaveProperty('metadata');
            expect(() => decodeCrdtMutationResult(result)).not.toThrow();
            expect(() =>
                decodeCrdtMutationResult({
                    ...result,
                    documentRevision: 99,
                    appendSequence: 99,
                })
            ).toThrow(/metadata|revision|sequence/i);
        }
    });
});

function requireAppendResult(
    result: CrdtMutationResult,
): CrdtAppendMutationResult['appendResult'] {
    if (result.operation !== 'append') {
        throw new Error(`Expected an append mutation result, received ${result.operation}`);
    }
    return result.appendResult;
}

function appCrdt(): AppCrdtInboxService {
    const repository = {
        readMutation: () => Promise.reject(new Error('not processed')),
        writeMutation: () => Promise.reject(new Error('not processed')),
        writeOutbox: () => Promise.reject(new Error('not processed')),
    };
    return new AppCrdtInboxService(
        new InboxQueueReader(new InMemoryQueueBox()),
        {} as never,
        {} as never,
        {} as never,
        createCrdtMutationService({
            repository,
            createWriter: () => repository,
            serviceId: 'server-1',
        }),
        'server-1',
    );
}

function actor() {
    return {
        actorId: 'client-42',
        principalId: 'alice',
        sessionId: 'session-99',
        serverId: 'server-1',
    };
}

function audience(kind: 'principal' | 'admin') {
    return {
        kind,
        senderSessionId: 'session-99',
        topicId: kind === 'admin' ? 'crdt.admin' : 'crdt.app',
        contextId: kind === 'admin' ? toRallarCrdtDocumentKey(DOCUMENT) : 'alice',
    } as const;
}

function common(commandId: string) {
    return {
        commandId,
        actor: actor(),
        capturedAtEpochMs: 2_000,
        expireAtEpochMs: 500_000,
        document: DOCUMENT,
        responseAudience: audience('admin'),
    };
}

async function appendCommand() {
    return await createCrdtMutationCommand({
        ...common('append-1'),
        operation: 'append',
        responseAudience: audience('principal'),
        authorizationScope: 'principal',
        update: update('append-1'),
    });
}

async function lifecycleCommand() {
    return await createCrdtMutationCommand({
        ...common('lifecycle-1'),
        operation: 'lifecycle',
        lifecycle: 'active',
        retentionAction: { kind: 'preserve' },
        quotaAction: { kind: 'preserve' },
        projectionIdsAction: { kind: 'preserve' },
    });
}

async function compactCommand() {
    return await createCrdtMutationCommand({
        ...common('compact-1'),
        operation: 'compact',
        snapshotId: 'snapshot-1',
        snapshot: null,
        reason: 'test',
    });
}

async function rebuildCommand() {
    return await createCrdtMutationCommand({
        ...common('rebuild-1'),
        operation: 'rebuild-projection',
        projectionId: 'default',
    });
}

function update(updateId: string): RallarCrdtUpdateEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: DOCUMENT,
        updateId,
        replicaId: 'replica-1',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 1_000,
        payload: {
            kind: 'batch',
            operations: [{
                kind: 'register.set',
                path: ['title'],
                policy: 'lww',
                value: updateId,
            }],
        },
    };
}

function metadata(): RallarCrdtDocumentMetadata {
    return {
        document: DOCUMENT,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        documentRevision: 3,
        lifecycle: 'active',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
        archivedAtEpochMs: null,
        destroyedAtEpochMs: null,
        lastAppendSequence: 2,
        updateCount: 2,
        snapshotCount: 0,
        storedUpdateBytes: 0,
        retention: null,
        quota: null,
        projectionIds: [],
    };
}

function emptyRead() {
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
            code: 'allowed' as const,
            reason: 'enabled',
            rollout: 'production' as const,
            retryable: false,
        },
        actorUpdatesInWindow: 0,
        storedSnapshotBytes: 0,
    };
}

function existingRead() {
    return { ...emptyRead(), document: metadata() };
}

function appendRejectionCodes(): readonly RallarCrdtAppendRejectionCode[] {
    return [
        'authorization-denied',
        'document-archived',
        'document-destroyed',
        'document-quarantined',
        'duplicate-hash-mismatch',
        'feature-disabled',
        'invalid-update',
        'quota-exceeded',
        'rate-limited',
        'schema-version-not-allowed',
        'update-too-large',
        'storage-failed',
    ];
}
