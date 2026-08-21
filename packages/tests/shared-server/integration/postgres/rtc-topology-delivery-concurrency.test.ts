import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/postgres/rtc-topology/p-sql-rtc-topology-delivery-repository.ts';
import type {
    RtcTopologyDeliveryAppendInput,
    RtcTopologyDeliveryAppendResult
} from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-contracts.ts';
import { isRtcTopologyDeliveryRetryableConflict } from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-validation.ts';
import { createPostgresSql, type PostgresSql } from '../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

interface AppendOutcome {
    readonly backendPid: number;
    readonly result: RtcTopologyDeliveryAppendResult;
}

describe('Postgres RTC topology delivery concurrency', () => {
    postgresIt(
        'keeps a same-stream HEAD gap-free across a true-overlap conflict and rollback',
        async () => {
            await withDeliveryDatabases(async ({ sqlA, sqlB, observer, streams, pending, releases }) => {
                const streamId = crypto.randomUUID();
                streams.push(streamId);
                const repositoryA = new PSqlRtcTopologyDeliveryRepository(sqlA);
                const repositoryB = new PSqlRtcTopologyDeliveryRepository(sqlB);
                await registerStream(repositoryA, streamId);

                const firstAppended = deferred<void>();
                const releaseFirst = deferred<void>();
                releases.push(releaseFirst.resolve);
                const first = sqlA.begin(async (transaction) => {
                    const backendPid = await readBackendPid(transaction);
                    const result = await repositoryA.appendOrValidate(
                        transaction,
                        appendInput(streamId, 'same-stream-first')
                    );
                    firstAppended.resolve();
                    await releaseFirst.promise;
                    return { backendPid, result };
                });
                pending.push(first);
                await firstAppended.promise;

                const secondBackendPid = deferred<number>();
                const second = sqlB.begin(async (transaction) => {
                    secondBackendPid.resolve(await readBackendPid(transaction));
                    return await repositoryB.appendOrValidate(
                        transaction,
                        appendInput(streamId, 'same-stream-second')
                    );
                });
                pending.push(second);
                const blockedPid = await secondBackendPid.promise;
                await waitForBlockedBackend(observer, blockedPid);
                releaseFirst.resolve();

                const firstOutcome = await first;
                const secondResult = await second;
                expect(firstOutcome.result).toMatchObject({
                    status: 'appended',
                    entry: { sequence: 1 }
                });
                expect(secondResult).toEqual({ status: 'conflict' });
                expect(firstOutcome.backendPid).not.toBe(blockedPid);

                await expect(
                    sqlB.begin(
                        async (transaction) =>
                            await repositoryB.appendOrValidate(
                                transaction,
                                appendInput(streamId, 'same-stream-second')
                            )
                    )
                ).resolves.toMatchObject({ status: 'appended', entry: { sequence: 2 } });
                await expect(
                    sqlB.begin(async (transaction) => {
                        await repositoryB.appendOrValidate(
                            transaction,
                            appendInput(streamId, 'same-stream-rolled-back')
                        );
                        throw new Error('abort delivery append');
                    })
                ).rejects.toThrow('abort delivery append');

                expect(await readHead(sqlA, streamId)).toBe(2);
                expect(await readSequences(sqlA, streamId)).toEqual([1, 2]);
            });
        },
        60_000
    );

    postgresIt(
        'lets independent publisher streams commit without waiting on one mutable HEAD',
        async () => {
            await withDeliveryDatabases(async ({ sqlA, sqlB, streams, pending, releases }) => {
                const streamA = crypto.randomUUID();
                const streamB = crypto.randomUUID();
                streams.push(streamA, streamB);
                const repositoryA = new PSqlRtcTopologyDeliveryRepository(sqlA);
                const repositoryB = new PSqlRtcTopologyDeliveryRepository(sqlB);
                await registerStream(repositoryA, streamA);
                await registerStream(repositoryB, streamB);

                const firstAppended = deferred<void>();
                const releaseFirst = deferred<void>();
                releases.push(releaseFirst.resolve);
                const first = sqlA.begin(async (transaction): Promise<AppendOutcome> => {
                    const backendPid = await readBackendPid(transaction);
                    const result = await repositoryA.appendOrValidate(
                        transaction,
                        appendInput(streamA, 'independent-a')
                    );
                    firstAppended.resolve();
                    await releaseFirst.promise;
                    return { backendPid, result };
                });
                pending.push(first);
                await firstAppended.promise;

                const second = sqlB.begin(async (transaction): Promise<AppendOutcome> => ({
                    backendPid: await readBackendPid(transaction),
                    result: await repositoryB.appendOrValidate(
                        transaction,
                        appendInput(streamB, 'independent-b')
                    )
                }));
                pending.push(second);
                const secondOutcome = await completeWithin(second, 2_000);
                releaseFirst.resolve();
                const firstOutcome = await first;

                expect(firstOutcome.backendPid).not.toBe(secondOutcome.backendPid);
                expect(firstOutcome.result).toMatchObject({
                    status: 'appended',
                    entry: { publisherStreamId: streamA, sequence: 1 }
                });
                expect(secondOutcome.result).toMatchObject({
                    status: 'appended',
                    entry: { publisherStreamId: streamB, sequence: 1 }
                });
                expect(await readHead(sqlA, streamA)).toBe(1);
                expect(await readHead(sqlA, streamB)).toBe(1);
            });
        },
        60_000
    );

    postgresIt(
        'rolls back the losing stream HEAD when A and B race one canonical publication',
        async () => {
            await withDeliveryDatabases(async ({ sqlA, sqlB, observer, streams, pending, releases }) => {
                const streamA = crypto.randomUUID();
                const streamB = crypto.randomUUID();
                streams.push(streamA, streamB);
                const repositoryA = new PSqlRtcTopologyDeliveryRepository(sqlA);
                const repositoryB = new PSqlRtcTopologyDeliveryRepository(sqlB);
                await registerStream(repositoryA, streamA);
                await registerStream(repositoryB, streamB);
                const publicationName = 'canonical-publication-race';
                const winnerInput = appendInput(streamA, publicationName);
                const loserInput = { ...winnerInput, publisherStreamId: streamB };

                const winnerAppended = deferred<void>();
                const releaseWinner = deferred<void>();
                releases.push(releaseWinner.resolve);
                const winner = sqlA.begin(async (transaction) => {
                    const result = await repositoryA.appendOrValidate(transaction, winnerInput);
                    winnerAppended.resolve();
                    await releaseWinner.promise;
                    return result;
                });
                pending.push(winner);
                await winnerAppended.promise;

                const loserBackendPid = deferred<number>();
                const loser = sqlB.begin(async (transaction) => {
                    loserBackendPid.resolve(await readBackendPid(transaction));
                    return await repositoryB.appendOrValidate(transaction, loserInput);
                });
                pending.push(loser);
                await waitForBlockedBackend(observer, await loserBackendPid.promise);
                releaseWinner.resolve();

                await expect(winner).resolves.toMatchObject({
                    status: 'appended',
                    entry: { publisherStreamId: streamA, sequence: 1 }
                });
                const loserError = await captureError(loser);
                expect(isRtcTopologyDeliveryRetryableConflict(loserError)).toBe(true);
                expect(await readHead(sqlA, streamA)).toBe(1);
                expect(await readHead(sqlA, streamB)).toBe(0);
                expect(await readSequences(sqlA, streamA)).toEqual([1]);
                expect(await readSequences(sqlA, streamB)).toEqual([]);

                await expect(
                    sqlB.begin(
                        async (transaction) => await repositoryB.appendOrValidate(transaction, loserInput)
                    )
                ).resolves.toMatchObject({
                    status: 'existing',
                    entry: { publisherStreamId: streamA, sequence: 1 }
                });
                expect(await readHead(sqlA, streamB)).toBe(0);
            });
        },
        60_000
    );

    postgresIt('compacts with millisecond-precise PostgreSQL clock values', async () => {
        await withDeliveryDatabases(async ({ sqlA, streams }) => {
            const streamId = crypto.randomUUID();
            streams.push(streamId);
            const repository = new PSqlRtcTopologyDeliveryRepository(sqlA);
            await registerStream(repository, streamId);
            await sqlA.begin(
                async (transaction) =>
                    await repository.appendOrValidate(transaction, {
                        ...appendInput(streamId, 'expired-for-compaction'),
                        retainUntilEpochMs: 0
                    })
            );

            await expect(repository.compactExpiredEntries({ pageSize: 1_000 })).resolves.toMatchObject({
                deletedEntryCount: expect.any(Number)
            });
            expect(await readSequences(sqlA, streamId)).toEqual([]);
        });
    });
});

