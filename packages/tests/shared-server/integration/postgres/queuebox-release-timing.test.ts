import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlParameter, PSqlSql, PSqlTransactionWrite } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import type { PSqlQueueReleaseTiming } from '@shared-server/queuebox/postgres/p-sql-queue-release-timing.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { AL_INBOUND_MAX_DELIVERED_MARKERS } from '@shared/alm/inbound/admission/evict-al-inbound-delivered-markers-past-cap.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceInboxRelease } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres release elapsed phase evidence', () => {
    postgresIt('attributes the one held UPDATE of a real sixteen-member release only after root return', async () => {
        const storage = await createReleaseStorage();
        const observed: PSqlQueueReleaseTiming.Observation[] = [];
        const gates = createReleaseGates(storage.sql);
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(gates.sql, () => new Date()), () => {
            gates.clock.atMs = 5;
            return Temporal.Now.instant();
        }, {
            namespace: storage.namespace,
            port: { readMonotonicMs: () => gates.clock.atMs, readEpochMs: () => 10_000, record: (value) => observed.push(value) }
        });
        const releases = storage.reserved.map((entry) => ({ entry, disposition: { status: EntityStatus.COMPLETED, delayMs: null } }));
        const pending = queue.releaseEntries(releases);

        await gates.statementReached.promise;
        expect(observed).toEqual([]);
        expect((await storage.other.entries.findAnyByKey(storage.reserved[0]!.key))?.status).toBe(EntityStatus.RESERVED);
        gates.clock.atMs = 112;
        gates.statementCompleted.resolve();
        await gates.callbackReturned.promise;
        expect(observed).toEqual([]);
        gates.clock.atMs = 125;
        gates.transactionCompleted.resolve();
        const result = await pending;

        expect(result.size).toBe(16);
        for (const entry of result.values()) {
            expect(await storage.other.entries.findAnyByKey(entry.key)).toEqual(entry);
        }
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({
            outcome: 'succeeded',
            availability: 'available',
            namespace: storage.namespace,
            sequence: 1,
            memberCount: 16,
            eligible: true,
            fallbackCount: 0,
            phases: {
                candidateElapsedMs: 5,
                transactionAdmissionElapsedMs: 7,
                callbackElapsedMs: 100,
                releaseReservedElapsedMs: 100,
                transactionReturnElapsedMs: 13,
                releaseOwnerElapsedMs: 125,
                callbackRemainderElapsedMs: 0,
                setupRemainderElapsedMs: 0
            }
        });
        const observation = observed[0]!;
        if (observation.availability !== 'available') {
            throw new Error('Expected available release boundaries');
        }
        expect(observation.members).toHaveLength(16);
        expect(observation.members.map((member) => member.updated)).toEqual(storage.reserved.map(() => true));
        expect(observation.members[7]).toMatchObject({
            ordinal: 7,
            key: storage.reserved[7]!.key,
            reservationAttempt: 1,
            reservationStartedAt: storage.reserved[7]!.dequeueAudit.startTs!.toString(),
            rowId: String(storage.reserved[7]!.db!.id)
        });
    });
    postgresIt('rolls back the earlier fifteen writes when the final reservation is stale and publishes only failure', async () => {
        const storage = await createReleaseStorage();
        const observed: PSqlQueueReleaseTiming.Observation[] = [];
        const queue = createObservedQueue(storage, (value) => observed.push(value));
        const last = storage.reserved[15]!;
        await storage.other.entries.replaceIfObserved(last, { ...last, dequeueAudit: { ...last.dequeueAudit, attempts: 2 } });
        const before = await storage.sql`select * from resource_inbox where fk_ext_bank_id = ${storage.namespace} order by ri_row_id`;
        await expect(queue.releaseEntries(toCompletedReleases(storage.reserved))).rejects.toMatchObject({
            code: 'resource-inbox-lost-reservation',
            key: last.key
        });
        expect(await storage.sql`select * from resource_inbox where fk_ext_bank_id = ${storage.namespace} order by ri_row_id`).toEqual(before);
        expect(observed).toEqual([{ namespace: storage.namespace, sequence: 1, outcome: 'failed', availability: 'unavailable', reason: 'release-failed' }]);
    });

    postgresIt.each(['candidate', 'statement', 'transaction-completion'] as const)(
        'preserves original %s failure when diagnostics also throw',
        async (failure) => {
            const storage = await createReleaseStorage();
            const original = new Error(`owned ${failure} failure`);
            const source = storage.sql;
            const sql = Object.assign(source.bind(undefined), {
                begin: async <T>(write: PSqlTransactionWrite<T>): Promise<T> =>
                    await source.begin(async (transaction) => {
                        const result = await write(failure === 'statement' ? createCompletionSql(transaction, () => Promise.reject(original)) : transaction);
                        if (failure === 'transaction-completion') {
                            throw original;
                        }
                        return result;
                    })
            });
            const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), () => {
                if (failure === 'candidate') {
                    throw original;
                }
                return Temporal.Now.instant();
            }, {
                namespace: storage.namespace,
                port: {
                    readMonotonicMs: () => 1,
                    readEpochMs: () => 10_000,
                    record: () => {
                        throw new Error('sink failed');
                    }
                }
            });
            await expect(queue.releaseEntries(toCompletedReleases(storage.reserved))).rejects.toBe(original);
            for (const entry of storage.reserved) {
                expect(await storage.other.entries.findAnyByKey(entry.key)).toEqual(entry);
            }
        }
    );

    postgresIt('preserves a returned-row decoding failure and rolls back its UPDATE', async () => {
        const storage = await createReleaseStorage();
        const original = new Error('returned row decoding failed');
        const observations: PSqlQueueReleaseTiming.Observation[] = [];
        const source = storage.sql;
        const sql = Object.assign(source.bind(undefined), {
            begin: async <T>(write: PSqlTransactionWrite<T>): Promise<T> =>
                await source.begin(async (transaction) =>
                    await write(createCompletionSql(transaction, async (rows) => {
                        if (!Array.isArray(rows) || rows.length !== 16 || typeof rows[0] !== 'object' || rows[0] === null) {
                            throw new Error('Expected the sixteen rows of the one real UPDATE');
                        }
                        Object.defineProperty(rows[0], 'ri_resource', {
                            get: () => {
                                throw original;
                            }
                        });
                    }))
                )
        });
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant, {
            namespace: storage.namespace,
            port: { readMonotonicMs: () => 1, readEpochMs: () => 10_000, record: (value) => observations.push(value) }
        });
        await expect(queue.releaseEntries(toCompletedReleases(storage.reserved))).rejects.toBe(original);
        expect(observations).toEqual([{
            namespace: storage.namespace,
            sequence: 1,
            outcome: 'failed',
            availability: 'unavailable',
            reason: 'release-failed'
        }]);
        for (const entry of storage.reserved) {
            expect(await storage.other.entries.findAnyByKey(entry.key)).toEqual(entry);
        }
    });

    postgresIt('preserves a real deferred-constraint COMMIT error and rolls back released rows', async () => {
        const storage = await createReleaseStorage();
        const observations: PSqlQueueReleaseTiming.Observation[] = [];
        let originalError: Error | undefined;
        const source = storage.sql;
        const sql = Object.assign(source.bind(undefined), {
            begin: async <T>(write: PSqlTransactionWrite<T>): Promise<T> => {
                try {
                    return await source.begin(async (transaction) => {
                        await transaction`create temporary table release_commit_fault (
                            id integer primary key, parent integer references release_commit_fault(id) deferrable initially deferred
                        ) on commit drop`;
                        await transaction`insert into release_commit_fault (id, parent) values (1, 2)`;
                        return await write(transaction);
                    });
                }
                catch (error) {
                    if (!(error instanceof Error)) {
                        throw error;
                    }
                    originalError = error;
                    throw error;
                }
            }
        });
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant, {
            namespace: storage.namespace,
            port: {
                readMonotonicMs: () => 1,
                readEpochMs: () => 10_000,
                record: (observation) => observations.push(observation)
            }
        });
        const pending = queue.releaseEntries(toCompletedReleases(storage.reserved));
        await expect(pending).rejects.toMatchObject({ code: '23503' });
        await expect(pending).rejects.toBe(originalError);
        expect(observations).toEqual([{
            namespace: storage.namespace,
            sequence: 1,
            outcome: 'failed',
            availability: 'unavailable',
            reason: 'release-failed'
        }]);
        for (const entry of storage.reserved) {
            expect(await storage.other.entries.findAnyByKey(entry.key)).toEqual(entry);
        }
    });

    postgresIt.each(['nan', 'infinite', 'throwing', 'regressing', 'epoch'] as const)(
        'makes %s clock evidence unavailable without affecting durable release',
        async (failure) => {
            const storage = await createReleaseStorage();
            const observed: PSqlQueueReleaseTiming.Observation[] = [];
            let atMs = 10;
            const queue = new PSqlQueueBox(storage.repository, () => {
                atMs = 5;
                return Temporal.Now.instant();
            }, {
                namespace: storage.namespace,
                port: {
                    readMonotonicMs: () => {
                        if (failure === 'throwing') {
                            throw new Error('clock failed');
                        }
                        return failure === 'nan' ? NaN : failure === 'infinite' ? Infinity : failure === 'regressing' ? atMs : 1;
                    },
                    readEpochMs: () => failure === 'epoch' ? NaN : 10_000,
                    record: (value) => observed.push(value)
                }
            });
            const released = await queue.releaseEntries(toCompletedReleases(storage.reserved));
            expect(released.size).toBe(16);
            expect(observed).toEqual([{
                namespace: storage.namespace,
                sequence: 1,
                outcome: 'succeeded',
                availability: 'unavailable',
                reason: 'invalid-clock'
            }]);
            for (const entry of released.values()) {
                expect(await storage.other.entries.findAnyByKey(entry.key)).toEqual(entry);
            }
        }
    );

    postgresIt('releases durably with absent timing capability and a throwing sink', async () => {
        const storage = await createReleaseStorage();
        const disabled = new PSqlQueueBox(storage.repository, Temporal.Now.instant);
        const first = await disabled.releaseEntries(toCompletedReleases(storage.reserved.slice(0, 8)));
        const enabled = createObservedQueue(storage, () => {
            throw new Error('sink failed');
        });
        const second = await enabled.releaseEntries(toCompletedReleases(storage.reserved.slice(8)));
        expect(first.size + second.size).toBe(16);
        for (const entry of [...first.values(), ...second.values()]) {
            expect(await storage.other.entries.findAnyByKey(entry.key)).toEqual(entry);
        }
    });

    postgresIt('bounds member evidence while releasing every member of an oversized invocation', async () => {
        const storage = await createReleaseStorage(17);
        const observed: PSqlQueueReleaseTiming.Observation[] = [];
        const queue = createObservedQueue(storage, (value) => observed.push(value));
        expect((await queue.releaseEntries(toCompletedReleases(storage.reserved))).size).toBe(17);
        expect(observed[0]).toMatchObject({ outcome: 'succeeded', availability: 'available', memberCount: 17, eligible: false, truncated: true });
        if (observed[0]?.availability !== 'available') {
            throw new Error('Expected bounded evidence');
        }
        expect(observed[0].members).toHaveLength(16);
        expect(JSON.stringify(observed)).not.toContain('payload must never enter diagnostics');
    });

    postgresIt('wires release capture only into the outbound store when its capability is present', async () => {
        const storage = await createReleaseStorage();
        const observed: PSqlQueueReleaseTiming.Observation[] = [];
        const options = {
            repository: new PSqlRuntimeStateRepository(storage.sql),
            namespace: storage.namespace,
            outboundReleaseTiming: {
                readMonotonicMs: () => 1,
                readEpochMs: () => 10_000,
                record: (value: PSqlQueueReleaseTiming.Observation) => observed.push(value)
            }
        };
        const inbound = createDefaultPSqlALInboundRuntimeStores({
            ...options,
            maxDeliveredMarkers: AL_INBOUND_MAX_DELIVERED_MARKERS
        });
        const disabled = createDefaultPSqlALOutboundRuntimeStores({
            repository: options.repository,
            namespace: storage.namespace,
            decodePrepared: () => 'unused'
        });
        const outbound = createDefaultPSqlALOutboundRuntimeStores({ ...options, decodePrepared: () => 'unused' });
        await inbound.workQueue.releaseEntries(toCompletedReleases(storage.reserved.slice(0, 4)));
        await disabled.workQueue.releaseEntries(toCompletedReleases(storage.reserved.slice(4, 8)));
        expect(observed).toEqual([]);
        await outbound.workQueue.releaseEntries(toCompletedReleases(storage.reserved.slice(8)));
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({ namespace: `${storage.namespace}:outbound:admission`, memberCount: 8, sequence: 1 });
    });

    postgresIt('marks an accepted idempotent fallback ineligible without changing its returned row', async () => {
        const storage = await createReleaseStorage(16, EnqueuedType.WS_OUTBOX);
        const observed: PSqlQueueReleaseTiming.Observation[] = [];
        const entry = storage.reserved[15]!;
        const endTs = Temporal.Now.instant().round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' });
        const current = await storage.other.entries.replaceIfObserved(entry, {
            ...entry,
            status: EntityStatus.RETRY,
            dequeueAudit: { ...entry.dequeueAudit, endTs, nextTs: endTs.add({ seconds: 10 }) }
        });
        const result = await createObservedQueue(storage, (value) => observed.push(value)).releaseEntries(toCompletedReleases(storage.reserved));
        expect([...result.values()][15]).toEqual(current);
        expect(observed[0]).toMatchObject({ availability: 'available', eligible: false, fallbackCount: 1, memberCount: 16 });
    });
});

