import { Temporal } from '@js-temporal/polyfill';
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import type {
    ResourceInboxReservationObservationRequest,
    ResourceInboxReservationObservationResult,
    ResourceInboxReservationRequest
} from '@shared/queuebox/queue-box-types.ts';
import { createDefaultResourceInboxDequeuer } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { NotReadyException } from '@shared/queuebox/resource-inbox/not-ready-exception.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';

import { computeStateWriteDiagnosticPhase } from '../../../../apps/api-v1/scripts/perf/state-write/state-write-diagnostic-projection.ts';
import {
    createResourceInboxTestStorage,
    recordResourceInboxStatements,
    seedResourceInboxRow,
    type ResourceInboxTestStorage
} from './resource-inbox-test-storage.ts';

let storage: ResourceInboxTestStorage;
beforeAll(async () => {
    storage = await createResourceInboxTestStorage('retry_attribution');
});
afterAll(async () => await storage?.close());
beforeEach(async () => {
    await storage.sql`delete from resource_inbox`;
});

describe('ordinary PostgreSQL retry attribution', () => {
    it('preserves the preceding persisted delay through handler, release and redacted projection', async () => {
        const key = await seedResourceInboxRow(storage.sql, {
            resourceId: 'PRIVATE:profile-instance:0-profile',
            status: EntityStatus.RETRY,
            attempts: 1,
            startedAgoSeconds: 10,
            endedAgoSeconds: 8,
            nextInSeconds: -3
        });
        await storage.sql`update resource_inbox set system_date = created_ts::date, ri_topic_id = 'CLIENT_PRINCIPAL_UPSERT',
            fk_ext_bank_id = 'application-PRIVATE-ap-chsq5tya15k6' where ri_resource_id = ${key.resourceId}`;
        const repository = createPSqlResourceInboxRepository(storage.sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
        const releases: ResourceInboxAttemptReleaseTelemetry[] = [];
        const handled: number[] = [];
        await createRetryDequeuer(queue, releases).dequeueForCompute(async (_key, attempt) => {
            expect(attempt.entry.dequeueAudit.nextTs).toBeUndefined();
            handled.push(attempt.entry.dequeueAudit.attempts);
            return 'accepted';
        });
        expect(handled).toEqual([2]);
        expect(releases).toHaveLength(1);
        expect.soft(releases[0]).toMatchObject({
            status: EntityStatus.COMPLETED,
            retryDelayMs: 0,
            reservationObservation: {
                availability: 'available',
                reservationAttempt: 2,
                previousPersistedRetryDelayUs: 5_000_000,
                dueToReservationObservationUs: expect.any(Number)
            }
        });
        const projection = computeStateWriteDiagnosticPhase(
            {
                workload: 'hot',
                phase: 'measured',
                runIndex: 0,
                scope: { applicationId: 'PRIVATE-application', workspaceId: 'PRIVATE-workspace' },
                groupCount: 5,
                serviceIds: ['PRIVATE-worker'],
                performanceTimeOriginEpochMs: 100_000,
                startedAtMonotonicMs: 10,
                endedAtMonotonicMs: 100,
                commands: [{ commandId: 'PRIVATE:profile-instance:0', kind: 'profile-instance', stackIndex: 0, status: 'accepted' }],
                boundaries: [{ commandId: 'PRIVATE:profile-instance:0', startedAtMonotonicMs: 20, endedAtMonotonicMs: 90 }],
                timingEvents: [],
                releases,
                outcome: 'completed'
            },
            { eventsPerPhase: 100, bytesPerPhase: 32_768, bytesPerRun: 65_536 },
            65_536
        );
        expect(projection.complete).toBe(true);
        expect.soft(projection.serialized).toContain('rallar.state-write.diagnostic.v3');
        expect.soft(projection.serialized).toContain('"previousPersistedRetryDelayUs":5000000');
        expect(projection.serialized).not.toContain('PRIVATE');
    });
});

describe('PostgreSQL reservation observation boundaries', () => {
    it.each([false, true])('preserves claim order and attempts with context heads %s', async (contextHeads) => {
        await seedRetry('first');
        await seedRetry('second');
        const queue = createQueue(storage.sql);
        const result = await queue.reserveEntries({
            typeIds: new Set(['APP_INBOX']),
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: 2,
            ...(contextHeads ? { contextClaim: { excludedContextIds: new Set<string>() } } : {}),
            reservationObservation: 'postgres-ordinary-retry-v1'
        });
        expect([...result.entries.values()].map((entry) => [entry.key.resourceId, entry.dequeueAudit.attempts, entry.dequeueAudit.nextTs]))
            .toEqual(contextHeads ? [['first', 2, undefined]] : [['first', 2, undefined], ['second', 2, undefined]]);
        expect(result.observations).toHaveLength(result.entries.size);
        for (const observation of result.observations) {
            expect(observation).toMatchObject({ availability: 'available', previousPersistedRetryDelayUs: 5_000_000, reservationAttempt: 2 });
            if (observation.availability === 'available') {
                expect(observation.dueToReservationObservationUs).toBeGreaterThanOrEqual(3_000_000);
            }
        }
    });

    it('keeps disabled SQL free of added clocks and reports observed claims unavailable', async () => {
        const key = await seedRetry('ordinary');
        const statements: string[] = [];
        const queue = createQueue(recordResourceInboxStatements(storage.sql, statements));
        const observed = (await queue.getItem(key))!;
        statements.length = 0;
        const result = await queue.reserveEntries({
            typeIds: new Set(['APP_INBOX']),
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: 1
        });
        expect(result).toBeInstanceOf(Map);
        expect(statements).toHaveLength(3);
        expect(statements.join(' ')).not.toContain('clock_timestamp');
        await seedRetry('observed');
        const current = (await queue.getItem({ ...key, resourceId: 'observed' }))!;
        const captured = await queue.reserveEntries({
            typeIds: new Set(['APP_INBOX']),
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: 2,
            observedEntries: [observed, current],
            reservationObservation: 'postgres-ordinary-retry-v1'
        });
        expect([...captured.entries.values()].map((entry) => entry.key.resourceId)).toEqual(['observed']);
        expect(captured.observations).toMatchObject([{ availability: 'unavailable', reason: 'observed-claim-not-captured' }]);
    });

    it('retains exact signed microseconds with subtraction before conversion', async () => {
        const rows = await storage.sql<readonly { duration: string; }[]>`
            select trunc(extract(epoch from (later - earlier)) * 1000000)::text as duration
            from (values
                (timestamp '2026-01-01 00:00:00.000001', timestamp '2026-01-01 00:00:00'),
                (timestamp '2026-01-01 00:00:00', timestamp '2026-01-01 00:00:00.000001'),
                (timestamp '2026-01-01 00:00:00.001001', timestamp '2026-01-01 00:00:00.000999'),
                (timestamp '2026-01-01 00:00:00.000499', timestamp '2026-01-01 00:00:00.001001')
            ) as instants(later, earlier)
        `;
        expect(rows.map((row) => row.duration)).toEqual(['1', '-1', '2', '-502']);
    });

    it('returns root observations only after held commit with RETURNING inside database clock brackets', async () => {
        await storage.sql`set time zone 'Pacific/Auckland'`;
        await seedRetry('held');
        const statements: string[] = [];
        const gated = recordResourceInboxStatements(storage.sql, statements);
        const returned = Promise.withResolvers<void>();
        const commit = Promise.withResolvers<void>();
        let before = 0;
        let after = 0;
        let transactionStarted = 0;
        gated.begin = async (write) =>
            await storage.sql.begin(async (transaction) => {
                const [start] = await transaction<readonly { age: string; }[]>`select
                (extract(epoch from ((now() at time zone 'UTC') - next_ts)) * 1000000)::text as age
                from resource_inbox where ri_resource_id = 'held'`;
                transactionStarted = Number(start.age);
                await transaction`select pg_sleep(0.025)`;
                before = await readDueAge(transaction, 'held');
                const result = await write(transaction);
                after = await readAgeFromSelectedDue(transaction);
                returned.resolve();
                await commit.promise;
                return result;
            });
        let resolved = false;
        const reservation = createQueue(gated).reserveEntries({
            typeIds: new Set(['APP_INBOX']),
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: 1,
            reservationObservation: 'postgres-ordinary-retry-v1'
        }).then((value) => {
            resolved = true;
            return value;
        });
        try {
            await Promise.race([returned.promise, reservation.then(() => {})]);
            expect(resolved).toBe(false);
        }
        finally {
            commit.resolve();
        }
        const result = await reservation;
        const observation = result.observations[0];
        expect(observation.availability).toBe('available');
        if (observation.availability === 'available') {
            expect(observation.dueToReservationObservationUs).toBeGreaterThan(transactionStarted);
            expect(observation.dueToReservationObservationUs).toBeGreaterThanOrEqual(before);
            expect(observation.dueToReservationObservationUs).toBeLessThanOrEqual(after);
        }
    });
});

function createQueue(sql: PSqlSql): PSqlQueueBox {
    return new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);
}

