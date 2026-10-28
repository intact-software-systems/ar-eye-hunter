import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import type {
    PSqlParameter,
    PSqlSql
} from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import {
    toDomain,
    type ResourceInboxRow
} from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import type { AppCrdtInboxService } from '@shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts';
import {
    CrdtMutationConflictError,
    type CrdtMutationResult
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentRef,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { createApiCrdtInboxFactory } from '../../../src/crdt/create-api-crdt-inbox-factory.ts';
import { createApiCrdtInboxService } from '../../../src/crdt/create-api-crdt-inbox-service.ts';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { createApiV1TestQueueResilience } from '../../api-v1-test-queue-resilience.ts';
import {
    waitForPGliteFirstRetryEligibility,
    waitForPGliteQueueRow
} from '../../db/pglite-app-inbox-test-runtime.ts';
import {
    readPGliteDatabaseEpochMs,
    withPGliteSql
} from '../../db/pglite-auth-test-harness.ts';
import { authorizeTestCrdtCommand } from '../crdt-api-test-fixtures.ts';

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
            const { service, inboxQueueReader } = createProductionCrdtInboxHarness({ queueSql: sql, database: sql, now });
            await service.createAndEnqueueAppend({
                update: update('policy-update', now - 10_000),
                deliveryId: 'policy-delivery',
                traceId: 'trace-crdt-production-inbox-policy',
                actor: { actorId: 'client-1', principalId: 'client-1', sessionId: 'session-1', serverId: 'server-1' },
                responseAudience: { kind: 'room', senderSessionId: 'session-1', topicId: 'room.crdt', contextId: 'group-1' },
                capturedAtEpochMs: now,
                expireAtEpochMs: now + 60_000
            });
            await drainCrdtInbox(sql, inboxQueueReader);

            const result = await readCrdtResult(sql, 'policy-delivery');
            assert.equal(result.status, 'rejected');
            assert.equal(result.code, 'feature-disabled');
        });
    }
);

