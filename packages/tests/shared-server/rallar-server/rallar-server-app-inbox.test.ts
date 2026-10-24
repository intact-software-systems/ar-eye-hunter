import { Temporal } from '@js-temporal/polyfill';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RallarServerAppInbox, type AppInboxMessageContext, type JsonWireValue, type PSqlSql } from '@shared-server/mod.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { createAppInboxRetryFinalizer } from '@shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts';
import { computeAppOutboxInsert, writeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';

interface StockCommand {
    readonly warehouse: string;
    readonly requestId: string;
    readonly quantity: number;
    readonly capturedAt: number | null;
}

const COMMAND: StockCommand = { warehouse: 'warehouse-1', requestId: 'request-1', quantity: 3, capturedAt: null };
const TYPE = 'app:inventory:reserve';

let storage: ResourceInboxTestStorage;
beforeEach(async () => {
    storage = await createResourceInboxTestStorage('public_app_inbox', 4);
    await storage.sql`create table inventory (warehouse text primary key, quantity integer not null, revision integer not null)`;
    await storage.sql`insert into inventory values ('warehouse-1', 10, 0)`;
});
afterEach(async () => await storage?.close());

describe('public application AppInbox', () => {
    it('commits exact results and replays the winner without recapturing facts', async () => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();
        const first = await drain(harness.reader, operation.submit(COMMAND));
        expect(first).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(await operation.readReplay(COMMAND)).toEqual(first);
        expect(await operation.submit(COMMAND)).toEqual(first);
        expect(harness.facts).toEqual([101]);
        expect(harness.afterCommit).toEqual([7]);
        expect(await storage.sql`select quantity, revision from inventory`).toEqual([{ quantity: 7, revision: 1 }]);
    });

    it('rejects conflicting semantics before winner capture and binds scope to the durable key', async () => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();
        await drain(harness.reader, operation.submit(COMMAND));
        await expect(operation.readReplay({ ...COMMAND, quantity: 4 })).rejects.toMatchObject({ code: 'app-inbox-idempotency-conflict' });
        await expect(operation.submit({ ...COMMAND, quantity: 4 })).rejects.toMatchObject({ code: 'app-inbox-idempotency-conflict' });
        expect(harness.facts).toEqual([101]);
        await storage.sql`update resource_inbox set fk_ext_bank_id = 'wrong-scope' where ri_topic_id = ${TYPE}`;
        await expect(operation.submit({ ...COMMAND, warehouse: 'wrong-scope' })).rejects.toMatchObject({ code: 'app-inbox-malformed-command' });
    });

    it.each(['route', 'authority', 'data', 'result'])('fails closed on a corrupt durable %s', async (corruption) => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();
        await drain(harness.reader, operation.submit(COMMAND));
        if (corruption === 'result') {
            await storage.sql`update resource_inbox_results set ris_resource = '"invalid-result"'`;
            expect((await operation.readReplay(COMMAND))?.left).toMatchObject({ code: 'app-inbox-result-corrupt' });
        }
        else {
            const [row] = await storage.sql<{ ri_resource: string; }[]>`select ri_resource from resource_inbox where ri_type_id = 'APP_INBOX'`;
            const envelope = JSON.parse(row.ri_resource);
            if (corruption === 'route') {
                envelope.route.resourceId = 'another-request';
            }
            else {
                const command = JSON.parse(envelope.payload.resource);
                if (corruption === 'authority') {
                    command.authority.quantity = 99;
                }
                else {
                    command.data.quantity = 99;
                }
                envelope.payload.resource = JSON.stringify(command);
            }
            await storage.sql`update resource_inbox set ri_resource = ${JSON.stringify(envelope)} where ri_type_id = 'APP_INBOX'`;
            await expect(operation.readReplay(COMMAND)).rejects.toMatchObject({ code: 'app-inbox-malformed-command' });
        }
        expect(harness.facts).toEqual([101]);
        expect(harness.afterCommit).toEqual([7]);
    });

    it('does not give unknown operations a mutation fallback', async () => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();
        const pending = operation.submit(COMMAND);
        await waitForEntry(storage.sql);
        await storage
            .sql`update resource_inbox set ri_resource = replace(ri_resource, 'app:inventory:reserve', 'app:inventory:unknown'), ri_topic_id = 'app:inventory:unknown'`;
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect(await storage.sql`select quantity from inventory`).toEqual([{ quantity: 10 }]);
        expect(harness.afterCommit).toEqual([]);
        expect((await pending).left).toMatchObject({ code: 'app-inbox-unavailable' });
    });

    it('rejects a forged commit context before opening any mutation transaction', async () => {
        const harness = createHarness(storage.sql);
        await expect(harness.inbox.commit(Object.create(null), null, async (transaction) => {
            await transaction`delete from inventory`;
        })).rejects.toThrow('active registered attempt');
        expect(await storage.sql`select quantity from inventory`).toEqual([{ quantity: 10 }]);
    });

    it('admits only sealed registrations and refuses submissions after shutdown', async () => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        await expect(operation.submit(COMMAND)).rejects.toMatchObject({ code: 'app-inbox-lifecycle-rejected' });
        harness.inbox.start();
        expect(() => registerStock(harness)).toThrow();
        harness.inbox.stop();
        await expect(operation.submit(COMMAND)).rejects.toMatchObject({ code: 'app-inbox-lifecycle-rejected' });
        expect(await storage.sql`select * from resource_inbox`).toEqual([]);
    });

    it('keeps the committed winner when an after-commit effect fails', async () => {
        const harness = createHarness(storage.sql);
        harness.failAfterCommit = true;
        const operation = registerStock(harness);
        harness.inbox.start();
        const result = await drain(harness.reader, operation.submit(COMMAND));
        expect(result).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(await operation.submit(COMMAND)).toEqual(result);
        expect(harness.readQuantities).toEqual([10]);
        expect(harness.afterCommit).toEqual([7]);
        expect(await storage.sql`select ri_type_id, ri_status from resource_inbox order by ri_type_id`).toEqual([
            { ri_type_id: 'APP_INBOX', ri_status: 'COMPLETED' },
            { ri_type_id: 'APP_OUTBOX', ri_status: 'NEW' }
        ]);
    });

    it('reserves one immutable winner across overlapping same-key submissions', async () => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();
        const results = await drain(harness.reader, Promise.all([operation.submit(COMMAND), operation.submit(COMMAND)]));
        expect(results).toEqual([Either.ofRight({ remaining: 7, capturedAt: 101 }), Either.ofRight({ remaining: 7, capturedAt: 101 })]);
        expect(harness.facts).toEqual([101]);
        expect(harness.afterCommit).toEqual([7]);
    });

    it('permits concurrent external proposals after validated misses but retains only the winner', async () => {
        const harness = createHarness(storage.sql);
        let proposals = 0;
        let misses = 0;
        const proposalGate = Promise.withResolvers<void>();
        const operation = harness.inbox.register({
            type: 'app:inventory:proposal',
            decodeCommand: decodeStock,
            encodeCommand: (command: StockCommand) => ({ ...command }),
            toBinding: (command) => ({ contextId: command.warehouse, resourceId: command.requestId }),
            toLogicalCommand: (command) => ({ warehouse: command.warehouse, requestId: command.requestId, quantity: command.quantity }),
            materialize: (command) => {
                harness.facts.push(command.capturedAt ?? 0);
                return command;
            },
            encodeResult: (result: number) => result,
            decodeResult: (value) => {
                if (typeof value !== 'number') {
                    throw new TypeError('Malformed proposal result');
                }
                return value;
            },
            handle: async (command, context) =>
                await harness.inbox.commit(context, command.capturedAt ?? 0, async (transaction) => {
                    await transaction`update inventory set quantity = quantity - ${command.quantity}, revision = revision + 1 where warehouse = ${command.warehouse}`;
                })
        });
        harness.inbox.start();
        async function submitWithExternalProposal(command: StockCommand) {
            const replay = await operation.readReplay(command);
            if (replay) {
                return replay;
            }
            misses += 1;
            if (misses === 2) {
                proposalGate.resolve();
            }
            await proposalGate.promise;
            const proposal = await Promise.resolve(++proposals);
            return await operation.submit({ ...command, capturedAt: proposal });
        }
        const results = await drain(harness.reader, Promise.all([submitWithExternalProposal(COMMAND), submitWithExternalProposal(COMMAND)]));
        expect(proposals).toBe(2);
        expect(harness.facts).toHaveLength(1);
        expect(results).toEqual([Either.ofRight(harness.facts[0]), Either.ofRight(harness.facts[0])]);
        expect(await submitWithExternalProposal(COMMAND)).toEqual(results[0]);
        await expect(submitWithExternalProposal({ ...COMMAND, quantity: 4 })).rejects.toMatchObject({ code: 'app-inbox-idempotency-conflict' });
        expect(proposals).toBe(2);
        expect(harness.facts).toHaveLength(1);
        expect(await storage.sql`select quantity, revision from inventory`).toEqual([{ quantity: 7, revision: 1 }]);
    });

    it('re-enters read and compute after a real CAS conflict on outer delivery', async () => {
        const harness = createHarness(storage.sql);
        harness.conflictOnce = true;
        const operation = registerStock(harness);
        harness.inbox.start();
        expect(await drain(harness.reader, operation.submit(COMMAND))).toEqual(Either.ofRight({ remaining: 6, capturedAt: 101 }));
        expect(harness.readQuantities).toEqual([10, 9]);
        expect(harness.facts).toEqual([101]);
        expect(harness.afterCommit).toEqual([6]);
    });

    it('rolls back state and durable success on a final outbox collision', async () => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();
        const collision = computeAppOutboxInsert(
            toResourceEntryWithKey({ topicId: 'inventory-notify', contextId: COMMAND.warehouse, resourceId: COMMAND.requestId }, 'APP_OUTBOX', {
                existing: true
            })
        );
        await writeAppOutboxInsert(storage.sql, collision);
        expect((await drain(harness.reader, operation.submit(COMMAND))).left).toMatchObject({ code: 'resource-inbox-invariant-corruption' });
        expect(await storage.sql`select quantity, revision from inventory`).toEqual([{ quantity: 10, revision: 0 }]);
        expect(harness.afterCommit).toEqual([]);
        expect(await storage.sql`select ris_status from resource_inbox_results`).toEqual([{ ris_status: 'FAILED' }]);
    });

    it('reports exhaustion without a local retry or another winner capture', async () => {
        const harness = createHarness(storage.sql);
        harness.alwaysConflict = true;
        const operation = registerStock(harness);
        harness.inbox.start();
        const pending = operation.submit(COMMAND);
        await waitForEntry(storage.sql);
        await storage
            .sql`update resource_inbox set ri_attempts = 19, ri_status = 'RETRY', start_ts = (now() at time zone 'UTC') - interval '2 seconds', end_ts = (now() at time zone 'UTC') - interval '1 second', next_ts = (now() at time zone 'UTC') - interval '1 second' where ri_type_id = 'APP_INBOX'`;
        expect((await drain(harness.reader, pending)).left).toMatchObject({ retry: { kind: 'exhausted', attempts: 20 } });
        expect(harness.readQuantities).toEqual([10]);
        expect(harness.facts).toEqual([101]);
        expect(harness.afterCommit).toEqual([]);
    });

    it('rolls back the domain write when completion fails and emits no after-commit effect', async () => {
        const harness = createHarness(storage.sql);
        harness.failWrite = true;
        const operation = registerStock(harness);
        harness.inbox.start();
        const result = await drain(harness.reader, operation.submit(COMMAND));
        expect(result.left).toMatchObject({ code: 'app-inbox-malformed-command' });
        expect(await storage.sql`select quantity, revision from inventory`).toEqual([{ quantity: 10, revision: 0 }]);
        expect(harness.afterCommit).toEqual([]);
    });
});

