import assert from 'node:assert/strict';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { RALLAR_CRDT_OPERATION_VERSION, RALLAR_CRDT_PROTOCOL_VERSION, type RallarCrdtDocumentRef, type RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';

import { ResourceInboxRepository } from '@shared-server/queuebox/postgres/resource-inbox-repository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';

import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';

import { CrdtMutationConflictError } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';

import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import { createApiCrdtInboxFactory } from '../../../src/crdt/create-api-crdt-inbox-factory.ts';
import { createApiCrdtInboxService } from '../../../src/crdt/create-api-crdt-inbox-service.ts';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { toResilienceDto } from '../../api-v1-test-queue-resilience.ts';
import { readPGliteDatabaseEpochMs, waitForPGliteQueueRow, withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' }
};

interface CrdtMutationRollbackCountsRow {
    readonly documents: string;
    readonly updates: string;
    readonly outbox: string;
    readonly results: string;
}

interface CrdtMutationCountsRow {
    readonly documents: string;
    readonly updates: string;
    readonly outbox: string;
}

interface ResourceInboxResultRow {
    readonly ris_resource: string;
}

interface ResourceInboxCompletionRow {
    readonly ris_status: string;
    readonly ris_resource: string;
}

Deno.test(
    'production CRDT factory fails closed when document policies are unavailable',
    async () => {
        await withPGliteSql(async (sql) => {
            const now = await pgliteQueueNow(sql);
            const service = productionService({ queueSql: sql, database: sql, now });
            const command = await appendCommand(now, 'policy-delivery', 'policy-update');
            const read = await service.mutationService.read(command);
            assert.equal(read.authorized, true);
            assert.equal(read.featureDecision.allowed, false);
        });
    }
);

Deno.test(
    'CRDT factory supplies current authority, exact policy, queue wake, and no audit pair',
    async () => {
        await withPGliteSql(async (sql) => {
            const now = await pgliteQueueNow(sql);
            const resourceInbox = new ResourceInboxRepository(sql);
            const queue = new PSqlQueueBox(resourceInbox);
            const authorityReads: string[] = [];
            let wakes = 0;
            const factory = createApiCrdtInboxFactory({
                resourceInboxRepository: resourceInbox,
                resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
                database: sql,
                serviceId: 'server-1',
                timing: undefined,
                options: { nowEpochMs: () => now },
                currentAuthority: {
                    readSession: (sessionId: string) => {
                        authorityReads.push(sessionId);
                        return Promise.resolve({
                            clientId: 'client-1',
                            username: 'client-1',
                            sessionId,
                            expiresAtEpochMs: now + 60_000
                        });
                    },
                    authorizeDocument: () => Promise.resolve({ allowed: true, code: 'allowed' }),
                    adminClientIds: []
                },
                policies: [{ documentType: 'checklist', rollout: 'production' }]
            });
            const outboxQueueReader = new RecordingOutboxQueueReader(queue);
            const service = factory({
                inboxQueueReader: new InboxQueueReader(queue),
                outboxQueueReader,
                appInboxResilience: toResilienceDto(),
                wakeQueueEngine: () => {
                    wakes += 1;
                }
            });
            const command = await appendCommand(now, 'factory-command', 'factory-update');

            const read = await service.mutationService.read(command);
            await service.createAndEnqueueAppend({
                update: update('factory-enqueue', now - 10_000),
                deliveryId: 'factory-delivery',
                actor: command.actor,
                responseAudience: command.responseAudience,
                capturedAtEpochMs: now,
                expireAtEpochMs: now + 60_000
            });

            assert.deepEqual(authorityReads, ['session-1']);
            assert.equal(read.authorized, true);
            assert.equal(read.featureDecision.rollout, 'production');
            assert.equal(wakes, 1);
            assert.deepEqual(outboxQueueReader.registeredTypes, []);
        });
    }
);

const FAILURE_STAGES = [
    'document',
    'record',
    'first-ws-outbox',
    'second-ws-outbox',
    'result',
    'completion'
] as const;

for (const stage of FAILURE_STAGES) {
    Deno.test(`production AppCrdt transaction rolls back at ${stage}`, async () => {
        await withPGliteSql(async (sql) => {
            const now = await pgliteQueueNow(sql);
            const database = withInjectedTransactionFailure(sql, stage);
            const service = productionService({ queueSql: sql, database, now, allow: true });
            await service.createAndEnqueueAppend({
                update: update(`${stage}-update`, now - 10_000),
                deliveryId: `${stage}-delivery`,
                actor: {
                    actorId: 'client-1',
                    principalId: 'client-1',
                    sessionId: 'session-1',
                    serverId: 'server-1'
                },
                responseAudience: {
                    kind: 'room',
                    senderSessionId: 'session-1',
                    topicId: 'room.crdt',
                    contextId: 'group-1'
                },
                capturedAtEpochMs: now,
                expireAtEpochMs: now + 60_000
            });
            await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
            await service.inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                toResilienceDto()
            );

            const [domain] = await sql<CrdtMutationRollbackCountsRow[]>`
        select
          (select count(*) from crdt_documents)::text as documents,
          (select count(*) from crdt_updates)::text as updates,
          (select count(*) from resource_inbox where ri_type_id = 'WS_OUTBOX')::text as outbox,
          (select count(*)
            from resource_inbox_results
            where ris_topic_id = 'app-inbox.crdt-state')::text as results
      `;
            assert.deepEqual(domain, { documents: '0', updates: '0', outbox: '0', results: '0' });
        });
    });
}