Deno.test(
    'CRDT factory supplies current authority, exact policy, queue wake, and no audit pair',
    async () => {
        await withPGliteSql(async (sql) => {
            const now = await pgliteQueueNow(sql);
            const resourceInbox = createPSqlResourceInboxRepository(sql, () => new Date());
            const queue = new PSqlQueueBox(resourceInbox, Temporal.Now.instant);
            const authorityReads: string[] = [];
            let wakes = 0;
            const factory = createApiCrdtInboxFactory({
                finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
                resourceInboxRepository: resourceInbox.entries,
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
                    authorizeDocument: authorizeTestCrdtCommand,
                    adminClientIds: []
                },
                policies: [{ documentType: 'checklist', rollout: 'production' }]
            });
            const outboxQueueReader = new RecordingOutboxQueueReader(queue);
            const inboxQueueReader = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
            const service = factory({
                inboxQueueReader,
                outboxQueueReader,
                appInboxResilience: createApiV1TestQueueResilience(),
                wakeQueueEngine: () => {
                    wakes += 1;
                }
            });
            await service.createAndEnqueueAppend({
                update: update('factory-enqueue', now - 10_000),
                deliveryId: 'factory-delivery',
                traceId: 'trace-crdt-production-inbox',
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
            await drainCrdtInbox(sql, inboxQueueReader);

            assert.deepEqual(authorityReads, ['session-1']);
            assert.equal((await readCrdtResult(sql, 'factory-delivery')).status, 'accepted');
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
            const { service, inboxQueueReader } = createProductionCrdtInboxHarness({ queueSql: sql, database, now, allow: true });
            await service.createAndEnqueueAppend({
                update: update(`${stage}-update`, now - 10_000),
                deliveryId: `${stage}-delivery`,
                traceId: 'trace-crdt-production-inbox',
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
            await drainCrdtInbox(sql, inboxQueueReader);

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
            const { service, inboxQueueReader } = createProductionCrdtInboxHarness({ queueSql: sql, database: sql, now, allow: true });
            const original = update('shared-update', now - 10_000, 'original');

            await enqueueAndDrain({
                sql,
                service,
                inboxQueueReader,
                envelope: original,
                deliveryId: 'session-1:delivery-1',
                sessionId: 'session-1',
                capturedAtEpochMs: now
            });
            await enqueueAndDrain({
                sql,
                service,
                inboxQueueReader,
                envelope: original,
                deliveryId: 'session-2:delivery-2',
                sessionId: 'session-2',
                capturedAtEpochMs: now + 1
            });
            await enqueueAndDrain({
                sql,
                service,
                inboxQueueReader,
                envelope: update('shared-update', now - 10_000, 'changed'),
                deliveryId: 'session-3:delivery-3',
                sessionId: 'session-3',
                capturedAtEpochMs: now + 2
            });

            const counts = await readCrdtMutationCounts(sql);
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
            const authorizationDecisions: boolean[] = [];
            const database = withOneCrdtConflict(sql, () => {
                allowed = false;
            });
            const { service, inboxQueueReader } = createProductionCrdtInboxHarness({
                queueSql: sql,
                database,
                now,
                allow: true,
                isAllowed: () => {
                    authorizationDecisions.push(allowed);
                    return allowed;
                }
            });

            await enqueueAndDrain({
                sql,
                service,
                inboxQueueReader,
                envelope: update('revoked-update', now - 10_000),
                deliveryId: 'revoked-delivery',
                sessionId: 'session-1',
                capturedAtEpochMs: now
            });

            const key = toAppQueueKey({
                topicId: 'app-inbox.crdt-state',
                resourceId: 'revoked-delivery',
                contextId: toRallarCrdtDocumentKey(DOCUMENT)
            });
            const afterFirst = await readCrdtInboxJob(sql, key);
            assert.deepEqual(await readCrdtMutationCounts(sql), { documents: '0', updates: '0', outbox: '0' });
            if (afterFirst.status === EntityStatus.RETRY) {
                assert.equal(afterFirst.dequeueAudit.attempts, 1);
                assert.ok(afterFirst.dequeueAudit.nextTs);
                assert.equal(await readCrdtCompletion(sql, key), undefined);
                assert.deepEqual(authorizationDecisions, [true]);
                await waitForPGliteFirstRetryEligibility(sql, key);
                await inboxQueueReader.dequeueInbox(
                    InboxQueueReader.INBOX_DEQUEUE_TYPES,
                    createApiV1TestQueueResilience()
                );
            }
            else {
                assert.equal(afterFirst.status, EntityStatus.COMPLETED);
            }

            const finalized = await readCrdtInboxJob(sql, key);
            assert.equal(finalized.status, EntityStatus.COMPLETED);
            assert.equal(finalized.dequeueAudit.attempts, 2);
            assert.deepEqual(authorizationDecisions, [true, false]);
            assert.deepEqual(await readCrdtMutationCounts(sql), { documents: '0', updates: '0', outbox: '0' });
            const completion = await readCrdtCompletion(sql, key);
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

interface ProductionCrdtInboxHarness {
    readonly service: AppCrdtInboxService;
    readonly inboxQueueReader: InboxQueueReader;
}

function createProductionCrdtInboxHarness(input: ProductionServiceInput): ProductionCrdtInboxHarness {
    const { queueSql, database, now, allow = false, isAllowed = () => true } = input;
    const resourceInbox = createPSqlResourceInboxRepository(queueSql, () => new Date(now));
    const inboxQueueReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant), {
        newLaneConcurrency: 1
    });
    const service = createApiCrdtInboxService({
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        inboxQueueReader,
        resourceInboxRepository: resourceInbox.entries,
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
            authorizeDocument: (command) =>
                isAllowed()
                    ? authorizeTestCrdtCommand(command)
                    : Promise.resolve({ allowed: false, code: 'authorization-denied', publicationAuthority: null }),
            adminClientIds: ['client-1']
        },
        policies: allow
            ? [{ documentType: 'checklist', rollout: 'production' }]
            : [{ documentType: '*', rollout: 'disabled' }]
    });
    return { service, inboxQueueReader };
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
    readonly sql: PGliteSql;
    readonly service: AppCrdtInboxService;
    readonly inboxQueueReader: InboxQueueReader;
    readonly envelope: RallarCrdtUpdateEnvelope;
    readonly deliveryId: string;
    readonly sessionId: string;
    readonly capturedAtEpochMs: number;
}

async function enqueueAndDrain(input: EnqueueAndDrainInput): Promise<void> {
    const { sql, service, inboxQueueReader, envelope, deliveryId, sessionId, capturedAtEpochMs } = input;
    await service.createAndEnqueueAppend({
        update: envelope,
        deliveryId,
        traceId: 'trace-crdt-production-inbox',
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
    await drainCrdtInbox(sql, inboxQueueReader);
}

async function drainCrdtInbox(
    sql: PGliteSql,
    inboxQueueReader: InboxQueueReader
): Promise<void> {
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxQueueReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createApiV1TestQueueResilience()
    );
}

async function readCrdtInboxJob(sql: PGliteSql, key: Key): Promise<ResourceEntry> {
    const rows = await sql<ResourceInboxRow[]>`
        select * from resource_inbox where ri_topic_id = ${key.topicId}
        and ri_resource_id = ${key.resourceId} and fk_ext_bank_id = ${key.contextId}
    `;
    assert.equal(rows.length, 1);
    return toDomain(rows[0]!);
}

async function readCrdtCompletion(sql: PGliteSql, key: Key): Promise<ResourceInboxCompletionRow | undefined> {
    const rows = await sql<ResourceInboxCompletionRow[]>`
        select ris_status, ris_resource from resource_inbox_results where ris_topic_id = ${key.topicId}
        and ris_resource_id = ${key.resourceId} and fk_ext_bank_id = ${key.contextId}
    `;
    assert.ok(rows.length <= 1);
    return rows[0];
}

async function readCrdtMutationCounts(sql: PGliteSql): Promise<CrdtMutationCountsRow> {
    const [counts] = await sql<CrdtMutationCountsRow[]>`
        select (select count(*) from crdt_documents)::text as documents,
        (select count(*) from crdt_updates)::text as updates,
        (select count(*) from resource_inbox where ri_type_id = 'WS_OUTBOX')::text as outbox
    `;
    assert.ok(counts);
    return counts;
}

async function readCrdtResult(
    sql: PGliteSql,
    deliveryId: string
): Promise<CrdtMutationResult> {
    const [row] = await sql<ResourceInboxResultRow[]>`
      select ris_resource from resource_inbox_results
      where ris_topic_id = 'app-inbox.crdt-state'
        and ris_resource_id = ${deliveryId}
    `;
    assert.ok(row);
    return decodeCrdtMutationResult(JSON.parse(row.ris_resource));
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
                            if (isWsOutboxInsert(text, values)) {
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

/** The CRDT write inserts each outbox row with its own statement, whose rows travel as one recordset parameter. */
function isWsOutboxInsert(text: string, values: readonly PSqlParameter[]): boolean {
    return text.includes('insert into resource_inbox') &&
        values.some((value) =>
            Array.isArray(value) &&
            value.some((row) => typeof row === 'object' && row !== null && 'typeId' in row && row.typeId === 'WS_OUTBOX')
        );
}

function executeSql(
    sql: PSqlSql,
    parts: TemplateStringsArray | readonly PSqlParameter[],
    values: readonly PSqlParameter[]
): object | Promise<object> {
    if (isTemplateStringsArray(parts)) {
        return sql<object>(parts, ...values);
    }
    return sql(parts);
}

function isTemplateStringsArray(
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return Array.isArray(value) && 'raw' in value;
}

class RecordingOutboxQueueReader extends OutboxQueueReader {
    readonly registeredTypes: string[] = [];

    override onOutboxMessageDo(type: string, _callback: OnMessageCallback): this {
        this.registeredTypes.push(type);
        return this;
    }
}