interface DeliveryDatabases {
    readonly sqlA: PostgresSql;
    readonly sqlB: PostgresSql;
    readonly observer: PostgresSql;
    readonly streams: string[];
    readonly pending: Promise<unknown>[];
    readonly releases: Array<() => void>;
}

async function withDeliveryDatabases(
    run: (databases: DeliveryDatabases) => Promise<void>
): Promise<void> {
    const databaseUrl = requireDatabaseUrl();
    const sqlA = await createPostgresSql(databaseUrl);
    const sqlB = await createPostgresSql(databaseUrl);
    const observer = await createPostgresSql(databaseUrl);
    const streams: string[] = [];
    const pending: Promise<unknown>[] = [];
    const releases: Array<() => void> = [];
    try {
        await run({ sqlA, sqlB, observer, streams, pending, releases });
    }
    finally {
        for (const release of releases) {
            release();
        }
        await Promise.allSettled(pending);
        if (streams.length > 0) {
            await observer`
        delete from rtc_topology_delivery_log
        where publisher_stream_id = any(${streams}::uuid[])
      `;
            await observer`
        delete from rtc_topology_delivery_stream
        where stream_id = any(${streams}::uuid[])
      `;
        }
        await Promise.all([sqlA.end(), sqlB.end(), observer.end()]);
    }
}