interface ReleaseStorage {
    readonly namespace: string;
    readonly sql: PostgresSql;
    readonly repository: PSqlResourceInboxRepository;
    readonly other: PSqlResourceInboxRepository;
    readonly reserved: readonly ResourceEntry[];
}

async function createReleaseStorage(count = 16, typeId?: string): Promise<ReleaseStorage> {
    const namespace = crypto.randomUUID();
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await sql`delete from resource_inbox where fk_ext_bank_id = ${namespace}`;
        }
        finally {
            await sql.end();
        }
    });
    const otherSql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(() => otherSql.end());
    const repository = createPSqlResourceInboxRepository(sql, () => new Date());
    const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
        await queue.enqueue({ ...toReleaseEntry(namespace, ordinal), typeId: typeId ?? namespace });
    }
    const reserved = [
        ...(await queue.reserveEntries({ typeIds: new Set([typeId ?? namespace]), statusIds: new Set([EntityStatus.NEW]), reservationInput: count })).values()
    ];
    expect(reserved).toHaveLength(count);
    return { namespace, sql, repository, other: createPSqlResourceInboxRepository(otherSql, () => new Date()), reserved };
}

function toReleaseEntry(namespace: string, ordinal: number): ResourceEntry {
    return {
        key: { topicId: 'release-timing', contextId: namespace, resourceId: String(ordinal) },
        typeId: namespace,
        resource: 'payload must never enter diagnostics',
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        dequeueAudit: { attempts: 0 }
    };
}

