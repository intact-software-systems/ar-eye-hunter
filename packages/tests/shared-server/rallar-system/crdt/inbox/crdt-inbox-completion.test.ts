import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { computeCrdtInboxMutation, validateCrdtInboxMutation } from '@shared-server/rallar-system/crdt/inbox/compute-crdt-inbox-mutation.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import type { CrdtMutationRead } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { writePSqlCrdtMutation } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts';
import { RALLAR_CRDT_OPERATION_VERSION, RALLAR_CRDT_PROTOCOL_VERSION } from '@shared/crdt/mod.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

describe('CRDT inbox completion candidate', () => {
    it('computes append state, outbox and completion from explicit facts', async () => {
        const read = await createRead();
        const computed = computeCrdtInboxMutation(read);

        expect(computed.mutation).toMatchObject({ outcome: 'write', document: { documentRevision: 1, updateCount: 1 } });
        expect(computed.mutation.outboxEntries).toHaveLength(2);
        expect(computed.mutation).toHaveProperty('documentWrite');
        expect(computed.mutation).toHaveProperty('updateWrite');
        expect(computed.mutation).toHaveProperty('outboxWrites');
        expect(Reflect.get(computed.mutation, 'outboxWrites')).toHaveLength(2);
        if (computed.mutation.outcome !== 'write' || read.command.operation !== 'append') {
            throw new Error('Expected an accepted CRDT append');
        }
        expect(computed.mutation.documentWrite).toMatchObject({
            operation: 'insert',
            documentRefJson: JSON.stringify(read.command.document),
            createdAt: new Date(read.command.capturedAtEpochMs),
            updatedAt: new Date(read.command.capturedAtEpochMs),
            projectionIdsJson: '[]'
        });
        expect(computed.mutation.updateWrite).toMatchObject({
            updateEnvelopeJson: JSON.stringify(read.command.update),
            acceptedAt: new Date(read.command.capturedAtEpochMs)
        });
        expect(computed.mutation.outboxWrites.map(({ entry }) => entry)).toEqual(computed.mutation.outboxEntries);
        expect(computed.mutation.conflict).toMatchObject({
            name: 'CrdtMutationConflictError',
            documentKey: read.command.documentKey
        });
        expect(computed.completion.durableResult).toBe(computed.mutation.result);
        expect(computed.completion.reservationFinish.completedAt).toEqual(new Date(1_010));
        expect(validateCrdtInboxMutation(read, computed)).toEqual([]);
    });

    it('preserves rejected and replay results while validating exact domain and completion candidates', async () => {
        const read = await createRead();
        const accepted = computeCrdtInboxMutation(read);
        const replayRead = {
            ...read,
            read: {
                ...read.read,
                document: accepted.mutation.document,
                existingUpdate: read.command.operation === 'append' ? read.command.update : null,
                existingAppend: accepted.mutation.append
            }
        };
        const replay = computeCrdtInboxMutation(replayRead);
        expect(replay.mutation.outcome).toBe('replay');
        expect(replay.completion.durableResult.status).toBe('replay');
        expect(validateCrdtInboxMutation(replayRead, replay)).toEqual([]);
        const deniedRead = { ...read, read: { ...read.read, authorized: false, authorizationCode: 'authorization-denied' } };
        const denied = computeCrdtInboxMutation(deniedRead);
        expect(denied.mutation.outcome).toBe('rejected');
        expect(denied.completion.durableResult.status).toBe('rejected');
        expect(validateCrdtInboxMutation(deniedRead, denied)).toEqual([]);
        const changed = { ...accepted, mutation: { ...accepted.mutation, outboxEntries: [] } };
        expect(validateCrdtInboxMutation(read, changed).length).toBeGreaterThan(0);
        expect(changed.mutation.outboxEntries).toEqual([]);
        expect(
            validateCrdtInboxMutation(read, {
                ...accepted,
                completion: { ...accepted.completion, encodedResult: null }
            }).length
        ).toBeGreaterThan(0);
    });

    it('returns an issue for incomplete persisted replay facts without mutating either input', async () => {
        const original = await createRead();
        const computed = computeCrdtInboxMutation(original);
        const read = {
            ...original,
            read: { ...original.read, existingUpdate: computed.mutation.update }
        };

        expect(validateCrdtInboxMutation(read, computed)).toEqual([{
            code: 'computed-value-invalid',
            message: 'Persisted CRDT replay requires document and append metadata'
        }]);
        expect(read.read.document).toBeNull();
        expect(read.read.existingAppend).toBeNull();
        expect(computed.mutation.outcome).toBe('write');
        expect(computed.mutation.outboxEntries).toHaveLength(2);
    });

    it('rejects hidden missing outbox writes without invoking a serialization callback', async () => {
        const read = await createRead();
        const computed = computeCrdtInboxMutation(read);
        let callbackCalls = 0;
        const candidate = {
            ...computed,
            mutation: {
                ...computed.mutation,
                outboxWrites: [],
                toJSON: () => {
                    callbackCalls += 1;
                    return computed.mutation;
                }
            }
        };

        const issues = validateCrdtInboxMutation(read, candidate);

        expect.soft(callbackCalls).toBe(0);
        expect.soft(issues.length).toBeGreaterThan(0);
        expect(candidate.mutation.outboxWrites).toHaveLength(0);
    });

    it('binds computed persistence values without serializing after transaction entry', async () => {
        const read = await createRead();
        const computed = computeCrdtInboxMutation(read);
        expect(validateCrdtInboxMutation(read, computed)).toEqual([]);
        const statements: string[] = [];
        const transaction = createCrdtWriteTransaction(statements);
        const serialize = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
            throw new Error('CRDT serialization ran during write');
        });

        try {
            await expect(writePSqlCrdtMutation(transaction, computed.mutation)).resolves.toBe(
                computed.mutation.result
            );
        }
        finally {
            serialize.mockRestore();
        }

        expect(statements.filter((statement) => statement.includes('insert into crdt_documents'))).toHaveLength(1);
        expect(statements.filter((statement) => statement.includes('insert into crdt_updates'))).toHaveLength(1);
        expect(statements.filter((statement) => statement.includes('insert into resource_inbox'))).toHaveLength(2);
    });

    it.each(['candidate', 'mutation', 'completion'] as const)('rejects a %s Proxy without invoking its traps', async (placement) => {
        const read = await createRead();
        const computed = computeCrdtInboxMutation(read);
        let trapCalls = 0;
        const inspect = (): never => {
            trapCalls += 1;
            throw new Error('Candidate inspection must not invoke Proxy traps');
        };
        const traps = { get: inspect, getPrototypeOf: inspect, ownKeys: inspect, getOwnPropertyDescriptor: inspect };
        const candidate = placement === 'candidate'
            ? new Proxy(computed, traps)
            : { ...computed, [placement]: new Proxy(computed[placement], traps) };

        expect(validateCrdtInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(trapCalls).toBe(0);
    });
});