interface Harness {
    readonly inbox: RallarServerAppInbox;
    readonly reader: InboxQueueReader;
    readonly database: PSqlSql;
    readonly facts: number[];
    readonly readQuantities: number[];
    readonly afterCommit: number[];
    conflictOnce: boolean;
    failWrite: boolean;
    failAfterCommit: boolean;
    alwaysConflict: boolean;
}

function createHarness(database: PSqlSql): Harness {
    const repositories = createPSqlResourceInboxRepository(database, () => new Date());
    const results = new ResourceInboxResultsRepository(database);
    const finalizeRetry = createAppInboxRetryFinalizer({ database });
    const reader = new InboxQueueReader(new PSqlQueueBox(repositories, Temporal.Now.instant), {
        newLaneConcurrency: 1,
        onRetryExhausted: finalizeRetry,
        onRetryExhaustionRecovery: finalizeRetry
    });
    const inbox = new RallarServerAppInbox({
        inboxQueueReader: reader,
        resourceInboxRepository: repositories.entries,
        resourceInboxResultsRepository: results,
        database,
        wakeOwningQueue: () => {}
    }, { serviceId: 'inventory-worker', options: { waitMaxElapsedMsecs: 2000, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 5, waitJitterRatio: 0 } });
    return {
        inbox,
        reader,
        database,
        facts: [],
        readQuantities: [],
        afterCommit: [],
        conflictOnce: false,
        failWrite: false,
        failAfterCommit: false,
        alwaysConflict: false
    };
}

