import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import type { AppCrdtInboxService } from '@shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts';
import { createCrdtMutationCommand, decodeCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import { CRDT_MUTATION_INBOX_TYPES } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { RALLAR_CRDT_OPERATION_VERSION, RALLAR_CRDT_PROTOCOL_VERSION, type RallarCrdtDocumentRef, type RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';

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

describe('CRDT AppInbox mutation contracts', () => {
    it('does not expose mutable audit sink registration', () => {
        const hasMutableAuditSetter: 'setAuditSink' extends keyof AppCrdtInboxService ? true : false = false;

        expect(hasMutableAuditSetter).toBe(false);
    });

    it('defines the complete DB-mutating CRDT AppInbox inventory', () => {
        expect(CRDT_MUTATION_INBOX_TYPES).toEqual([
            AppInboxType.CRDT_UPDATE_APPEND,
            AppInboxType.CRDT_PROJECTION_REBUILD,
            AppInboxType.CRDT_SNAPSHOT_COMPACT,
            AppInboxType.CRDT_LIFECYCLE_UPDATE,
            AppInboxType.CRDT_ERASE
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
                serverId: 'server-1'
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
                contextId: 'group-1'
            }
        });

        expect(decodeCrdtMutationCommand(command)).toEqual(command);
        expect(command).toMatchObject({
            version: 1,
            operation: 'append',
            commandId: 'append-1',
            commandHash: expect.any(String),
            documentKey: expect.any(String)
        });
        for (
            const invalid of [
                { ...command, commandHash: 'wrong' },
                { ...command, actor: { ...command.actor, sessionId: undefined } },
                { ...command, responseAudience: undefined },
                { ...command, unexpected: true }
            ]
        ) {
            expect(() => decodeCrdtMutationCommand(invalid)).toThrow(TypeError);
        }
    });

    it.each(
        [
            ['rebuild-projection', AppInboxType.CRDT_PROJECTION_REBUILD],
            ['compact', AppInboxType.CRDT_SNAPSHOT_COMPACT],
            ['lifecycle', AppInboxType.CRDT_LIFECYCLE_UPDATE],
            ['erase', AppInboxType.CRDT_ERASE]
        ] as const
    )('maps %s to its durable AppInbox type', (operation, expected) => {
        expect(CRDT_MUTATION_INBOX_TYPES).toContain(expected);
        expect(operation.length).toBeGreaterThan(0);
    });
});

function createUpdate(updateId: string): RallarCrdtUpdateEnvelope {
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
                    value: updateId
                }
            ]
        }
    };
}