async function createRead() {
    const document = {
        applicationId: 'app',
        workspaceId: 'workspace',
        scope: 'room' as const,
        documentType: 'checklist',
        documentId: 'document',
        roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'group' }
    };
    const command = await createCrdtMutationCommand({
        operation: 'append',
        commandId: 'append',
        deliveryId: 'delivery',
        document,
        actor: { actorId: 'actor', principalId: 'principal', sessionId: 'session', serverId: 'server' },
        capturedAtEpochMs: 1_000,
        expireAtEpochMs: 100_000,
        authorizationScope: 'room',
        responseAudience: { kind: 'room', senderSessionId: 'session', topicId: 'room.crdt', contextId: 'group' },
        update: {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document,
            updateId: 'update',
            replicaId: 'replica',
            lamport: 1,
            parents: [],
            schemaVersion: 1,
            operationVersion: RALLAR_CRDT_OPERATION_VERSION,
            createdAtEpochMs: 900,
            payload: { kind: 'batch', operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: 'title' }] }
        }
    });
    const read: CrdtMutationRead = {
        document: null,
        existingUpdate: null,
        existingAppend: null,
        records: [],
        snapshot: null,
        authorized: true,
        authorizationCode: 'allowed',
        actorUpdatesInWindow: 0,
        storedSnapshotBytes: 0,
        featureDecision: { allowed: true, code: 'allowed', reason: 'test', rollout: 'production', retryable: false }
    };
    return { command, read, serviceId: 'server', completionFacts: { entry: createEntry(), completedAtEpochMs: 1_010 } };
}

function createEntry(): ResourceEntry {
    return {
        key: { topicId: 'app-inbox.crdt-state', resourceId: 'delivery', contextId: 'document' },
        resource: '{}',
        typeId: 'APP_INBOX',
        status: EntityStatus.RESERVED,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'server',
            createdTs: Temporal.PlainDateTime.from('2026-08-07T12:00:00'),
            expiryTs: Temporal.Instant.from('2026-08-07T13:00:00Z')
        },
        dequeueAudit: { attempts: 1 }
    };
}

function createCrdtWriteTransaction(statements: string[]): PSqlSql {
    const transaction = (async <Result>(strings: TemplateStringsArray): Promise<Result> => {
        const statement = strings.join(' ');
        statements.push(statement);
        if (statement.includes('insert into crdt_documents')) {
            return [{ document_key: 'document' }] as Result;
        }
        if (statement.includes('insert into resource_inbox')) {
            return [{ ri_row_id: 1n }] as Result;
        }
        return [] as Result;
    }) as PSqlSql;
    transaction.begin = async () => {
        throw new Error('CRDT writes must use the caller transaction');
    };
    return transaction;
}