async function seedRetry(resourceId: string) {
    const key = await seedResourceInboxRow(storage.sql, {
        resourceId,
        status: EntityStatus.RETRY,
        attempts: 1,
        startedAgoSeconds: 10,
        endedAgoSeconds: 8,
        nextInSeconds: -3
    });
    await storage.sql`update resource_inbox set system_date = created_ts::date where ri_resource_id = ${resourceId}`;
    return key;
}

async function readDueAge(sql: PSqlSql, resourceId: string): Promise<number> {
    const [row] = await sql<readonly { age: string; }[]>`select
        (extract(epoch from ((clock_timestamp() at time zone 'UTC') - next_ts)) * 1000000)::text as age
        from resource_inbox where ri_resource_id = ${resourceId}`;
    return Number(row.age);
}

async function readAgeFromSelectedDue(sql: PSqlSql): Promise<number> {
    const [row] = await sql<readonly { age: string; }[]>`select
        (extract(epoch from ((clock_timestamp() at time zone 'UTC') - (created_ts - interval '3 seconds'))) * 1000000)::text as age
        from resource_inbox where ri_resource_id = 'held'`;
    return Number(row.age);
}

describe('claim transaction failure evidence', () => {
    it('keeps a nested provisional observation inside an outer transaction that rolls back', async () => {
        const key = await seedRetry('nested');
        let emitted = false;
        await expect(
            storage.sql.begin(async (transaction) => {
                const result = await capture(createQueue(transaction));
                expect(result.observations).toMatchObject([{ availability: 'available' }]);
                throw new Error('outer rollback');
            }).then(() => {
                emitted = true;
            })
        ).rejects.toThrow('outer rollback');
        expect(emitted).toBe(false);
        expect(await createQueue(storage.sql).getItem(key)).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    });

    it('publishes no observation after rollback or an unknown commit outcome', async () => {
        for (const outcome of ['rollback', 'unknown-commit'] as const) {
            await storage.sql`delete from resource_inbox`;
            const key = await seedRetry(outcome);
            const failing = recordResourceInboxStatements(storage.sql, []);
            failing.begin = async (write) => {
                const result = await storage.sql.begin(async (transaction) => {
                    const written = await write(transaction);
                    if (outcome === 'rollback') {
                        throw new Error(outcome);
                    }
                    return written;
                });
                void result;
                throw new Error(outcome);
            };
            let emitted = false;
            await expect(
                capture(createQueue(failing)).then(() => {
                    emitted = true;
                })
            ).rejects.toThrow(outcome);
            expect(emitted).toBe(false);
            expect((await createQueue(storage.sql).getItem(key))?.status).toBe(outcome === 'rollback' ? EntityStatus.RETRY : EntityStatus.RESERVED);
        }
    });

    it('returns no successful observation when the actual database commit fails', async () => {
        const key = await seedRetry('commit-failure');
        await storage.sql`create function reject_claim_commit() returns trigger language plpgsql as
            'begin raise exception ''claim commit rejected''; end'`;
        await storage.sql`create constraint trigger reject_claim_commit after update on resource_inbox
            deferrable initially deferred for each row execute function reject_claim_commit()`;
        try {
            let emitted = false;
            await expect(
                capture(createQueue(storage.sql)).then(() => {
                    emitted = true;
                })
            ).rejects.toThrow('claim commit rejected');
            expect(emitted).toBe(false);
            expect(await createQueue(storage.sql).getItem(key)).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
        }
        finally {
            await storage.sql`drop trigger reject_claim_commit on resource_inbox`;
            await storage.sql`drop function reject_claim_commit()`;
        }
    });
});