interface ReleaseGates {
    readonly sql: PSqlSql;
    readonly clock: { atMs: number; };
    readonly statementReached: PromiseWithResolvers<void>;
    readonly statementCompleted: PromiseWithResolvers<void>;
    readonly callbackReturned: PromiseWithResolvers<void>;
    readonly transactionCompleted: PromiseWithResolvers<void>;
}

function createReleaseGates(source: PSqlSql): ReleaseGates {
    const clock = { atMs: 0 };
    const statementReached = Promise.withResolvers<void>();
    const statementCompleted = Promise.withResolvers<void>();
    const callbackReturned = Promise.withResolvers<void>();
    const transactionCompleted = Promise.withResolvers<void>();
    onTestFinished(() => {
        statementCompleted.resolve();
        transactionCompleted.resolve();
    });
    let updates = 0;
    const sql = Object.assign(source.bind(undefined), {
        begin: async <T>(write: PSqlTransactionWrite<T>): Promise<T> => {
            const result = await source.begin(async (transaction) => {
                clock.atMs = 12;
                const gated = createCompletionSql(transaction, async () => {
                    updates += 1;
                    if (updates === 1) {
                        statementReached.resolve();
                        await statementCompleted.promise;
                    }
                });
                const result = await write(gated);
                callbackReturned.resolve();
                await transactionCompleted.promise;
                return result;
            });
            return result;
        }
    });
    return { sql, clock, statementReached, statementCompleted, callbackReturned, transactionCompleted };
}

