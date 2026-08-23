import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/postgres/rtc-topology/p-sql-rtc-topology-delivery-repository.ts';
import { toRtcTopologyPublicationId, toRtcTopologyPublicationMessageId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/topology/publication/rtc-topology-ws-outbox-entry.ts';
import {
    isRtcTopologyDeliveryRetryableConflict,
    readRtcTopologyDeliverySafeInteger,
    RtcTopologyDeliveryCorruptionError,
    toRtcTopologyDeliveryAppendInput
} from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { createPGliteSqlClient, type PGliteSql } from '../../../apps/api-v1/src/db/pglite-sql-adapter.ts';

describe('RTC topology delivery log boundary', () => {
    it('accepts only non-negative safe integer database values without coercion', () => {
        expect(readRtcTopologyDeliverySafeInteger(0, 'HEAD')).toBe(0);
        expect(readRtcTopologyDeliverySafeInteger(Number.MAX_SAFE_INTEGER, 'HEAD')).toBe(
            Number.MAX_SAFE_INTEGER
        );

        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', 1n, null]) {
            expect(() => readRtcTopologyDeliverySafeInteger(value, 'HEAD')).toThrow(
                'HEAD must be a non-negative safe integer'
            );
        }
    });

    it('materializes one exact append input from a valid publication and WS outbox', () => {
        const publication = topologyPublication();
        const outbox = computeRtcTopologyPublicationOutbox(publication);

        expect(
            toRtcTopologyDeliveryAppendInput('00000000-0000-4000-8000-000000000001', publication, outbox)
        ).toEqual({
            publisherStreamId: '00000000-0000-4000-8000-000000000001',
            groupRef: {
                applicationId: 'delivery-app',
                workspaceId: 'delivery-workspace',
                groupId: 'delivery-group'
            },
            publicationId: publication.publicationId,
            outboxKey: outbox.key,
            retainUntilEpochMs: 86_401_000
        });
    });

    it('rejects malformed stream identity and outbox identity before persistence', () => {
        const publication = topologyPublication();
        const outbox = computeRtcTopologyPublicationOutbox(publication);

        expect(() => toRtcTopologyDeliveryAppendInput('not-a-uuid', publication, outbox)).toThrow(
            'RTC topology publisher stream ID must be a UUID'
        );
        expect(() =>
            toRtcTopologyDeliveryAppendInput('00000000-0000-4000-8000-000000000001', publication, {
                ...outbox,
                key: { ...outbox.key, resourceId: 'different-resource' }
            })
        ).toThrow('RTC topology delivery outbox differs from its publication');
    });

    it('maps only named delivery-log uniqueness races into retryable conflicts', () => {
        for (
            const constraint of [
                'rtc_topology_delivery_log_pkey',
                'rtc_topology_delivery_log_publication_uq'
            ]
        ) {
            expect(
                isRtcTopologyDeliveryRetryableConflict(
                    Object.assign(new Error('unique violation'), {
                        code: '23505',
                        constraint_name: constraint
                    })
                )
            ).toBe(true);
        }
        expect(
            isRtcTopologyDeliveryRetryableConflict(
                Object.assign(new Error('unique violation'), {
                    code: '23505',
                    constraint_name: 'unrelated_unique_constraint'
                })
            )
        ).toBe(false);
        expect(
            isRtcTopologyDeliveryRetryableConflict(
                Object.assign(new Error('serialization failure'), {
                    code: '40001',
                    constraint_name: 'rtc_topology_delivery_log_pkey'
                })
            )
        ).toBe(false);
    });

    it('registers one process stream and appends each publication exactly once', async () => {
        await withDeliveryRepository(async (sql, repository) => {
            const publisherStreamId = '00000000-0000-4000-8000-000000000001';
            const registered = await repository.registerStream({
                streamId: publisherStreamId,
                leaseDurationMs: 30_000
            });
            expect(registered).toMatchObject({
                status: 'registered',
                stream: {
                    streamId: publisherStreamId,
                    headSequence: 0,
                    retainedFromSequence: 1
                }
            });
            expect(
                await repository.registerStream({
                    streamId: publisherStreamId,
                    leaseDurationMs: 30_000
                })
            ).toEqual({ status: 'conflict' });

            const publication = topologyPublication();
            const appendInput = toRtcTopologyDeliveryAppendInput(
                publisherStreamId,
                publication,
                computeRtcTopologyPublicationOutbox(publication)
            );
            const appended = await sql.begin(
                async (transaction) => await repository.appendOrValidate(transaction, appendInput)
            );
            const duplicate = await sql.begin(
                async (transaction) => await repository.appendOrValidate(transaction, appendInput)
            );

            expect(appended).toMatchObject({
                status: 'appended',
                entry: { publisherStreamId, sequence: 1 }
            });
            expect(duplicate).toMatchObject({
                status: 'existing',
                entry: { publisherStreamId, sequence: 1 }
            });
            expect(await readStreamHead(sql, publisherStreamId)).toBe(1);
        });
    });

    it('rolls back the HEAD advance and log insert with the surrounding transaction', async () => {
        await withDeliveryRepository(async (sql, repository) => {
            const publisherStreamId = '00000000-0000-4000-8000-000000000001';
            await repository.registerStream({
                streamId: publisherStreamId,
                leaseDurationMs: 30_000
            });
            const publication = topologyPublication();

            await expect(
                sql.begin(async (transaction) => {
                    await repository.appendOrValidate(
                        transaction,
                        toRtcTopologyDeliveryAppendInput(
                            publisherStreamId,
                            publication,
                            computeRtcTopologyPublicationOutbox(publication)
                        )
                    );
                    throw new Error('abort surrounding topology transaction');
                })
            ).rejects.toThrow('abort surrounding topology transaction');

            expect(await readStreamHead(sql, publisherStreamId)).toBe(0);
            expect(await readLogSequences(sql, publisherStreamId)).toEqual([]);
        });
    });

    it('allocates sequence one independently for two publisher streams', async () => {
        await withDeliveryRepository(async (sql, repository) => {
            const publisherA = '00000000-0000-4000-8000-000000000001';
            const publisherB = '00000000-0000-4000-8000-000000000002';
            for (const streamId of [publisherA, publisherB]) {
                await repository.registerStream({ streamId, leaseDurationMs: 30_000 });
            }

            for (
                const [streamId, workId] of [
                    [publisherA, 'publisher-a-work'],
                    [publisherB, 'publisher-b-work']
                ] as const
            ) {
                const publication = topologyPublication({ workId });
                await sql.begin(
                    async (transaction) =>
                        await repository.appendOrValidate(
                            transaction,
                            toRtcTopologyDeliveryAppendInput(
                                streamId,
                                publication,
                                computeRtcTopologyPublicationOutbox(publication)
                            )
                        )
                );
            }

            expect(await readStreamHead(sql, publisherA)).toBe(1);
            expect(await readStreamHead(sql, publisherB)).toBe(1);
            expect(await readLogSequences(sql, publisherA)).toEqual([1]);
            expect(await readLogSequences(sql, publisherB)).toEqual([1]);
        });
    });

    it('returns the canonical A winner without advancing the losing B stream', async () => {
        await withDeliveryRepository(async (sql, repository) => {
            const publisherA = '00000000-0000-4000-8000-000000000001';
            const publisherB = '00000000-0000-4000-8000-000000000002';
            for (const streamId of [publisherA, publisherB]) {
                await repository.registerStream({ streamId, leaseDurationMs: 30_000 });
            }
            const publication = topologyPublication();
            const outbox = computeRtcTopologyPublicationOutbox(publication);
            const winner = await sql.begin(
                async (transaction) =>
                    await repository.appendOrValidate(
                        transaction,
                        toRtcTopologyDeliveryAppendInput(publisherA, publication, outbox)
                    )
            );
            const loser = await sql.begin(
                async (transaction) =>
                    await repository.appendOrValidate(
                        transaction,
                        toRtcTopologyDeliveryAppendInput(publisherB, publication, outbox)
                    )
            );

            expect(winner).toMatchObject({
                status: 'appended',
                entry: { publisherStreamId: publisherA, sequence: 1 }
            });
            expect(loser).toMatchObject({
                status: 'existing',
                entry: { publisherStreamId: publisherA, sequence: 1 }
            });
            expect(await readStreamHead(sql, publisherB)).toBe(0);
            expect(await readLogSequences(sql, publisherB)).toEqual([]);
        });
    });

    it('fails closed when an existing canonical publication has different durable identity', async () => {
        await withDeliveryRepository(async (sql, repository) => {
            const publisherStreamId = '00000000-0000-4000-8000-000000000001';
            await repository.registerStream({
                streamId: publisherStreamId,
                leaseDurationMs: 30_000
            });
            const publication = topologyPublication();
            const input = toRtcTopologyDeliveryAppendInput(
                publisherStreamId,
                publication,
                computeRtcTopologyPublicationOutbox(publication)
            );
            await sql.begin(async (transaction) => await repository.appendOrValidate(transaction, input));

            await expect(
                sql.begin(
                    async (transaction) =>
                        await repository.appendOrValidate(transaction, {
                            ...input,
                            outboxKey: { ...input.outboxKey, resourceId: 'conflicting-resource' }
                        })
                )
            ).rejects.toBeInstanceOf(RtcTopologyDeliveryCorruptionError);
        });
    });

    it('refuses to append after database-time lease loss', async () => {
        await withDeliveryRepository(async (sql, repository) => {
            const publisherStreamId = '00000000-0000-4000-8000-000000000001';
            await repository.registerStream({
                streamId: publisherStreamId,
                leaseDurationMs: 30_000
            });
            await sql`
        update rtc_topology_delivery_stream
        set lease_expires_at = clock_timestamp() - interval '1 second'
        where stream_id = ${publisherStreamId}
      `;
            const publication = topologyPublication();

            await expect(
                sql.begin(
                    async (transaction) =>
                        await repository.appendOrValidate(
                            transaction,
                            toRtcTopologyDeliveryAppendInput(
                                publisherStreamId,
                                publication,
                                computeRtcTopologyPublicationOutbox(publication)
                            )
                        )
                )
            ).resolves.toEqual({ status: 'lease-lost' });
            expect(await readStreamHead(sql, publisherStreamId)).toBe(0);
            expect(await readLogSequences(sql, publisherStreamId)).toEqual([]);
        });
    });

    it('renews an active lease from database time and never reacquires an expired lease', async () => {
        await withDeliveryRepository(async (sql, repository) => {
            const publisherStreamId = '00000000-0000-4000-8000-000000000001';
            const registered = await repository.registerStream({
                streamId: publisherStreamId,
                leaseDurationMs: 30_000
            });
            if (registered.status !== 'registered') {
                throw new Error('Expected a newly registered delivery stream');
            }

            const renewed = await repository.renewStreamLease({
                streamId: publisherStreamId,
                leaseDurationMs: 30_000
            });
            expect(renewed).toMatchObject({
                status: 'renewed',
                stream: { streamId: publisherStreamId }
            });
            if (renewed.status !== 'renewed') {
                throw new Error('Expected the active delivery lease to renew');
            }
            expect(renewed.stream.leaseExpiresAtEpochMs).toBeGreaterThanOrEqual(
                registered.stream.leaseExpiresAtEpochMs
            );

            await sql`
        update rtc_topology_delivery_stream
        set lease_expires_at = clock_timestamp() - interval '1 second'
        where stream_id = ${publisherStreamId}
      `;
            await expect(
                repository.renewStreamLease({
                    streamId: publisherStreamId,
                    leaseDurationMs: 30_000
                })
            ).resolves.toEqual({ status: 'lease-lost' });
        });
    });

    it('compacts only the contiguous expired prefix and advances the retained floor', async () => {
        await withDeliveryRepository(async (sql, repository) => {
            const publisherStreamId = '00000000-0000-4000-8000-000000000001';
            await repository.registerStream({
                streamId: publisherStreamId,
                leaseDurationMs: 30_000
            });
            const expiredPublication = topologyPublication({
                workId: 'expired-work',
                expiresAtMs: 2_000
            });
            const livePublication = topologyPublication({
                workId: 'live-work',
                expiresAtMs: 253_402_300_799_000
            });
            for (const publication of [expiredPublication, livePublication]) {
                await sql.begin(
                    async (transaction) =>
                        await repository.appendOrValidate(
                            transaction,
                            toRtcTopologyDeliveryAppendInput(
                                publisherStreamId,
                                publication,
                                computeRtcTopologyPublicationOutbox(publication)
                            )
                        )
                );
            }

            expect(await repository.compactExpiredEntries({ pageSize: 1_000 })).toEqual({
                scannedStreamCount: 1,
                deletedEntryCount: 1
            });
            expect(await readStreamHead(sql, publisherStreamId)).toBe(2);
            expect(await readRetainedFloor(sql, publisherStreamId)).toBe(2);
            expect(await readLogSequences(sql, publisherStreamId)).toEqual([2]);
        });
    });

    it('fails compaction closed on an unexplained physical hole', async () => {
        await withDeliveryRepository(async (sql, repository) => {
            const publisherStreamId = '00000000-0000-4000-8000-000000000001';
            await repository.registerStream({
                streamId: publisherStreamId,
                leaseDurationMs: 30_000
            });
            for (const workId of ['first-work', 'second-work']) {
                const publication = topologyPublication({ workId, expiresAtMs: 2_000 });
                await sql.begin(
                    async (transaction) =>
                        await repository.appendOrValidate(
                            transaction,
                            toRtcTopologyDeliveryAppendInput(
                                publisherStreamId,
                                publication,
                                computeRtcTopologyPublicationOutbox(publication)
                            )
                        )
                );
            }
            await sql`
        delete from rtc_topology_delivery_log
        where publisher_stream_id = ${publisherStreamId}
          and sequence = 1
      `;

            await expect(repository.compactExpiredEntries({ pageSize: 1_000 })).rejects.toBeInstanceOf(
                RtcTopologyDeliveryCorruptionError
            );
            expect(await readRetainedFloor(sql, publisherStreamId)).toBe(1);
            expect(await readStreamHead(sql, publisherStreamId)).toBe(2);
        });
    });
});