function registerStock(harness: Harness) {
    return harness.inbox.register({
        type: TYPE,
        decodeCommand: decodeStock,
        encodeCommand: (command: StockCommand) => ({ ...command }),
        toBinding: (command: StockCommand) => ({ contextId: command.warehouse, resourceId: command.requestId }),
        toLogicalCommand: (command: StockCommand) => ({ warehouse: command.warehouse, requestId: command.requestId, quantity: command.quantity }),
        materialize: (command: StockCommand) => {
            const capturedAt = 101 + harness.facts.length;
            harness.facts.push(capturedAt);
            return { ...command, capturedAt };
        },
        encodeResult: (result: JsonWireValue) => result,
        decodeResult: decodeStockResult,
        handle: (command: StockCommand, context: AppInboxMessageContext<JsonWireValue>) => reserveStock(harness, command, context)
    });
}

async function reserveStock(harness: Harness, command: StockCommand, context: AppInboxMessageContext<JsonWireValue>): Promise<JsonWireValue> {
    const [read] = await harness.database<
        { quantity: number; revision: number; }[]
    >`select quantity, revision from inventory where warehouse = ${command.warehouse}`;
    harness.readQuantities.push(read.quantity);
    const computed = { remaining: read.quantity - command.quantity, capturedAt: command.capturedAt };
    if (computed.remaining < 0 || computed.capturedAt === null) {
        throw new TypeError('Invalid stock reservation');
    }
    if (harness.conflictOnce) {
        harness.conflictOnce = false;
        await harness.database`update inventory set quantity = 9, revision = revision + 1 where warehouse = ${command.warehouse}`;
    }
    const outbox = computeAppOutboxInsert(
        toResourceEntryWithKey({ topicId: 'inventory-notify', contextId: command.warehouse, resourceId: command.requestId }, 'APP_OUTBOX', computed)
    );
    const result = await harness.inbox.commit(context, computed, async (transaction) => {
        const written = await transaction<
            readonly { revision: number; }[]
        >`update inventory set quantity = ${computed.remaining}, revision = revision + 1 where warehouse = ${command.warehouse} and revision = ${read.revision} returning revision`;
        if (written.length === 0 || harness.alwaysConflict) {
            throw Object.assign(new Error('Stock revision changed'), { code: 'runtime-state-write-conflict' });
        }
        await writeAppOutboxInsert(transaction, outbox);
        if (harness.failWrite) {
            throw new TypeError('Write failed after the conditional mutation');
        }
    });
    harness.afterCommit.push(computed.remaining);
    if (harness.failAfterCommit) {
        throw new Error('Wake failed after durable commit');
    }
    return result;
}