async function capture(queue: PSqlQueueBox) {
    return await queue.reserveEntries({
        typeIds: new Set(['APP_INBOX']),
        statusIds: new Set([EntityStatus.RETRY]),
        reservationInput: 1,
        reservationObservation: 'postgres-ordinary-retry-v1'
    });
}

function createRetryDequeuer(queue: PSqlQueueBox, releases: ResourceInboxAttemptReleaseTelemetry[]) {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return createDefaultResourceInboxDequeuer<string>({
        repository: queue,
        typesToDequeue: () => new Set(['APP_INBOX']),
        newLaneClaimOrder: 'queue',
        maxToReserve: () => 1,
        maxNumToDequeue: 1,
        workAdvertisement: { NEW: false, RETRY: true, FAIRNESS: false, TIMEOUT: false, FINALIZATION: false },
        resilience: ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 1,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        }),
        options: {
            reservationObservation: 'postgres-ordinary-retry-v1',
            onAttemptReleaseTelemetry: (release) => releases.push(release)
        }
    });
}

class CorruptedObservationQueue extends PSqlQueueBox {
    readonly corruption: 'missing' | 'duplicate' | 'wrong-attempt' | 'cross-context' | 'numeric';
    constructor(corruption: CorruptedObservationQueue['corruption']) {
        super(createPSqlResourceInboxRepository(storage.sql, () => new Date()), Temporal.Now.instant);
        this.corruption = corruption;
    }
    override reserveEntries(request: ResourceInboxReservationObservationRequest): Promise<ResourceInboxReservationObservationResult>;
    override reserveEntries(request: ResourceInboxReservationRequest): Promise<Map<Key, ResourceEntry>>;
    override async reserveEntries(
        request: ResourceInboxReservationObservationRequest | ResourceInboxReservationRequest
    ): Promise<ResourceInboxReservationObservationResult | Map<Key, ResourceEntry>> {
        if (!('reservationObservation' in request)) {
            return await super.reserveEntries(request);
        }
        const result = await super.reserveEntries(request);
        const observation = result.observations[0];
        if (!observation) {
            return result;
        }
        switch (this.corruption) {
            case 'missing':
                return { ...result, observations: [] };
            case 'duplicate':
                return { ...result, observations: [observation, observation] };
            case 'wrong-attempt':
                return { ...result, observations: [{ ...observation, reservationAttempt: 50 }] };
            case 'cross-context':
                return { ...result, observations: [{ ...observation, key: { ...observation.key, contextId: 'foreign' } }] };
            case 'numeric':
                return {
                    ...result,
                    observations: [observation.availability === 'available' ? { ...observation, dueToReservationObservationUs: NaN } : observation]
                };
        }
    }
}