async function withDeliveryRepository(
    run: (sql: PGliteSql, repository: PSqlRtcTopologyDeliveryRepository) => Promise<void>
): Promise<void> {
    const raw = new PGlite();
    const sql = createPGliteSqlClient(raw);
    try {
        const schema = readFileSync(
            new URL('../../../apps/api-v1/src/db/in-memory-schema.sql', import.meta.url),
            'utf8'
        );
        await sql.exec(schema);
        await run(sql, new PSqlRtcTopologyDeliveryRepository(sql));
    }
    finally {
        await sql.close();
    }
}

async function readStreamHead(sql: PGliteSql, streamId: string): Promise<number> {
    const rows = await sql<{ head_sequence: number; }[]>`
    select head_sequence::double precision as head_sequence
    from rtc_topology_delivery_stream
    where stream_id = ${streamId}
  `;
    return rows[0]!.head_sequence;
}

async function readRetainedFloor(sql: PGliteSql, streamId: string): Promise<number> {
    const rows = await sql<{ retained_from_sequence: number; }[]>`
    select retained_from_sequence::double precision as retained_from_sequence
    from rtc_topology_delivery_stream
    where stream_id = ${streamId}
  `;
    return rows[0]!.retained_from_sequence;
}

async function readLogSequences(sql: PGliteSql, streamId: string): Promise<number[]> {
    const rows = await sql<{ sequence: number; }[]>`
    select sequence::double precision as sequence
    from rtc_topology_delivery_log
    where publisher_stream_id = ${streamId}
    order by sequence
  `;
    return rows.map((row) => row.sequence);
}