function decodeStock(value: JsonWireValue): StockCommand {
    if (
        value === null || typeof value !== 'object' || Array.isArray(value) || !('warehouse' in value) ||
        typeof value.warehouse !== 'string' || typeof value.requestId !== 'string' || typeof value.quantity !== 'number' ||
        (value.capturedAt !== null && typeof value.capturedAt !== 'number') || Object.keys(value).length !== 4
    ) {
        throw new TypeError('Malformed stock command');
    }
    return { warehouse: value.warehouse, requestId: value.requestId, quantity: value.quantity, capturedAt: value.capturedAt };
}

async function drain<Result>(reader: InboxQueueReader, pending: Promise<Result>): Promise<Result> {
    let settled = false;
    const observed = pending.finally(() => {
        settled = true;
    });
    void observed.catch(() => {});
    while (!settled) {
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return await observed;
}

function decodeStockResult(value: JsonWireValue): JsonWireValue {
    if (
        !value || typeof value !== 'object' || Array.isArray(value) || !('remaining' in value) || typeof value.remaining !== 'number' ||
        typeof value.capturedAt !== 'number'
    ) {
        throw new TypeError('Malformed stock result');
    }
    return value;
}

async function waitForEntry(database: PSqlSql): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await database<readonly object[]>`select ri_resource_id from resource_inbox where ri_type_id = 'APP_INBOX'`;
        if (rows.length > 0) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Command did not reach durable reservation');
}