Deno.test(
    'production AppCrdt accepts a new session replay and rejects changed-content collision',
    async () => {
        await withPGliteSql(async (sql) => {
            const now = await pgliteQueueNow(sql);
            const service = productionService({ queueSql: sql, database: sql, now, allow: true });
            const original = update('shared-update', now - 10_000, 'original');

            await enqueueAndDrain({
                service,
                envelope: original,
                deliveryId: 'session-1:delivery-1',
                sessionId: 'session-1',
                capturedAtEpochMs: now
            });
            await enqueueAndDrain({
                service,
                envelope: original,
                deliveryId: 'session-2:delivery-2',
                sessionId: 'session-2',
                capturedAtEpochMs: now + 1
            });
            await enqueueAndDrain({
                service,
                envelope: update('shared-update', now - 10_000, 'changed'),
                deliveryId: 'session-3:delivery-3',
                sessionId: 'session-3',
                capturedAtEpochMs: now + 2
            });

            const [counts] = await sql<CrdtMutationCountsRow[]>`
      select
        (select count(*) from crdt_documents)::text as documents,
        (select count(*) from crdt_updates)::text as updates,
        (select count(*) from resource_inbox where ri_type_id = 'WS_OUTBOX')::text as outbox
    `;
            assert.deepEqual(counts, { documents: '1', updates: '1', outbox: '4' });
            const results = await sql<ResourceInboxResultRow[]>`
      select ris_resource from resource_inbox_results
      where ris_topic_id = 'app-inbox.crdt-state'
      order by ris_row_id
    `;
            assert.deepEqual(
                results.map((row) => {
                    const result = decodeCrdtMutationResult(JSON.parse(row.ris_resource));
                    return { status: result.status, code: result.code };
                }),
                [
                    { status: 'accepted', code: null },
                    { status: 'replay', code: null },
                    { status: 'rejected', code: 'duplicate-hash-mismatch' }
                ]
            );
        });
    }
);