function topologyPublication(
    options: Readonly<{
        workId?: string;
        expiresAtMs?: number;
    }> = {}
): RtcTopologyPublication {
    const groupRef = {
        applicationId: 'delivery-app',
        workspaceId: 'delivery-workspace',
        groupId: 'delivery-group'
    };
    const causalRevision = { groupRevision: 4, presenceRevision: 6 };
    const createdAtEpochMs = 1_000;
    const expiresAtMs = options.expiresAtMs ?? 86_401_000;
    const workId = options.workId ?? 'delivery-work';
    const snapshot: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision: causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: 'Delivery group',
        topology: 'tree',
        activeSessionIds: ['session-1'],
        nextHopsBySessionId: { 'session-1': [] },
        degreeLimit: 2,
        version: 8,
        createdByClientId: 'principal-1',
        createdAtEpochMs,
        updatedAtEpochMs: createdAtEpochMs
    };
    const message = {
        id: {
            v: 2 as const,
            msgId: toRtcTopologyPublicationMessageId(workId),
            ts: createdAtEpochMs,
            senderId: 'rallar-server'
        },
        route: {
            topicId: AppTopics.overlayTopology,
            resourceId: `${snapshot.overlayId}:4:6:8`,
            contextId: groupRef.groupId
        },
        constraints: { expiresAtMs },
        targets: {
            mode: 'broadcast' as const,
            scope: 'room' as const,
            groupRef,
            minSnapshotVersion: 10
        },
        delivery: {
            reliability: 'best-effort' as const,
            ack: 'none' as const
        },
        payload: {
            typeId: AppTopics.overlayTopology,
            contentType: 'application/json' as const,
            resource: JSON.stringify(snapshot)
        },
        audit: { createdBy: 'rallar-server', createdTs: createdAtEpochMs }
    };

    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: causalRevision,
            overlayVersion: snapshot.version
        }),
        workId,
        groupRef,
        sourceGroupStateCausalRevision: causalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 10,
        recipientSessionIds: snapshot.activeSessionIds,
        message,
        createdAtEpochMs
    };
}
