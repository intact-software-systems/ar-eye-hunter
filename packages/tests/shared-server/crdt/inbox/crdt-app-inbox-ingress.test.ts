import { describe, expect, it, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { RALLAR_CRDT_OPERATION_VERSION, RALLAR_CRDT_PROTOCOL_VERSION, type RallarCrdtDocumentRef, type RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';

import { AppCrdtInboxService, CRDT_APP_INBOX_TOPIC } from '@shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts';

import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';

type SqlValue = Parameters<PSqlSql>[0][number];

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' }
};

describe('CRDT production AppInbox ingress', () => {
    it('propagates a durable AppInbox enqueue failure to WS ingress', async () => {
        const reader = new CapturingInboxReader(true);
        const service = appCrdt(reader);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await expect(
                service.createAndEnqueueAppend(
                    input({ updateEnvelope: update('update-1'), receivedAtEpochMs: 1_000 })
                )
            ).rejects.toThrow('injected durable enqueue failure');
        }
        finally {
            error.mockRestore();
        }
    });

    it('uses trusted ingress time and a bounded expiry instead of update-authored time', async () => {
        const reader = new CapturingInboxReader(false);
        const service = appCrdt(reader);
        const semantic = update('stable-update');
        const deliveryId = 'legacy-crdt-delivery-abcdefghijklmnopqrstuvwxyz-0123456789';

        await service.createAndEnqueueAppend(
            input({ updateEnvelope: semantic, receivedAtEpochMs: 1_000, deliveryId })
        );
        await vi.waitFor(() => expect(reader.messages).toHaveLength(1));

        const command = JSON.parse(reader.messages[0]!.payload.resource).data;
        expect(reader.messages[0]!.route).toEqual({
            topicId: CRDT_APP_INBOX_TOPIC,
            resourceId: 'legacy-crdt-delivery-a-1bav1zw2g77k7',
            contextId: 'crdt-v1-app-1-workspac-7aih2jth9k1c'
        });
        expect(command.capturedAtEpochMs).toBe(1_000);
        expect(command.expireAtEpochMs).toBe(resourceInboxRetryExpiryAtEpochMs(1_000));
        expect(command.capturedAtEpochMs).not.toBe(semantic.createdAtEpochMs);
    });

    it(
        'gives reconnect delivery a new AppInbox identity while retaining ' + 'update replay identity',
        async () => {
            const reader = new CapturingInboxReader(false);
            const service = appCrdt(reader);
            const semantic = update('reconnect-update');

            await service.createAndEnqueueAppend(
                input({
                    updateEnvelope: semantic,
                    receivedAtEpochMs: 1_000,
                    sessionId: 'session-1',
                    deliveryId: 'delivery-1'
                })
            );
            await service.createAndEnqueueAppend(
                input({
                    updateEnvelope: semantic,
                    receivedAtEpochMs: 2_000,
                    sessionId: 'session-2',
                    deliveryId: 'delivery-2'
                })
            );
            await vi.waitFor(() => expect(reader.messages).toHaveLength(2));

            const commands = reader.messages.map((message) => JSON.parse(message.payload.resource).data);
            expect(commands[0].update.updateId).toBe(commands[1].update.updateId);
            expect(commands[0].commandId).toBe(commands[1].commandId);
            expect(commands[0].deliveryId).not.toBe(commands[1].deliveryId);
            expect(commands[0].actor.sessionId).not.toBe(commands[1].actor.sessionId);
        }
    );
});

class CapturingInboxReader extends InboxQueueReader {
    readonly messages: ALMessage[] = [];

    private readonly fail: boolean;

    constructor(fail: boolean) {
        super(new InMemoryQueueBox());
        this.fail = fail;
    }

    override async enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        this.messages.push(structuredClone(message));
        if (this.fail) {
            throw new Error('injected durable enqueue failure');
        }
        return await super.enqueueIfAbsent(message);
    }
}

function appCrdt(inbox: InboxQueueReader): AppCrdtInboxService {
    const database = createUnusedDatabase();
    const repository = {
        readMutation: () => Promise.reject(new Error('not processed')),
        writeMutation: () => Promise.reject(new Error('not processed')),
        writeOutbox: () => Promise.reject(new Error('not processed'))
    };
    return new AppCrdtInboxService(
        {
            inboxQueueReader: inbox,
            resourceInboxRepository: new ResourceInboxRepository(database),
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(database),
            database,
            mutationService: createCrdtMutationService({
                repository,
                createWriter: () => repository,
                serviceId: 'server-1'
            }),
            readCurrentSession: () => Promise.reject(new Error('not read')),
            wakeQueueEngine: () => undefined
        },
        { serviceId: 'server-1', timing: undefined, appInbox: {} }
    );
}

function createUnusedDatabase(): PSqlSql {
    function query<T>(_strings: TemplateStringsArray, ..._values: SqlValue[]): Promise<T>;
    function query(_values: readonly SqlValue[]): ReturnType<PSqlSql>;
    function query(): never {
        throw new Error('Unexpected SQL execution in ingress unit test');
    }
    return Object.assign(query, {
        begin: <T>(): Promise<T> => Promise.reject(new Error('Unexpected transaction in ingress unit test'))
    });
}

interface CrdtInboxInput {
    readonly updateEnvelope: RallarCrdtUpdateEnvelope;
    readonly receivedAtEpochMs: number;
    readonly sessionId?: string;
    readonly deliveryId?: string;
}

function input(input: CrdtInboxInput) {
    const {
        updateEnvelope,
        receivedAtEpochMs,
        sessionId = 'session-1',
        deliveryId = `delivery-${receivedAtEpochMs}`
    } = input;
    return {
        update: updateEnvelope,
        deliveryId,
        actor: { actorId: 'client-1', principalId: 'client-1', sessionId, serverId: 'server-1' },
        responseAudience: {
            kind: 'room' as const,
            senderSessionId: sessionId,
            topicId: 'room.crdt',
            contextId: 'group-1'
        },
        capturedAtEpochMs: receivedAtEpochMs,
        expireAtEpochMs: receivedAtEpochMs + 60_000
    };
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
        createdAtEpochMs: 900,
        payload: {
            kind: 'batch',
            operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: updateId }]
        }
    };
}