Deno.test(
    'production AppInbox retries a CRDT conflict from a fresh revoked authority read',
    async () => {
        await withPGliteSql(async (sql) => {
            const now = await pgliteQueueNow(sql);
            let allowed = true;
            const database = withOneCrdtConflict(sql, () => {
                allowed = false;
            });
            const service = productionService({
                queueSql: sql,
                database,
                now,
                allow: true,
                isAllowed: () => allowed
            });

            await enqueueAndDrain({
                service,
                envelope: update('revoked-update', now - 10_000),
                deliveryId: 'revoked-delivery',
                sessionId: 'session-1',
                capturedAtEpochMs: now
            });

            const [counts] = await sql<CrdtMutationCountsRow[]>`
      select
        (select count(*) from crdt_documents)::text as documents,
        (select count(*) from crdt_updates)::text as updates,
        (select count(*) from resource_inbox where ri_type_id = 'WS_OUTBOX')::text as outbox
    `;
            assert.deepEqual(counts, { documents: '0', updates: '0', outbox: '0' });
            const [completion] = await sql<ResourceInboxCompletionRow[]>`
      select ris_status, ris_resource from resource_inbox_results
      where ris_topic_id = 'app-inbox.crdt-state'
        and ris_resource_id = 'revoked-delivery'
    `;
            assert.ok(completion);
            assert.equal(completion.ris_status, 'COMPLETED');
            const result = decodeCrdtMutationResult(JSON.parse(completion.ris_resource));
            assert.equal(result.status, 'rejected');
            assert.equal(result.code, 'authorization-denied');
        });
    }
);

interface ProductionServiceInput {
    readonly queueSql: PSqlSql;
    readonly database: PSqlSql;
    readonly now: number;
    readonly allow?: boolean;
    readonly isAllowed?: () => boolean;
}

function productionService(input: ProductionServiceInput) {
    const { queueSql, database, now, allow = false, isAllowed = () => true } = input;
    const resourceInbox = new ResourceInboxRepository(queueSql);
    const inboxQueueReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    const service = createApiCrdtInboxService({
        inboxQueueReader,
        resourceInboxRepository: resourceInbox,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(queueSql),
        database,
        serviceId: 'server-1',
        timing: undefined,
        options: { nowEpochMs: () => now },
        wakeQueueEngine: () => undefined,
        currentAuthority: {
            readSession: (sessionId: string) =>
                Promise.resolve({
                    clientId: 'client-1',
                    username: 'client-1',
                    sessionId,
                    expiresAtEpochMs: now + 60_000
                }),
            authorizeDocument: () =>
                Promise.resolve({
                    allowed: isAllowed(),
                    code: isAllowed() ? 'allowed' : 'authorization-denied'
                }),
            adminClientIds: ['client-1']
        },
        policies: allow
            ? [{ documentType: 'checklist', rollout: 'production' }]
            : [{ documentType: '*', rollout: 'disabled' }]
    });
    return Object.assign(service, { inboxQueueReader });
}

async function appendCommand(now: number, commandId: string, updateId: string) {
    return await createCrdtMutationCommand({
        operation: 'append',
        commandId,
        actor: {
            actorId: 'client-1',
            principalId: 'client-1',
            sessionId: 'session-1',
            serverId: 'server-1'
        },
        capturedAtEpochMs: now,
        expireAtEpochMs: now + 60_000,
        document: DOCUMENT,
        responseAudience: {
            kind: 'room',
            senderSessionId: 'session-1',
            topicId: 'room.crdt',
            contextId: 'group-1'
        },
        authorizationScope: 'room',
        update: update(updateId, now - 10_000)
    });
}

function update(
    updateId: string,
    createdAtEpochMs: number,
    value = updateId
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
        createdAtEpochMs,
        payload: {
            kind: 'batch',
            operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value }]
        }
    };
}

async function pgliteQueueNow(sql: PGliteSql): Promise<number> {
    return await readPGliteDatabaseEpochMs(sql) + 12 * 60 * 60 * 1_000;
}

interface EnqueueAndDrainInput {
    readonly service: ReturnType<typeof productionService>;
    readonly envelope: RallarCrdtUpdateEnvelope;
    readonly deliveryId: string;
    readonly sessionId: string;
    readonly capturedAtEpochMs: number;
}

async function enqueueAndDrain(input: EnqueueAndDrainInput): Promise<void> {
    const { service, envelope, deliveryId, sessionId, capturedAtEpochMs } = input;
    await service.createAndEnqueueAppend({
        update: envelope,
        deliveryId,
        actor: {
            actorId: 'client-1',
            principalId: 'client-1',
            sessionId,
            serverId: 'server-1'
        },
        responseAudience: {
            kind: 'room',
            senderSessionId: sessionId,
            topicId: 'room.crdt',
            contextId: 'group-1'
        },
        capturedAtEpochMs,
        expireAtEpochMs: capturedAtEpochMs + 60_000
    });
    await service.inboxQueueReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto()
    );
}

