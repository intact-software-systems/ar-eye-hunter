import { describe, expect, it, vi } from 'vitest';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
    RTC_RTT_LATEST_NAMESPACE,
    RTC_RTT_RECEIPTS_NAMESPACE,
    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
    migrateLegacyRtcRttMeasurementKeys,
    RtcRttRepository,
} from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    migrateLegacyRtcTopologySnapshotKeys,
    RtcTopologySnapshotRevisionConflictError,
    RtcTopologySnapshotRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import {
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    migrateLegacyRtcTopologyPublicationKeys,
    RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
    RtcTopologyExecutionRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import {
    executeRttMutation,
} from '@shared-server/rallar-system/services/rtc-topology-mutations.ts';
import {
    drainRtcRttRecomputeOutbox,
    type RtcTopologyWorkPublisher,
} from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import type { ALMessage } from '@shared/mod.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('RTC topology runtime-state repositories', () => {
    it('stores topology snapshots without invoking application locks', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        vi.spyOn(runtimeRepository, 'lockKey').mockRejectedValue(
            new Error('targeted topology locks are forbidden'),
        );
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const groupRef = createGroupRef();
        const snapshot = createTopologySnapshot(groupRef, 3);

        await expect(repository.observeSnapshot(snapshot)).resolves.toBe('inserted');

        expect(await repository.findSnapshot(groupRef)).toEqual(snapshot);
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('lets exactly one snapshot planner claim an absent predecessor without locks', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        vi.spyOn(runtimeRepository, 'lockKey').mockResolvedValue();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const groupRef = createGroupRef();
        const first = createTopologySnapshot(groupRef, 1);
        const second = { ...first, name: 'Concurrent candidate' };
        let waiting = 0;
        let release!: () => void;
        const together = new Promise<void>((resolve) => {
            release = resolve;
        });
        runtimeRepository.beforeUpsert = async (namespace) => {
            if (namespace !== RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE) return;
            waiting += 1;
            if (waiting === 2) release();
            await together;
        };

        const results = await Promise.all([
            repository.commitSnapshot({ expected: undefined, candidate: first }),
            repository.commitSnapshot({ expected: undefined, candidate: second }),
        ]);

        expect(results.filter((result) => result.status === 'accepted')).toHaveLength(1);
        expect(results.filter((result) => result.status !== 'accepted')).toHaveLength(1);
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('observes topology snapshots monotonically by source revision before version', async () => {
        const repository = new RtcTopologySnapshotRepository(
            new FakeRuntimeStateRepository(),
        );
        const groupRef = createGroupRef();
        const revision2 = {
            ...createTopologySnapshot(groupRef, 1),
            sourceGroupStateRevision: 2,
        };
        const revision1WithHigherOverlayVersion = {
            ...createTopologySnapshot(groupRef, 9),
            sourceGroupStateRevision: 1,
        };

        expect(await repository.observeSnapshot(revision2)).toBe('inserted');
        expect(await repository.observeSnapshot(revision1WithHigherOverlayVersion))
            .toBe('stale');
        expect(await repository.findSnapshot(groupRef)).toEqual(revision2);
        expect(await repository.observeSnapshot(revision2)).toBe('duplicate');
        await expect(repository.observeSnapshot({
            ...revision2,
            name: 'conflicting payload',
        })).rejects.toBeInstanceOf(RtcTopologySnapshotRevisionConflictError);
    });

    it('accepts a topology candidate only for the exact durable predecessor', async () => {
        const repository = new RtcTopologySnapshotRepository(
            new FakeRuntimeStateRepository(),
        );
        const groupRef = createGroupRef();
        const revision1 = createTopologySnapshot(groupRef, 1);
        const revision2 = {
            ...createTopologySnapshot(groupRef, 2),
            sourceGroupStateRevision: 2,
        };

        await expect(repository.commitSnapshot({
            expected: undefined,
            candidate: revision1,
        })).resolves.toEqual({
            status: 'accepted',
            observation: 'inserted',
            snapshot: revision1,
        });
        await expect(repository.commitSnapshot({
            expected: undefined,
            candidate: revision2,
        })).resolves.toEqual({
            status: 'retry',
            current: revision1,
        });
        await expect(repository.commitSnapshot({
            expected: revision1,
            candidate: revision2,
        })).resolves.toEqual({
            status: 'accepted',
            observation: 'advanced',
            snapshot: revision2,
        });
    });

    it('persists immutable topology publications and reuses the first retry result', async () => {
        const repository = new RtcTopologyPublicationRepository(
            new FakeRuntimeStateRepository(),
        );
        const snapshot = createTopologySnapshot(createGroupRef(), 2);
        const publication = {
            publicationId: 'work-1:2:2',
            workId: 'work-1',
            groupRef: snapshot.groupRef,
            sourceGroupStateRevision: snapshot.sourceGroupStateRevision,
            overlayVersion: 2,
            recipientSessionIds: snapshot.activeSessionIds,
            message: {
                id: 'message-1',
                payload: { resource: JSON.stringify(snapshot) },
            } as unknown as ALMessage,
            createdAtEpochMs: Date.now(),
        };

        expect(await repository.putOrLoad(publication)).toEqual({
            publication,
            inserted: true,
        });
        const retrySnapshot = {
            ...snapshot,
            activeSessionIds: ['session-b'],
            nextHopsBySessionId: { 'session-b': [] },
        };
        expect(await repository.putOrLoad({
            ...publication,
            recipientSessionIds: ['session-b'],
            message: {
                id: 'message-2',
                payload: { resource: JSON.stringify(retrySnapshot) },
            } as unknown as ALMessage,
        })).toEqual({
            publication,
            inserted: false,
        });
    });

    it('claims immutable publications without invoking an application lock', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        vi.spyOn(runtimeRepository, 'lockKey').mockRejectedValue(
            new Error('targeted publication locks are forbidden'),
        );
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const publication = createPublication(
            createTopologySnapshot(createGroupRef(), 1),
            'work-no-lock',
        );

        await expect(repository.putOrLoad(publication)).resolves.toEqual({
            publication,
            inserted: true,
        });
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('lets exactly one immutable publication claim a work id without locks', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        vi.spyOn(runtimeRepository, 'lockKey').mockResolvedValue();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const first = createPublication(createTopologySnapshot(createGroupRef(), 1), 'work-race');
        const secondSnapshot = {
            ...JSON.parse(first.message.payload.resource),
            activeSessionIds: ['session-b'],
            nextHopsBySessionId: { 'session-b': [] },
        };
        const second = {
            ...first,
            recipientSessionIds: ['session-b'],
            message: {
                ...first.message,
                payload: {
                    ...first.message.payload,
                    resource: JSON.stringify(secondSnapshot),
                },
            },
        };
        let waiting = 0;
        let release!: () => void;
        const together = new Promise<void>((resolve) => {
            release = resolve;
        });
        runtimeRepository.beforeUpsert = async (namespace) => {
            if (namespace !== RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE) return;
            waiting += 1;
            if (waiting === 2) release();
            await together;
        };

        const results = await Promise.all([
            repository.putOrLoad(first),
            repository.putOrLoad(second),
        ]);

        expect(results.filter((result) => result.inserted)).toHaveLength(1);
        expect(results[0]!.publication).toEqual(results[1]!.publication);
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('atomically accepts topology and publication only for the expected predecessor', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyExecutionRepository(runtimeRepository);
        const groupRef = createGroupRef();
        const snapshot = createTopologySnapshot(groupRef, 3);
        const publication = createPublication(snapshot, 'work-1');

        await expect(repository.commit({
            expected: undefined,
            candidate: snapshot,
            publication,
        })).resolves.toEqual({
            status: 'committed',
            snapshot,
            publication,
        });
        await expect(repository.commit({
            expected: undefined,
            candidate: { ...snapshot, name: 'different retry' },
            publication: { ...publication, recipientSessionIds: ['session-b'] },
        })).resolves.toEqual({
            status: 'loaded',
            snapshot,
            publication,
        });

        expect(
            await new RtcTopologySnapshotRepository(runtimeRepository)
                .findSnapshot(groupRef),
        ).toEqual(snapshot);
        expect(
            await new RtcTopologyPublicationRepository(runtimeRepository)
                .findPublicationForWork('work-1'),
        ).toEqual(publication);
    });

    it('atomically executes topology without invoking an application lock', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        vi.spyOn(runtimeRepository, 'lockKey').mockRejectedValue(
            new Error('targeted execution locks are forbidden'),
        );
        const repository = new RtcTopologyExecutionRepository(runtimeRepository);
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const publication = createPublication(snapshot, 'work-execution-no-lock');

        await expect(repository.commit({
            expected: undefined,
            candidate: snapshot,
            publication,
        })).resolves.toMatchObject({ status: 'committed', snapshot, publication });
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('requests recomputation when the topology predecessor moves before commit', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        const current = createTopologySnapshot(createGroupRef(), 4);
        await snapshots.putSnapshot(current);
        const repository = new RtcTopologyExecutionRepository(runtimeRepository);
        const candidate = createTopologySnapshot(createGroupRef(), 3);

        await expect(repository.commit({
            expected: undefined,
            candidate,
            publication: createPublication(candidate, 'work-stale'),
        })).resolves.toEqual({
            status: 'retry',
            current,
        });
        expect(
            await new RtcTopologyPublicationRepository(runtimeRepository)
                .findPublicationForWork('work-stale'),
        ).toBeUndefined();
    });

    it('rolls back topology when publication persistence fails before commit', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyExecutionRepository(runtimeRepository);
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        runtimeRepository.beforeConditionalWrite = (operation, namespace) => {
            if (
                operation === 'insertIfAbsent' &&
                namespace === RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE
            ) {
                throw new Error('publication write failed');
            }
        };

        await expect(repository.commit({
            expected: undefined,
            candidate: snapshot,
            publication: createPublication(snapshot, 'work-failed'),
        })).rejects.toThrow('publication write failed');

        expect(
            await new RtcTopologySnapshotRepository(runtimeRepository)
                .findSnapshot(snapshot.groupRef),
        ).toBeUndefined();
        expect(
            await new RtcTopologyPublicationRepository(runtimeRepository)
                .findPublicationForWork('work-failed'),
        ).toBeUndefined();
    });

    it('validates publication and work direct, list, and page rows before expiry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologyPublicationRepository(runtimeRepository);
            const groupRef = createGroupRef();
            const publication = createPublication(createTopologySnapshot(groupRef, 1), 'work-corrupt');
            const publicationKey = repository.publicationKey(groupRef, publication.publicationId);
            const workKey = repository.workIndexKey(groupRef, publication.workId);
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                publicationKey,
                JSON.stringify({ ...publication, publicationId: 'wrong-publication' }),
                9_000,
            );
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                workKey,
                JSON.stringify({
                    groupRef,
                    workId: 'wrong-work',
                    publicationId: publication.publicationId,
                }),
                9_000,
            );

            await expect(repository.findPublication(groupRef, publication.publicationId))
                .rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
            await expect(repository.listPublicationEntries())
                .rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
            await expect(repository.listPublicationEntriesPage({ limit: 10 }))
                .rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
            await expect(repository.findWorkClaimEntry(groupRef, publication.workId))
                .rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
            await expect(repository.listWorkClaimEntries())
                .rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
            await expect(repository.listWorkClaimEntriesPage({ limit: 10 }))
                .rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
            expect(await runtimeRepository.findEntry(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                publicationKey,
            )).toBeDefined();
            expect(await runtimeRepository.findEntry(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                workKey,
            )).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('offline-migrates value-verified legacy publication and work keys together', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const publication = createPublication(
            createTopologySnapshot(createGroupRef(), 1),
            'legacy-work',
        );
        const expiry = Date.now() + 60_000;
        await repository.putOrLoad(publication);
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            publication.publicationId,
            JSON.stringify(publication),
            expiry,
        );
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            publication.workId,
            JSON.stringify(publication.publicationId),
            expiry,
        );

        await migrateLegacyRtcTopologyPublicationKeys(repository, {
            oldWritersStopped: true,
        });
        await migrateLegacyRtcTopologyPublicationKeys(repository, {
            oldWritersStopped: true,
        });

        expect(await repository.findPublicationForWork(
            publication.groupRef,
            publication.workId,
        )).toEqual(publication);
        expect(await runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            publication.publicationId,
        )).toBeUndefined();
        expect(await runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            publication.workId,
        )).toBeUndefined();
    });

    it('uses injective topology keys and rejects wrong-slot snapshots before lazy expiry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologySnapshotRepository(runtimeRepository);
            const absent = createGroupRef();
            delete (absent as { workspaceId?: string }).workspaceId;
            const sentinel = { ...absent, workspaceId: '_' };
            const delimiter = { ...absent, workspaceId: 'a:b%5F＿' };

            expect(new Set([
                repository.snapshotKey(absent),
                repository.snapshotKey(sentinel),
                repository.snapshotKey(delimiter),
            ]).size).toBe(3);

            const requested = createGroupRef();
            const wrong = createTopologySnapshot(
                { ...requested, groupId: 'wrong-room' },
                1,
            );
            const key = repository.snapshotKey(requested);
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                key,
                JSON.stringify(wrong),
                9_000,
            );

            await expect(repository.findSnapshot(requested)).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            expect(await runtimeRepository.findEntry(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                key,
            )).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('validates snapshot direct, list, and page rows against physical identity', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository) as
            RtcTopologySnapshotRepository & {
                listSnapshotEntries(): Promise<readonly unknown[]>;
                listSnapshotEntriesPage(input: {
                    afterKey?: string;
                    limit: number;
                }): Promise<readonly unknown[]>;
            };
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            repository.snapshotKey(snapshot.groupRef),
            JSON.stringify(snapshot),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(repository.listSnapshotEntries()).resolves.toHaveLength(1);
        await expect(repository.listSnapshotEntriesPage({ limit: 1 })).resolves
            .toHaveLength(1);
    });

    it('exposes value-verified offline topology key migration only with old writers stopped', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const explicitSentinel = {
            ...createGroupRef(),
            workspaceId: '_',
        };
        const snapshot = createTopologySnapshot(explicitSentinel, 1);
        const legacyAliasedKey = 'app=app-1:ws=_:group=room-1';
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            legacyAliasedKey,
            JSON.stringify(snapshot),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await migrateLegacyRtcTopologySnapshotKeys(repository, {
            oldWritersStopped: true,
        });

        expect(repository.snapshotKey(explicitSentinel)).not.toBe(legacyAliasedKey);
        expect(await repository.findSnapshot(explicitSentinel)).toEqual(snapshot);
        expect(await runtimeRepository.findEntry(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            legacyAliasedKey,
        )).toBeUndefined();
    });

    it('keeps latest RTT measurements by sorted pair and expires stale entries', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let now = 1_000;

        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, {
                ttlMs: 50,
                now: () => now,
            });
            const first = {
                sessionIdFrom: 'session-b',
                sessionIdTo: 'session-a',
                rttMs: 25,
                createdAtEpochMs: 1_000,
                version: 2,
            };
            const stale = {
                ...first,
                rttMs: 10,
                version: 1,
            };
            const second = {
                ...first,
                rttMs: 5,
                version: 3,
            };

            expect(await repository.putMeasurementIfNewer(first)).toBe(true);
            expect(await repository.putMeasurementIfNewer(stale)).toBe(false);
            expect(await repository.putMeasurementIfNewer(second)).toBe(true);

            expect(await repository.findMeasurement('session-a', 'session-b'))
                .toEqual(second);
            expect(await repository.listMeasurementsForSessionIds([
                'session-a',
                'session-b',
            ])).toEqual([second]);
            expect(await repository.listMeasurementsForSessionIds([
                'session-a',
                'session-c',
            ])).toEqual([]);
            expect(runtimeRepository.locks).toEqual([]);

            now = 1_051;
            vi.setSystemTime(now);
            expect(await repository.findMeasurement('session-a', 'session-b'))
                .toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('offline-migrates value-verified legacy RTT pair keys', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const measurement = {
            sessionIdFrom: 'session-b',
            sessionIdTo: 'session-a',
            rttMs: 4,
            createdAtEpochMs: 1,
            version: 1,
        };
        const legacyKey = `pair=${encodeURIComponent('session-a::session-b')}`;
        await repository.commitMeasurement(measurement, null, 60_001);
        await runtimeRepository.upsert(
            RTC_RTT_LATEST_NAMESPACE,
            legacyKey,
            JSON.stringify(measurement),
            60_001,
        );

        await migrateLegacyRtcRttMeasurementKeys(repository, {
            oldWritersStopped: true,
        });
        await migrateLegacyRtcRttMeasurementKeys(repository, {
            oldWritersStopped: true,
        });

        expect(await repository.findMeasurement('session-a', 'session-b'))
            .toEqual(measurement);
        expect(await runtimeRepository.findEntry(RTC_RTT_LATEST_NAMESPACE, legacyKey))
            .toBeUndefined();
    });

    it('accepts a newer RTT without invoking an application lock', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        vi.spyOn(runtimeRepository, 'lockKey').mockRejectedValue(
            new Error('targeted RTT locks are forbidden'),
        );
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });

        await expect(repository.putMeasurementIfNewer({
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 1,
            createdAtEpochMs: 1,
            version: 1,
        })).resolves.toBe(true);
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('optimistically admits only one of two endpoint-cap races', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        vi.spyOn(runtimeRepository, 'lockKey').mockResolvedValue();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        let waiting = 0;
        let release!: () => void;
        const together = new Promise<void>((resolve) => {
            release = resolve;
        });
        const originalList = repository.listMeasurementEntries.bind(repository);
        vi.spyOn(repository, 'listMeasurementEntries').mockImplementation(async () => {
            const values = await originalList();
            waiting += 1;
            if (waiting === 2) release();
            await together;
            return values;
        });
        const groupAB = createRttGroupSnapshot('room-ab', ['session-a', 'session-b']);
        const groupAC = createRttGroupSnapshot('room-ac', ['session-a', 'session-c']);

        const results = await Promise.all([
            executeRttMutation({
                repository,
                runtime: runtimeRepository,
                command: {
                    rtt: {
                        sessionIdFrom: 'session-a',
                        sessionIdTo: 'session-b',
                        rttMs: 1,
                        createdAtEpochMs: 1,
                        version: 1,
                    },
                    alSenderId: 'session-a',
                    candidateGroups: [groupAB],
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 1,
                },
                facts: { purgeAfterEpochMs: 60_001, requestedAtEpochMs: 1 },
                sleep: async () => {},
            }),
            executeRttMutation({
                repository,
                runtime: runtimeRepository,
                command: {
                    rtt: {
                        sessionIdFrom: 'session-a',
                        sessionIdTo: 'session-c',
                        rttMs: 2,
                        createdAtEpochMs: 1,
                        version: 1,
                    },
                    alSenderId: 'session-a',
                    candidateGroups: [groupAC],
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 1,
                },
                facts: { purgeAfterEpochMs: 60_001, requestedAtEpochMs: 1 },
                sleep: async () => {},
            }),
        ]);

        expect(results.filter((result) => result.updated))
            .toHaveLength(1);
        expect(await repository.listMeasurements()).toHaveLength(1);
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('atomically stores RTT measurement, receipt, and recompute intent', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const group = createRttGroupSnapshot('room-ab', ['session-a', 'session-b']);
        const result = await executeRttMutation({
            repository,
            runtime: runtimeRepository,
            command: {
                rtt: {
                    sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
                    rttMs: 1, createdAtEpochMs: 1, version: 1,
                },
                alSenderId: 'session-a',
                candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1,
            },
            facts: { requestedAtEpochMs: 1, purgeAfterEpochMs: 60_001 },
            sleep: async () => {},
        });
        if (result.computed.outcome !== 'write') throw new Error('Expected RTT write');

        expect(await repository.findMutationReceipt(result.computed.receipt.receiptId))
            .toEqual(result.computed.receipt);
        expect(await repository.listRecomputeIntents())
            .toEqual(result.computed.recomputeIntents);
    });

    it('rolls back RTT capacity, measurement, and receipt when intent persistence fails', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        runtimeRepository.beforeConditionalWrite = (_operation, namespace) => {
            if (namespace === RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE) {
                throw new Error('recompute intent write failed');
            }
        };
        const group = createRttGroupSnapshot('room-ab', ['session-a', 'session-b']);

        await expect(executeRttMutation({
            repository,
            runtime: runtimeRepository,
            command: {
                rtt: {
                    sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
                    rttMs: 1, createdAtEpochMs: 1, version: 1,
                },
                alSenderId: 'session-a', candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1,
            },
            facts: { requestedAtEpochMs: 1, purgeAfterEpochMs: 60_001 },
            sleep: async () => {},
        })).rejects.toThrow('recompute intent write failed');

        expect(await runtimeRepository.findAllEntries(RTC_RTT_LATEST_NAMESPACE))
            .toEqual([]);
        expect(await runtimeRepository.findAllEntries(RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE))
            .toEqual([]);
        expect(await runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE))
            .toEqual([]);
        expect(await runtimeRepository.findAllEntries(RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE))
            .toEqual([]);
    });

    it('drains a committed RTT recompute intent after a worker restart', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const group = createRttGroupSnapshot('room-ab', ['session-a', 'session-b']);
        await executeRttMutation({
            repository,
            runtime: runtimeRepository,
            command: {
                rtt: { sessionIdFrom: 'session-a', sessionIdTo: 'session-b', rttMs: 1, createdAtEpochMs: 1, version: 1 },
                alSenderId: 'session-a', candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1,
            },
            facts: { requestedAtEpochMs: 1, purgeAfterEpochMs: 60_001 },
            sleep: async () => {},
        });
        const restarted = new RtcRttRepository(runtimeRepository, { now: () => 2 });
        const enqueueForRtt = vi.fn(async () => {});

        await drainRtcRttRecomputeOutbox({
            repository: restarted,
            publisher: createRttWorkPublisher(enqueueForRtt),
            debounceMs: 5,
        });

        expect(enqueueForRtt).toHaveBeenCalledWith(group, expect.objectContaining({ version: 1 }), 5);
        expect(await restarted.listRecomputeIntents()).toEqual([]);
    });

    it('lets concurrent RTT outbox drainers converge after idempotent enqueue', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const group = createRttGroupSnapshot('room-ab', ['session-a', 'session-b']);
        await executeRttMutation({
            repository, runtime: runtimeRepository,
            command: {
                rtt: { sessionIdFrom: 'session-a', sessionIdTo: 'session-b', rttMs: 1, createdAtEpochMs: 1, version: 1 },
                alSenderId: 'session-a', candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1,
            },
            facts: { requestedAtEpochMs: 1, purgeAfterEpochMs: 60_001 },
            sleep: async () => {},
        });
        let waiting = 0;
        let release!: () => void;
        const together = new Promise<void>((resolve) => release = resolve);
        const enqueueForRtt = vi.fn(async () => {
            waiting += 1;
            if (waiting === 2) release();
            await together;
        });
        const publisher = createRttWorkPublisher(enqueueForRtt);

        const delivered = await Promise.all([
            drainRtcRttRecomputeOutbox({ repository, publisher, debounceMs: 0 }),
            drainRtcRttRecomputeOutbox({ repository, publisher, debounceMs: 0 }),
        ]);

        expect(delivered.reduce((sum, count) => sum + count, 0)).toBe(1);
        expect(enqueueForRtt).toHaveBeenCalledTimes(2);
        expect(await repository.listRecomputeIntents()).toEqual([]);
    });

    it('rejects wrong-pair RTT rows before expiry across direct, list, and page reads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository) as
                RtcRttRepository & {
                    listMeasurementEntriesPage(input: {
                        afterKey?: string;
                        limit: number;
                    }): Promise<readonly unknown[]>;
                };
            const requestedKey = repository.measurementKey('session-a', 'session-b');
            await runtimeRepository.upsert(
                RTC_RTT_LATEST_NAMESPACE,
                requestedKey,
                JSON.stringify({
                    sessionIdFrom: 'session-a',
                    sessionIdTo: 'session-c',
                    rttMs: 1,
                    createdAtEpochMs: 1,
                    version: 1,
                }),
                9_000,
            );

            await expect(repository.findMeasurement('session-a', 'session-b'))
                .rejects.toMatchObject({
                    code: 'rtc-topology-repository-invariant-corruption',
                });
            await expect(repository.listMeasurements()).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            await expect(repository.listMeasurementEntriesPage({ limit: 10 }))
                .rejects.toMatchObject({
                    code: 'rtc-topology-repository-invariant-corruption',
                });
            expect(await runtimeRepository.findEntry(
                RTC_RTT_LATEST_NAMESPACE,
                requestedKey,
            )).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses injective RTT keys and validates endpoint admission direct, list, and page rows', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, { now: () => 10_000 });
            expect(repository.measurementKey('a', 'b:c'))
                .not.toBe(repository.measurementKey('a:b', 'c'));
            expect(repository.measurementKey('a%', '＿'))
                .not.toBe(repository.measurementKey('a', '%＿'));
            const key = repository.endpointAdmissionKey('session-a');
            await runtimeRepository.upsert(
                RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                key,
                JSON.stringify({
                    endpointId: 'session-b',
                    peers: [{ peerSessionId: 'session-c', expiresAtEpochMs: 11_000 }],
                    version: 1,
                    updatedAtEpochMs: 9_000,
                }),
                11_000,
            );

            await expect(repository.findEndpointAdmissionEntry('session-a'))
                .rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
            await expect(repository.listEndpointAdmissionEntries())
                .rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
            await expect(repository.listEndpointAdmissionEntriesPage({ limit: 10 }))
                .rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
            expect(await runtimeRepository.findEntry(
                RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                key,
            )).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds expiry replacement conflicts with the shared retry schedule', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const sleep = vi.fn(async () => {});
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 100,
            sleep,
        });
        const measurement = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 1, createdAtEpochMs: 1, version: 1,
        };
        const key = repository.measurementKey('session-a', 'session-b');
        await runtimeRepository.upsert(
            RTC_RTT_LATEST_NAMESPACE,
            key,
            JSON.stringify(measurement),
            90,
        );
        runtimeRepository.beforeConditionalWrite = async (operation, namespace) => {
            if (operation === 'deleteIfRevision' && namespace === RTC_RTT_LATEST_NAMESPACE) {
                await runtimeRepository.upsert(
                    RTC_RTT_LATEST_NAMESPACE,
                    key,
                    JSON.stringify(measurement),
                    90,
                );
            }
        };

        await expect(repository.findMeasurement('session-a', 'session-b'))
            .rejects.toMatchObject({
                name: 'RuntimeStateRetryExhaustedError',
                code: 'runtime-state-write-conflict',
                attempts: 3,
            });
        expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([2, 8]);
    });
});