describe('diagnostic failures preserve mandatory work', () => {
    it.each(['missing', 'duplicate', 'wrong-attempt', 'cross-context', 'numeric'] as const)(
        'handles and releases a claim with %s observation',
        async (corruption) => {
            const key = await seedRetry(corruption);
            const queue = new CorruptedObservationQueue(corruption);
            const releases: ResourceInboxAttemptReleaseTelemetry[] = [];
            let handled = false;
            await createRetryDequeuer(queue, releases).dequeueForCompute(async () => {
                handled = true;
                return 'accepted';
            });
            expect(handled).toBe(true);
            expect(await queue.getItem(key)).toMatchObject({ status: EntityStatus.COMPLETED });
            expect(releases).toMatchObject([{ reservationObservation: { availability: 'unavailable', reason: 'invalid-observation' } }]);
        }
    );
    it('retains the reservation identity when not-ready release restores the preceding attempt', async () => {
        const key = await seedRetry('not-ready');
        const queue = createQueue(storage.sql);
        const releases: ResourceInboxAttemptReleaseTelemetry[] = [];
        await createRetryDequeuer(queue, releases).dequeueForCompute(async () => {
            throw new NotReadyException(1000);
        });
        expect(await queue.getItem(key)).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
        expect(releases).toMatchObject([{
            attempt: 1,
            classification: 'not-ready',
            retryDelayMs: 1000,
            reservationObservation: { availability: 'available', reservationAttempt: 2, previousPersistedRetryDelayUs: 5_000_000 }
        }]);
    });
    it('keeps concurrent captures independent without key identity matching', async () => {
        await seedRetry('capture-a');
        await seedRetry('capture-b');
        const queue = createQueue(storage.sql);
        const results = await Promise.all([capture(queue), capture(queue)]);
        expect(results.map((result) => [...result.entries.values()][0].key.resourceId).sort()).toEqual(['capture-a', 'capture-b']);
        for (const result of results) {
            expect(result.observations).toHaveLength(1);
            expect(result.observations[0].key).toEqual([...result.entries.values()][0].key);
        }
    });
});