function withOneCrdtConflict(database: PSqlSql, onConflict: () => void): PSqlSql {
    let injected = false;
    return new Proxy(database, {
        apply: (_target, _thisArgument, argumentsList) => executeSql(database, argumentsList[0], argumentsList.slice(1)),
        get: (target, property, receiver) => {
            if (property !== 'begin') {
                return Reflect.get(target, property, receiver);
            }
            return async <T>(write: (transaction: PSqlSql) => Promise<T>) =>
                await database.begin(async (transaction) => {
                    const conflicting = new Proxy(transaction, {
                        apply: (_transaction, _thisArgument, argumentsList) => {
                            const parts = argumentsList[0];
                            const values = argumentsList.slice(1);
                            const text = isTemplateStringsArray(parts) ? parts.join(' ') : '';
                            if (!injected && text.includes('insert into crdt_documents')) {
                                injected = true;
                                onConflict();
                                throw new CrdtMutationConflictError('injected-document');
                            }
                            return executeSql(transaction, parts, values);
                        }
                    });
                    return await write(conflicting);
                });
        }
    });
}

function withInjectedTransactionFailure(
    database: PSqlSql,
    stage: typeof FAILURE_STAGES[number]
): PSqlSql {
    return new Proxy(database, {
        apply: (_target, _thisArgument, argumentsList) => executeSql(database, argumentsList[0], argumentsList.slice(1)),
        get: (target, property, receiver) => {
            if (property !== 'begin') {
                return Reflect.get(target, property, receiver);
            }
            return async <T>(write: (transaction: PSqlSql) => Promise<T>) =>
                await database.begin(async (transaction) => {
                    let wsOutboxWrites = 0;
                    const failing = new Proxy(transaction, {
                        apply: (_transaction, _thisArgument, argumentsList) => {
                            const parts = argumentsList[0];
                            const values = argumentsList.slice(1);
                            const text = isTemplateStringsArray(parts) ? parts.join(' ') : '';
                            if (text.includes('insert into resource_inbox') && values.includes('WS_OUTBOX')) {
                                wsOutboxWrites += 1;
                            }
                            const fail = (stage === 'document' && text.includes('insert into crdt_documents')) ||
                                (stage === 'record' && text.includes('insert into crdt_updates')) ||
                                (stage === 'first-ws-outbox' && wsOutboxWrites === 1) ||
                                (stage === 'second-ws-outbox' && wsOutboxWrites === 2) ||
                                (stage === 'result' && text.includes('insert into resource_inbox_results')) ||
                                (stage === 'completion' && text.includes('update resource_inbox') &&
                                    text.includes('ri_status = \'RESERVED\''));
                            if (fail) {
                                throw new Error(`injected ${stage} failure`);
                            }
                            return executeSql(transaction, parts, values);
                        }
                    });
                    return await write(failing);
                });
        }
    });
}

function executeSql(
    sql: PSqlSql,
    parts: unknown,
    values: readonly unknown[]
): object | Promise<object> {
    requirePSqlParameters(values);
    if (isTemplateStringsArray(parts)) {
        return sql<object>(parts, ...values);
    }
    requirePSqlParameters(parts);
    return sql(parts);
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
    return Array.isArray(value) && 'raw' in value;
}

function requirePSqlParameters(
    value: unknown
): asserts value is readonly PSqlParameter[] {
    if (
        !Array.isArray(value) ||
        !value.every((candidate) =>
            candidate === null || candidate === undefined ||
            ['string', 'number', 'boolean', 'bigint', 'object'].includes(typeof candidate)
        )
    ) {
        throw new TypeError('Expected a current PSql parameter list');
    }
}

class RecordingOutboxQueueReader extends OutboxQueueReader {
    readonly registeredTypes: string[] = [];

    override onOutboxMessageDo(type: string, _callback: OnMessageCallback): this {
        this.registeredTypes.push(type);
        return this;
    }
}
