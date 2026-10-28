import { Temporal } from '@js-temporal/polyfill';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RallarServerAppInbox, type AppInboxMessageContext, type JsonWireValue, type PSqlSql } from '@shared-server/mod.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { createAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { createAppInboxRetryFinalizer } from '@shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts';
import { computeAppOutboxInsert, writeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { serializeCanonicalMutationCommand } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';

interface StockCommand {
    readonly warehouse: string;
    readonly requestId: string;
    readonly quantity: number;
    readonly capturedAt: number | null;
}

const COMMAND: StockCommand = { warehouse: 'warehouse-1', requestId: 'request-1', quantity: 3, capturedAt: null };
const TYPE = 'app:inventory:reserve';
const TRACE_ID = 'trace-public-app-inbox';

let storage: ResourceInboxTestStorage;
beforeEach(async () => {
    storage = await createResourceInboxTestStorage('public_app_inbox', 4);
    await storage.sql`create table inventory (warehouse text primary key, quantity integer not null, revision integer not null)`;
    await storage.sql`insert into inventory values ('warehouse-1', 10, 0)`;
});
afterEach(async () => await storage?.close());

describe('public application AppInbox', () => {
    it('admits and runs the application command under the trace its caller enqueued it with', async () => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();

        await drain(harness.reader, operation.submit({ command: COMMAND, traceId: 'trace-public-app-inbox-request' }));

        const [row] = await storage.sql<{ ri_resource: string; }[]>`select ri_resource from resource_inbox where ri_type_id = 'APP_INBOX'`;
        expect(JSON.parse(row.ri_resource).id.traceId).toBe('trace-public-app-inbox-request');
        expect(harness.traces).toEqual(['trace-public-app-inbox-request']);
    });

    it('leaves another application pending until a cold owning worker can replay its captured facts', async () => {
        const admitted = createHarness(storage.sql);
        const operation = registerStock(admitted);
        admitted.inbox.start();
        await operation.enqueue({ command: COMMAND, traceId: TRACE_ID });
        const before = await storage.sql`select ri_status, ri_attempts, ri_resource from resource_inbox where ri_type_id = 'APP_INBOX'`;
        const platformOnly = createHarness(storage.sql);
        platformOnly.inbox.start();
        await platformOnly.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect(await storage.sql`select ri_status, ri_attempts, ri_resource from resource_inbox where ri_type_id = 'APP_INBOX'`).toEqual(before);
        const owner = createHarness(storage.sql);
        const replay = registerStock(owner);
        owner.inbox.start();
        expect(await drain(owner.reader, replay.readReplay(COMMAND))).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(await replay.submit({ command: COMMAND, traceId: TRACE_ID })).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(owner.facts).toEqual([]);
    });

    it('replays a command submitted again under another trace and keeps the winner\'s trace on its one row', async () => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();

        const first = await drain(harness.reader, operation.submit({ command: COMMAND, traceId: 'trace-a' }));
        const replay = await drain(harness.reader, operation.submit({ command: COMMAND, traceId: 'trace-b' }));

        expect(first).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(replay).toEqual(first);
        const rows = await storage.sql<{ ri_resource: string; }[]>`select ri_resource from resource_inbox where ri_type_id = 'APP_INBOX'`;
        expect(rows.map((row) => JSON.parse(row.ri_resource).id.traceId)).toEqual(['trace-a']);
    });

    it('returns durable admission and wakes its owner before any worker runs or result wait begins', async () => {
        const wakeObservations: Promise<readonly { status: string; }[]>[] = [];
        const harness = createHarness(storage.sql, () => {
            wakeObservations.push(
                storage.sql<{ status: string; }[]>`select ri_status as status from resource_inbox where ri_type_id = 'APP_INBOX'`.then((rows) => rows)
            );
        });
        const operation = registerStock(harness);
        harness.inbox.start();
        expect(await operation.readAdmission(COMMAND)).toBeUndefined();
        const admitted = await operation.enqueue({ command: COMMAND, traceId: TRACE_ID });
        expect(admitted.left).toBeUndefined();
        const replay = await operation.readAdmission(COMMAND);
        expect(replay?.left).toBeUndefined();
        expect(replay?.right).toBeDefined();
        expect(await Promise.all(wakeObservations)).toEqual([[{ status: 'NEW' }]]);
        expect(harness.facts).toEqual([101]);
        expect(harness.afterCommit).toEqual([]);
        expect(await storage.sql`select quantity, revision from inventory`).toEqual([{ quantity: 10, revision: 0 }]);
        expect(await storage.sql`select ri_status from resource_inbox where ri_type_id = 'APP_INBOX'`).toEqual([{ ri_status: 'NEW' }]);
        expect((await operation.enqueue({ command: { ...COMMAND, quantity: 4 }, traceId: TRACE_ID })).left).toMatchObject({
            code: 'app-inbox-idempotency-conflict'
        });
        expect((await operation.readAdmission({ ...COMMAND, quantity: 4 }))?.left).toMatchObject({ code: 'app-inbox-idempotency-conflict' });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect(await storage.sql`select ri_status from resource_inbox where ri_type_id = 'APP_INBOX'`).toEqual([{ ri_status: 'COMPLETED' }]);
        expect(await admitted.right!.wait()).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(await replay!.right!.wait()).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(wakeObservations).toHaveLength(1);
        expect(harness.afterCommit).toEqual([7]);
        expect(harness.facts).toEqual([101]);
    });

    it('retains admitted work when its wake port fails and wakes the retained admission on retry', async () => {
        let wakes = 0;
        const harness = createHarness(storage.sql, () => {
            wakes += 1;
            if (wakes === 1) {
                throw new Error('Owning queue unavailable');
            }
        });
        const operation = registerStock(harness);
        harness.inbox.start();
        await expect(operation.enqueue({ command: COMMAND, traceId: TRACE_ID })).rejects.toThrow('Owning queue unavailable');
        expect(await storage.sql`select ri_status from resource_inbox where ri_type_id = 'APP_INBOX'`).toEqual([{ ri_status: 'NEW' }]);
        const retry = await operation.enqueue({ command: COMMAND, traceId: TRACE_ID });
        expect(retry.right).toBeDefined();
        expect(wakes).toBe(2);
        expect(harness.facts).toEqual([101]);
        expect(await drain(harness.reader, retry.right!.wait())).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(wakes).toBe(2);
        expect(harness.afterCommit).toEqual([7]);
    });

    it('binds admitted waiters to the retained command and applies lifecycle and corruption checks before admission', async () => {
        const exact = { remaining: 123, capturedAt: 501, warehouse: COMMAND.warehouse, operation: 'reserve' };
        await seedCanonicalStock('completed', exact);
        let wakes = 0;
        const harness = createHarness(storage.sql, () => {
            wakes += 1;
        });
        const operation = registerStock(harness, decodeBoundStockResult);
        expect((await operation.enqueue({ command: COMMAND, traceId: TRACE_ID })).left).toMatchObject({ code: 'app-inbox-lifecycle-rejected' });
        expect((await operation.readAdmission(COMMAND))?.left).toMatchObject({ code: 'app-inbox-lifecycle-rejected' });
        expect(wakes).toBe(0);
        harness.inbox.start();
        const admitted = await operation.enqueue({ command: COMMAND, traceId: TRACE_ID });
        expect(await admitted.right!.wait()).toEqual(Either.ofRight(exact));
        expect(harness.facts).toEqual([]);
        await storage.sql`update resource_inbox set ri_resource = replace(ri_resource, 'inventory-session', 'wrong-session') where ri_type_id = 'APP_INBOX'`;
        await expect(operation.readAdmission(COMMAND)).rejects.toMatchObject({ code: 'app-inbox-malformed-command' });
        await expect(operation.enqueue({ command: COMMAND, traceId: TRACE_ID })).rejects.toMatchObject({ code: 'app-inbox-malformed-command' });
        expect(wakes).toBe(1);
        expect(harness.afterCommit).toEqual([]);
    });

    it('commits exact results and replays the winner without recapturing facts or waking from result waits', async () => {
        let wakes = 0;
        const harness = createHarness(storage.sql, () => {
            wakes += 1;
        });
        const operation = registerStock(harness);
        harness.inbox.start();
        const first = await drain(harness.reader, operation.submit({ command: COMMAND, traceId: TRACE_ID }));
        expect(first).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(wakes).toBe(1);
        expect(await operation.readReplay(COMMAND)).toEqual(first);
        expect(wakes).toBe(1);
        expect(await operation.submit({ command: COMMAND, traceId: TRACE_ID })).toEqual(first);
        expect(wakes).toBe(2);
        expect(harness.facts).toEqual([101]);
        expect(harness.afterCommit).toEqual([7]);
        expect(await storage.sql`select quantity, revision from inventory`).toEqual([{ quantity: 7, revision: 1 }]);
    });

    it.each([{ status: 'pending', remaining: 7, quantity: 7 }, { status: 'completed', remaining: 123, quantity: 10 }] as const)(
        'consumes a canonical $status envelope without rewriting or recapturing its winner',
        async ({ status, remaining, quantity }) => {
            const original = await seedCanonicalStock(status, { remaining: 123, capturedAt: 501 });
            const harness = createHarness(storage.sql);
            const operation = registerStock(harness);
            harness.inbox.start();
            const result = await drain(harness.reader, operation.readReplay(COMMAND));
            expect(result).toEqual(Either.ofRight({ remaining, capturedAt: 501 }));
            expect(await operation.submit({ command: COMMAND, traceId: TRACE_ID })).toEqual(result);
            expect(harness.facts).toEqual([]);
            expect(await storage.sql`select ri_resource from resource_inbox where ri_type_id = 'APP_INBOX'`).toEqual([{ ri_resource: original }]);
            expect(await storage.sql`select quantity from inventory`).toEqual([{ quantity }]);
        }
    );

    it.each([{ wrong: 'warehouse', warehouse: 'warehouse-2', operation: 'reserve' }, {
        wrong: 'operation',
        warehouse: COMMAND.warehouse,
        operation: 'inspect'
    }])('rejects valid-shaped results bound to the wrong $wrong on every replay path', async ({ warehouse, operation: resultOperation }) => {
        const result = {
            remaining: 123,
            capturedAt: 501,
            warehouse,
            operation: resultOperation
        };
        await seedCanonicalStock('completed', result);
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness, decodeBoundStockResult);
        harness.inbox.start();
        expect((await operation.readReplay(COMMAND))?.left).toMatchObject({ code: 'app-inbox-result-corrupt' });
        expect((await operation.submit({ command: COMMAND, traceId: TRACE_ID })).left).toMatchObject({ code: 'app-inbox-result-corrupt' });
        expect(harness.facts).toEqual([]);
        expect(await storage.sql`select quantity from inventory`).toEqual([{ quantity: 10 }]);
    });

    it('binds exact stored results to retained winner facts rather than uncaptured caller data', async () => {
        const exact = { remaining: 123, capturedAt: 501, warehouse: COMMAND.warehouse, operation: 'reserve' };
        await seedCanonicalStock('completed', exact);
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness, decodeBoundStockResult);
        harness.inbox.start();
        expect(await operation.readReplay(COMMAND)).toEqual(Either.ofRight(exact));
        expect(await operation.submit({ command: COMMAND, traceId: TRACE_ID })).toEqual(Either.ofRight(exact));
        expect(harness.facts).toEqual([]);
    });

    it('rejects conflicting semantics before winner capture and binds scope to the durable key', async () => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();
        await drain(harness.reader, operation.submit({ command: COMMAND, traceId: TRACE_ID }));
        expect((await operation.readReplay({ ...COMMAND, quantity: 4 }))?.left).toMatchObject({ code: 'app-inbox-idempotency-conflict', status: 409 });
        expect((await operation.submit({ command: { ...COMMAND, quantity: 4 }, traceId: TRACE_ID })).left).toMatchObject({
            code: 'app-inbox-idempotency-conflict',
            status: 409
        });
        expect(harness.facts).toEqual([101]);
        await storage.sql`update resource_inbox set fk_ext_bank_id = 'wrong-scope' where ri_topic_id = ${TYPE}`;
        await expect(operation.submit({ command: { ...COMMAND, warehouse: 'wrong-scope' }, traceId: TRACE_ID })).rejects.toMatchObject({
            code: 'app-inbox-malformed-command'
        });
    });

    it.each(['route', 'authority', 'data', 'sender', 'result'])('fails closed on a corrupt durable %s', async (corruption) => {
        const harness = createHarness(storage.sql);
        const operation = registerStock(harness);
        harness.inbox.start();
        await drain(harness.reader, operation.submit({ command: COMMAND, traceId: TRACE_ID }));
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
                if (corruption === 'sender') {
                    command.senderId = 'another-session';
                }
                else if (corruption === 'authority') {
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
        const pending = operation.submit({ command: COMMAND, traceId: TRACE_ID });
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

    it('admits only sealed registrations and refuses submissions after shutdown without waking workers', async () => {
        let wakes = 0;
        const harness = createHarness(storage.sql, () => {
            wakes += 1;
        });
        const operation = registerStock(harness);
        expect((await operation.submit({ command: COMMAND, traceId: TRACE_ID })).left).toMatchObject({ code: 'app-inbox-lifecycle-rejected', status: 503 });
        harness.inbox.start();
        expect(() => registerStock(harness)).toThrow();
        harness.inbox.stop();
        expect((await operation.submit({ command: COMMAND, traceId: TRACE_ID })).left).toMatchObject({ code: 'app-inbox-lifecycle-rejected', status: 503 });
        expect(await storage.sql`select * from resource_inbox`).toEqual([]);
        expect(wakes).toBe(0);
    });

    it('keeps the committed winner when an after-commit effect fails', async () => {
        const harness = createHarness(storage.sql);
        harness.failAfterCommit = true;
        const operation = registerStock(harness);
        harness.inbox.start();
        const result = await drain(harness.reader, operation.submit({ command: COMMAND, traceId: TRACE_ID }));
        expect(result).toEqual(Either.ofRight({ remaining: 7, capturedAt: 101 }));
        expect(await operation.submit({ command: COMMAND, traceId: TRACE_ID })).toEqual(result);
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
        const results = await drain(
            harness.reader,
            Promise.all([operation.submit({ command: COMMAND, traceId: TRACE_ID }), operation.submit({ command: COMMAND, traceId: TRACE_ID })])
        );
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
            decodeEnvelope: decodeStockEnvelope,
            encodeEnvelope: encodeStockEnvelope,
            toBinding: (command) => ({ contextId: command.warehouse, resourceId: command.requestId }),
            toLogicalCommand: toStockLogicalCommand,
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
            return await operation.submit({ command: { ...command, capturedAt: proposal }, traceId: TRACE_ID });
        }
        const results = await drain(harness.reader, Promise.all([submitWithExternalProposal(COMMAND), submitWithExternalProposal(COMMAND)]));
        expect(proposals).toBe(2);
        expect(harness.facts).toHaveLength(1);
        expect(results).toEqual([Either.ofRight(harness.facts[0]), Either.ofRight(harness.facts[0])]);
        expect(await submitWithExternalProposal(COMMAND)).toEqual(results[0]);
        expect((await submitWithExternalProposal({ ...COMMAND, quantity: 4 })).left).toMatchObject({ code: 'app-inbox-idempotency-conflict' });
        expect(proposals).toBe(2);
        expect(harness.facts).toHaveLength(1);
        expect(await storage.sql`select quantity, revision from inventory`).toEqual([{ quantity: 7, revision: 1 }]);
    });

    it('re-enters read and compute after a real CAS conflict on outer delivery', async () => {
        const harness = createHarness(storage.sql);
        harness.conflictOnce = true;
        const operation = registerStock(harness);
        harness.inbox.start();
        expect(await drain(harness.reader, operation.submit({ command: COMMAND, traceId: TRACE_ID }))).toEqual(
            Either.ofRight({ remaining: 6, capturedAt: 101 })
        );
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
        expect((await drain(harness.reader, operation.submit({ command: COMMAND, traceId: TRACE_ID }))).left).toMatchObject({
            code: 'resource-inbox-invariant-corruption'
        });
        expect(await storage.sql`select quantity, revision from inventory`).toEqual([{ quantity: 10, revision: 0 }]);
        expect(harness.afterCommit).toEqual([]);
        expect(await storage.sql`select ris_status from resource_inbox_results`).toEqual([{ ris_status: 'FAILED' }]);
    });

    it('reports exhaustion without a local retry or another winner capture', async () => {
        const harness = createHarness(storage.sql);
        harness.alwaysConflict = true;
        const operation = registerStock(harness);
        harness.inbox.start();
        const pending = operation.submit({ command: COMMAND, traceId: TRACE_ID });
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
        const result = await drain(harness.reader, operation.submit({ command: COMMAND, traceId: TRACE_ID }));
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
    readonly traces: string[];
    conflictOnce: boolean;
    failWrite: boolean;
    failAfterCommit: boolean;
    alwaysConflict: boolean;
}

function createHarness(database: PSqlSql, wakeOwningQueue: () => void = () => {}): Harness {
    const repositories = createPSqlResourceInboxRepository(database, () => new Date());
    const results = new ResourceInboxResultsRepository(database);
    const finalizeRetry = createAppInboxRetryFinalizer({ database, finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS });
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
        wakeOwningQueue
    }, {
        serviceId: 'inventory-worker',
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        options: { waitMaxElapsedMsecs: 2000, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 5, waitJitterRatio: 0 }
    });
    return {
        inbox,
        reader,
        database,
        facts: [],
        readQuantities: [],
        afterCommit: [],
        traces: [],
        conflictOnce: false,
        failWrite: false,
        failAfterCommit: false,
        alwaysConflict: false
    };
}

function registerStock(harness: Harness, decodeResult: (value: JsonWireValue, command: StockCommand) => JsonWireValue = decodeStockResult) {
    return harness.inbox.register({
        type: TYPE,
        decodeEnvelope: decodeStockEnvelope,
        encodeEnvelope: encodeStockEnvelope,
        toBinding: (command: StockCommand) => ({ contextId: command.warehouse, resourceId: command.requestId }),
        toLogicalCommand: toStockLogicalCommand,
        materialize: (command: StockCommand) => {
            const capturedAt = 101 + harness.facts.length;
            harness.facts.push(capturedAt);
            return { ...command, capturedAt };
        },
        encodeResult: (result: JsonWireValue) => result,
        decodeResult,
        handle: (command: StockCommand, context: AppInboxMessageContext<JsonWireValue>) => reserveStock(harness, command, context)
    });
}

async function reserveStock(harness: Harness, command: StockCommand, context: AppInboxMessageContext<JsonWireValue>): Promise<JsonWireValue> {
    const [read] = await harness.database<
        { quantity: number; revision: number; }[]
    >`select quantity, revision from inventory where warehouse = ${command.warehouse}`;
    harness.readQuantities.push(read.quantity);
    harness.traces.push(context.message.id.traceId);
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

function decodeStockResult(value: JsonWireValue, command: StockCommand): JsonWireValue {
    if (
        !value || typeof value !== 'object' || Array.isArray(value) || !('remaining' in value) || typeof value.remaining !== 'number' ||
        typeof value.capturedAt !== 'number' || value.capturedAt !== command.capturedAt
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

function encodeStockEnvelope(command: StockCommand): RallarServerAppInbox.Envelope {
    return { senderId: 'inventory-session', data: { ...command, capturedAt: null }, authority: { ...command } };
}

function decodeStockEnvelope(envelope: RallarServerAppInbox.Envelope): StockCommand {
    const logical = decodeStock(envelope.data);
    const captured = decodeStock(envelope.authority ?? null);
    if (
        envelope.senderId !== 'inventory-session' || logical.capturedAt !== null ||
        serializeCanonicalMutationCommand(toStockLogicalCommand(logical)) !== serializeCanonicalMutationCommand(toStockLogicalCommand(captured))
    ) {
        throw new TypeError('Stock envelope binding mismatch');
    }
    return captured;
}

function decodeBoundStockResult(value: JsonWireValue, command: StockCommand): JsonWireValue {
    const result = decodeStockResult(value, command);
    if (
        !result || typeof result !== 'object' || Array.isArray(result) || !('warehouse' in result) || !('operation' in result) ||
        result.warehouse !== command.warehouse ||
        result.operation !== (command.quantity === 0 ? 'inspect' : 'reserve')
    ) {
        throw new TypeError('Stock result belongs to another command');
    }
    return result;
}

async function seedCanonicalStock(status: 'pending' | 'completed', result: JsonWireValue): Promise<string> {
    const envelope = {
        type: TYPE,
        topicId: TYPE,
        contextId: COMMAND.warehouse,
        resourceId: COMMAND.requestId,
        senderId: 'inventory-session',
        traceId: 'trace-existing-inventory-row',
        data: { ...COMMAND },
        authority: { ...COMMAND, capturedAt: 501 }
    } as const;
    const entry = createAppInboxResourceEntry(envelope, 'existing-inventory-worker', {
        creationNow: Temporal.Now.instant,
        createMessage: ({ key, enqueue: { traceId, ...command } }) =>
            newALUntargetedMessage(
                'existing-inventory-worker',
                newALRoute(key.topicId, key.contextId, key.resourceId),
                command.type,
                command,
                { traceId }
            )
    });
    const repositories = createPSqlResourceInboxRepository(storage.sql, () => new Date());
    await repositories.entries.writeMaterializedIfAbsentOrReplaceExpired(entry, async () => entry);
    if (status === 'completed') {
        await storage.sql`update resource_inbox set ri_status = 'COMPLETED' where ri_type_id = 'APP_INBOX'`;
        await new ResourceInboxResultsRepository(storage.sql).replace({ ...toResourceEntryWithKey(entry.key, 'APP_INBOX', result), status: 'COMPLETED' });
    }
    return entry.resource;
}

function toStockLogicalCommand(command: StockCommand): JsonWireValue {
    return { warehouse: command.warehouse, requestId: command.requestId, quantity: command.quantity };
}