/** The fault/gate observes raw rows at the existing SQL port before the repository decodes them. */
function createCompletionSql(source: PSqlSql, completed: <T>(rows: T) => Promise<void>): PSqlSql {
    function sql<T>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<T>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<T>(stringsOrValues: TemplateStringsArray | readonly PSqlParameter[], ...values: readonly PSqlParameter[]): object | Promise<T> {
        if (!('raw' in stringsOrValues)) {
            return source(stringsOrValues);
        }
        return source<T>(stringsOrValues, ...values).then(async (rows) => {
            if (stringsOrValues.join(' ').includes('update resource_inbox')) {
                await completed(rows);
            }
            return rows;
        });
    }
    return Object.assign(sql, { begin: source.begin.bind(source) });
}

function toCompletedReleases(entries: readonly ResourceEntry[]): readonly ResourceInboxRelease[] {
    return entries.map((entry) => ({ entry, disposition: { status: EntityStatus.COMPLETED, delayMs: null } }));
}

function createObservedQueue(storage: ReleaseStorage, record: PSqlQueueReleaseTiming.Port['record']): PSqlQueueBox {
    return new PSqlQueueBox(storage.repository, Temporal.Now.instant, {
        namespace: storage.namespace,
        port: { readMonotonicMs: () => 1, readEpochMs: () => 10_000, record }
    });
}