async function registerStream(
    repository: PSqlRtcTopologyDeliveryRepository,
    streamId: string
): Promise<void> {
    await expect(
        repository.registerStream({ streamId, leaseDurationMs: 60_000 })
    ).resolves.toMatchObject({ status: 'registered' });
}

function appendInput(
    publisherStreamId: string,
    publicationName: string
): RtcTopologyDeliveryAppendInput {
    return {
        publisherStreamId,
        groupRef: {
            applicationId: `delivery-concurrency-${publicationName}`,
            workspaceId: 'postgres',
            groupId: 'room'
        },
        publicationId: publicationName,
        outboxKey: {
            topicId: 'rtc-topology-publication',
            resourceId: publicationName,
            contextId: 'postgres:room'
        },
        retainUntilEpochMs: Date.now() + 60_000
    };
}

async function readBackendPid(sql: PSqlSql): Promise<number> {
    const rows = await sql<Readonly<{ pid: number; }>[]>`
    select pg_backend_pid()::integer as pid
  `;
    const pid = rows[0]?.pid;
    if (!pid) {
        throw new Error('Postgres did not return a backend PID');
    }
    return pid;
}

async function waitForBlockedBackend(sql: PSqlSql, backendPid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const rows = await sql<Readonly<{ blocked: boolean; }>[]>`
      select exists (
        select 1 from pg_locks where pid = ${backendPid} and not granted
      ) as blocked
    `;
        if (rows[0]?.blocked) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Postgres backend ${backendPid} did not enter a lock wait`);
}

async function readHead(sql: PSqlSql, streamId: string): Promise<number | undefined> {
    const rows = await sql<Readonly<{ head_sequence: number; }>[]>`
    select head_sequence::integer as head_sequence
    from rtc_topology_delivery_stream
    where stream_id = ${streamId}
  `;
    return rows[0]?.head_sequence;
}

async function readSequences(sql: PSqlSql, streamId: string): Promise<readonly number[]> {
    const rows = await sql<Readonly<{ sequence: number; }>[]>`
    select sequence::integer as sequence
    from rtc_topology_delivery_log
    where publisher_stream_id = ${streamId}
    order by sequence
  `;
    return rows.map((row) => row.sequence);
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    }
    catch (error) {
        if (error instanceof Error) {
            return error;
        }
        throw new Error('Postgres rejected with a non-Error value', { cause: error });
    }
    throw new Error('Expected Postgres transaction to reject');
}

async function completeWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Operation did not complete within ${timeoutMs}ms`)),
                    timeoutMs
                );
            })
        ]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
}> {
    let resolve = (_value: T): void => undefined;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when Postgres integration is enabled');
    }
    return databaseUrl;
}