function createGroupRef(): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
    };
}

function createRttGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        },
        members: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member' as const,
            status: 'active' as const,
            joined: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_001,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

function createRttWorkPublisher(
    enqueueForRtt: RtcTopologyWorkPublisher['enqueueForRtt'],
): RtcTopologyWorkPublisher {
    return {
        enqueueForRtt,
        enqueueForRttGroups: async (rtt, groups, debounceMs) => {
            for (const group of groups) await enqueueForRtt(group, rtt, debounceMs);
        },
        enqueueForGroupSnapshot: async () => {},
        enqueueForStateMutation: async (group) => ({
            effectiveSnapshotRevision: group.stateRevision,
        }),
    };
}

function createTopologySnapshot(
    groupRef: GroupRef,
    version: number,
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateRevision: version,
        state: 'active',
        overlayId: JSON.stringify([
            groupRef.applicationId,
            groupRef.workspaceId ?? '',
            groupRef.groupId,
        ]),
        groupRef,
        name: 'Room 1',
        topology: 'tree',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        },
        degreeLimit: 5,
        version,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
    };
}

function createPublication(
    snapshot: RallarOverlayTopologySnapshot,
    workId: string,
) {
    return {
        publicationId: `${workId}:${snapshot.sourceGroupStateRevision}:${snapshot.version}`,
        workId,
        groupRef: snapshot.groupRef,
        sourceGroupStateRevision: snapshot.sourceGroupStateRevision,
        overlayVersion: snapshot.version,
        recipientSessionIds: snapshot.activeSessionIds,
        message: {
            id: `message-${workId}`,
            payload: { resource: JSON.stringify(snapshot) },
        } as unknown as ALMessage,
        createdAtEpochMs: 10,
    };
}
