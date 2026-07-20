import { describe, expect, it, vi } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    DEFAULT_RTC_RTT_MUTATION_RETENTION_MS,
    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
    RTC_RTT_LATEST_NAMESPACE,
    RTC_RTT_RECEIPTS_NAMESPACE,
    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
    initRtcRttReceiptFamilyCleanup,
    migrateLegacyRtcRttMeasurementKeys,
    migrateLegacyRtcRttRecomputeIntentDeliveryState,
    RtcRttReceiptFamilyCleanupError,
    RtcRttRepository,
    toRtcRttMutationReceiptId,
    toRtcRttRecomputeOutboxId,
} from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    migrateLegacyRtcTopologySnapshotKeys,
    decideTopologySnapshot,
    RtcTopologySnapshotRevisionConflictError,
    RtcTopologySnapshotRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import {
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    migrateLegacyRtcTopologyPublicationKeys,
    type RtcTopologyPublication,
    RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
    RtcTopologyExecutionRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import {
    computeRttMutation,
    computeTopologyMutation,
    type RtcRttMutationCommand,
    type RtcRttMutationComputed,
} from '@shared-server/rallar-system/services/rtc-topology-mutations.ts';
import {
    executeRttMutation as executeRttMutationService,
    writeRttMutation,
} from '@shared-server/rallar-system/services/rtc-rtt-mutation-service.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { hashStateMutationCommand } from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import {
    drainRtcRttRecomputeOutbox,
    type RtcTopologyWorkPublisher,
} from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import type { ALMessage } from '@shared/mod.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

type TestExecuteRttMutationInput = Omit<
    Parameters<typeof executeRttMutationService>[0],
    'request' | 'readCommand'
> & Readonly<{
    command: RtcRttMutationCommand;
    readCommand?: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
}>;

function executeRttMutation(input: TestExecuteRttMutationInput) {
    const { command, readCommand, ...rest } = input;
    return executeRttMutationService({
        ...rest,
        request: { rtt: command.rtt, alSenderId: command.alSenderId },
        readCommand: readCommand ?? (() => command),
    });
}

describe('RTC topology runtime-state repositories', () => {
    it('does not expose an unconditional topology snapshot overwrite helper', () => {
        const repository = new RtcTopologySnapshotRepository(
            new FakeRuntimeStateRepository(),
        );

        expect('putSnapshot' in repository).toBe(false);
    });

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

    it('treats reordered topology object keys as one semantic tuple across decision and CAS', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const reordered = reorderJsonObjectKeys(snapshot);

        expect(decideTopologySnapshot(snapshot, reordered)).toBe('duplicate');
        await expect(repository.commitSnapshot({
            expected: undefined,
            candidate: snapshot,
        })).resolves.toMatchObject({ status: 'accepted', observation: 'inserted' });
        const writes = vi.spyOn(runtimeRepository, 'upsertIfRevision');
        await expect(repository.commitSnapshot({
            expected: reordered,
            candidate: reordered,
        })).resolves.toMatchObject({ status: 'accepted', observation: 'duplicate' });
        expect(writes).not.toHaveBeenCalled();
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

    it('persists immutable topology publications and rejects a divergent loaded retry', async () => {
        const repository = new RtcTopologyPublicationRepository(
            new FakeRuntimeStateRepository(),
        );
        const snapshot = createTopologySnapshot(createGroupRef(), 2);
        const publication = createPublication(snapshot, 'work-1');

        expect(await repository.putOrLoad(publication)).toEqual({
            publication,
            inserted: true,
        });
        const retrySnapshot = {
            ...snapshot,
            activeSessionIds: ['session-b'],
            nextHopsBySessionId: { 'session-b': [] },
        };
        await expect(repository.putOrLoad({
            ...publication,
            recipientSessionIds: ['session-b'],
            message: {
                ...publication.message,
                payload: {
                    ...publication.message.payload,
                    resource: JSON.stringify(retrySnapshot),
                },
            },
        })).rejects.toMatchObject({ code: 'rtc-topology-publication-collision' });
    });

    it('loads a semantically equal publication retry with reordered object keys', async () => {
        const repository = new RtcTopologyPublicationRepository(
            new FakeRuntimeStateRepository(),
        );
        const publication = createPublication(
            createTopologySnapshot(createGroupRef(), 2),
            'work-reordered-load',
        );

        await expect(repository.putOrLoad(publication)).resolves.toMatchObject({
            inserted: true,
        });
        await expect(repository.putOrLoad(reorderJsonObjectKeys(publication)))
            .resolves.toEqual({ publication, inserted: false });
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

    it('accepts documented optional AL envelope sections on durable publications', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const base = createPublication(
            createTopologySnapshot(createGroupRef(), 1),
            'work-optional-envelope',
        );
        const publication = {
            ...base,
            message: {
                ...base.message,
                id: { ...base.message.id, sessionId: 'session-a', traceId: 'trace-1' },
                targets: {
                    ...base.message.targets,
                    exceptPeerIds: ['session-z'],
                },
                forwarding: {
                    nextHopPeerIds: ['session-b'],
                    overlayId: 'overlay-1',
                    fanoutLimit: 2,
                },
                constraints: { ttlHops: 4, expiresAtMs: 1_000 },
                ordering: { orderingKey: 'room-1', epoch: 1, seq: 2 },
                delivery: {
                    ...base.message.delivery,
                    ownership: 'shared' as const,
                },
                actions: { corrId: 'corr-1', replyToMsgId: 'reply-1' },
                qos: {
                    dedup: {
                        algo: 'semantic-key' as const,
                        opts: { windowMs: 1_000, semanticKey: 'topology:room-1' },
                    },
                    expiry: {
                        algo: 'expires-at' as const,
                        opts: { expiresAtMs: 1_000 },
                    },
                },
                diagnostics: { visitedPeerIds: ['session-a'] },
            },
        };

        await expect(repository.putOrLoad(publication)).resolves.toMatchObject({
            inserted: true,
            publication,
        });
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

        const results = await Promise.allSettled([
            repository.putOrLoad(first),
            repository.putOrLoad(second),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected'))
            .toMatchObject({ reason: { code: 'rtc-topology-publication-collision' } });
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('accepts a reordered expected predecessor in the topology execution compatibility path', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        const execution = new RtcTopologyExecutionRepository(runtimeRepository);
        const first = createTopologySnapshot(createGroupRef(), 1);
        await snapshots.observeSnapshot(first);
        const second = {
            ...first,
            sourceGroupStateRevision: 2,
            version: 2,
            updatedAtEpochMs: 3,
        };
        const publication = createPublication(second, 'work-reordered-expected');

        await expect(execution.commit({
            expected: reorderJsonObjectKeys(first),
            candidate: second,
            publication,
        })).resolves.toMatchObject({ status: 'committed', snapshot: second });
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

    it('materializes publication expiry before entering the topology transaction', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const originalBegin = runtimeRepository.begin.bind(runtimeRepository);
        let insideTransaction = false;
        vi.spyOn(runtimeRepository, 'begin').mockImplementation(async (fn) =>
            await originalBegin(async (transaction) => {
                insideTransaction = true;
                try {
                    return await fn(transaction);
                } finally {
                    insideTransaction = false;
                }
            })
        );
        const repository = new RtcTopologyExecutionRepository(
            runtimeRepository,
            100,
            () => {
                if (insideTransaction) {
                    throw new Error('publication clock accessed in transaction');
                }
                return 10;
            },
        );
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const publication = createPublication(snapshot, 'work-expiry-clock');

        await expect(repository.commit({
            expected: undefined,
            candidate: snapshot,
            publication,
        })).resolves.toMatchObject({ status: 'committed' });
    });

    it('rejects a malformed publication expiry before opening a transaction', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const begin = vi.spyOn(runtimeRepository, 'begin');
        const repository = new RtcTopologyExecutionRepository(runtimeRepository);
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const publication = createPublication(snapshot, 'work-invalid-expiry');
        const computed = computeTopologyMutation({
            read: { snapshot: null, publicationClaim: null },
            candidate: snapshot,
            publication,
            facts: { publicationExpireAtTimestamp: 100 },
        });
        if (computed.outcome !== 'write') throw new Error('Expected write');

        await expect(repository.writeTopologyMutation({
            ...computed,
            publicationExpireAtTimestamp: null,
        } as unknown as Parameters<typeof repository.writeTopologyMutation>[0]))
            .rejects.toThrow('publication expiry');
        expect(begin).not.toHaveBeenCalled();
    });

    it('requests recomputation when the topology predecessor moves before commit', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        const current = createTopologySnapshot(createGroupRef(), 4);
        await expect(snapshots.commitSnapshotGuard(current, null))
            .resolves.toMatchObject({ status: 'accepted' });
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

    it('rejects incomplete persisted topology envelopes before cleanup on every read surface', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const defects = ['id', 'route', 'typeId'] as const;
            const surfaces = ['direct', 'list', 'page'] as const;
            for (const defect of defects) {
                for (const surface of surfaces) {
                    const runtimeRepository = new FakeRuntimeStateRepository();
                    const repository = new RtcTopologyPublicationRepository(
                        runtimeRepository,
                    );
                    const groupRef = createGroupRef();
                    const publication = structuredClone(createPublication(
                        createTopologySnapshot(groupRef, 1),
                        `work-envelope-${defect}-${surface}`,
                    ));
                    const message = publication.message as unknown as Record<string, unknown>;
                    if (defect === 'typeId') {
                        delete (message.payload as Record<string, unknown>).typeId;
                    } else {
                        delete message[defect];
                    }
                    const key = repository.publicationKey(
                        groupRef,
                        publication.publicationId,
                    );
                    await runtimeRepository.upsert(
                        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                        key,
                        JSON.stringify(publication),
                        9_000,
                    );

                    const read = surface === 'direct'
                        ? repository.findPublication(groupRef, publication.publicationId)
                        : surface === 'list'
                        ? repository.listPublicationEntries()
                        : repository.listPublicationEntriesPage({ limit: 10 });
                    await expect(read).rejects.toMatchObject({
                        code: 'rtc-topology-repository-invariant-corruption',
                    });
                    expect(await runtimeRepository.findEntry(
                        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                        key,
                    )).toBeDefined();
                }
            }
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
        const legacyPublication = toLegacyPublication(publication);
        const upgradedPublication = toUpgradedLegacyPublication(legacyPublication);
        const expiry = Date.now() + 60_000;
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            publication.publicationId,
            JSON.stringify(legacyPublication),
            expiry,
        );
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            publication.workId,
            JSON.stringify(publication.publicationId),
            expiry,
        );

        await expect(repository.findPublication(publication.publicationId))
            .rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });

        await migrateLegacyRtcTopologyPublicationKeys(repository, {
            oldWritersStopped: true,
        });
        await migrateLegacyRtcTopologyPublicationKeys(repository, {
            oldWritersStopped: true,
        });

        expect(await repository.findPublicationForWork(
            publication.groupRef,
            publication.workId,
        )).toEqual(upgradedPublication);
        expect(await runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            publication.publicationId,
        )).toBeUndefined();
        expect(await runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            publication.workId,
        )).toBeUndefined();
    });

    it('lets concurrent publication migrators converge on one exact canonical winner', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        runtimeRepository.serializeTransactions = true;
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const publication = createPublication(
            createTopologySnapshot(createGroupRef(), 1),
            'legacy-concurrent-migration',
        );
        const legacyPublication = toLegacyPublication(publication);
        const upgraded = toUpgradedLegacyPublication(legacyPublication);
        const expiry = Date.now() + 60_000;
        await seedLegacyPublicationRows(runtimeRepository, legacyPublication, expiry);
        const sleeps: number[] = [];

        await expect(Promise.all([
            migrateLegacyRtcTopologyPublicationKeys(repository, {
                oldWritersStopped: true,
                sleep: async (delayMs: number) => sleeps.push(delayMs),
            } as Parameters<typeof migrateLegacyRtcTopologyPublicationKeys>[1]),
            migrateLegacyRtcTopologyPublicationKeys(repository, {
                oldWritersStopped: true,
                sleep: async (delayMs: number) => sleeps.push(delayMs),
            } as Parameters<typeof migrateLegacyRtcTopologyPublicationKeys>[1]),
        ])).resolves.toEqual([undefined, undefined]);

        expect(sleeps).toEqual([]);
        await expect(repository.findPublicationForWork(
            upgraded.groupRef,
            upgraded.workId,
        )).resolves.toEqual(upgraded);
        await expect(runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            legacyPublication.publicationId,
        )).resolves.toBeUndefined();
        await expect(runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            legacyPublication.workId,
        )).resolves.toBeUndefined();
    });

    it('rejects a concurrent publication migration winner with divergent physical expiry', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const publication = createPublication(
            createTopologySnapshot(createGroupRef(), 1),
            'legacy-concurrent-expiry-mismatch',
        );
        const legacyPublication = toLegacyPublication(publication);
        const upgraded = toUpgradedLegacyPublication(legacyPublication);
        const expiry = Date.now() + 60_000;
        await seedLegacyPublicationRows(runtimeRepository, legacyPublication, expiry);
        const sourcePublication = (await runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            legacyPublication.publicationId,
        ))!;
        const sourceClaim = (await runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            legacyPublication.workId,
        ))!;
        const originalBegin = runtimeRepository.begin.bind(runtimeRepository);
        vi.spyOn(runtimeRepository, 'begin').mockImplementationOnce(async (fn) => {
            await runtimeRepository.deleteIfRevision(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                sourcePublication.key,
                sourcePublication.revision,
            );
            await runtimeRepository.deleteIfRevision(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                sourceClaim.key,
                sourceClaim.revision,
            );
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                repository.publicationKey(upgraded.groupRef, upgraded.publicationId),
                JSON.stringify(upgraded),
                expiry + 1,
            );
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                repository.workIndexKey(upgraded.groupRef, upgraded.workId),
                JSON.stringify({
                    groupRef: upgraded.groupRef,
                    workId: upgraded.workId,
                    publicationId: upgraded.publicationId,
                }),
                expiry,
            );
            return await originalBegin(fn);
        });

        await expect(migrateLegacyRtcTopologyPublicationKeys(repository, {
            oldWritersStopped: true,
            sleep: async () => {},
        })).rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption',
        });
    });

    it('exhausts publication migration after bounded full-attempt conflicts and backoff', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const publication = createPublication(
            createTopologySnapshot(createGroupRef(), 1),
            'legacy-migration-exhaustion',
        );
        const legacyPublication = toLegacyPublication(publication);
        const upgraded = toUpgradedLegacyPublication(legacyPublication);
        const expiry = Date.now() + 60_000;
        await seedLegacyPublicationRows(runtimeRepository, legacyPublication, expiry);
        const destinationClaimKey = repository.workIndexKey(
            upgraded.groupRef,
            upgraded.workId,
        );
        const expectedClaim = {
            groupRef: upgraded.groupRef,
            workId: upgraded.workId,
            publicationId: upgraded.publicationId,
        };
        let conflicts = 0;
        runtimeRepository.beforeConditionalWrite = async (
            operation,
            namespace,
            key,
        ) => {
            if (
                operation === 'insertIfAbsent' &&
                namespace === RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE &&
                key === destinationClaimKey
            ) {
                conflicts += 1;
                await runtimeRepository.upsert(
                    namespace,
                    key,
                    JSON.stringify(expectedClaim),
                    expiry,
                );
            }
        };
        const sleeps: number[] = [];

        await expect(migrateLegacyRtcTopologyPublicationKeys(repository, {
            oldWritersStopped: true,
            sleep: async (delayMs: number) => sleeps.push(delayMs),
        } as Parameters<typeof migrateLegacyRtcTopologyPublicationKeys>[1]))
            .rejects.toMatchObject({
                code: 'runtime-state-write-conflict',
                attempts: 3,
            });

        expect(conflicts).toBe(3);
        expect(sleeps).toEqual([2, 8]);
        await expect(runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            legacyPublication.publicationId,
        )).resolves.toBeDefined();
        await expect(runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            destinationClaimKey,
        )).resolves.toBeUndefined();
    });

    it.each(['canonical-claim', 'legacy-claim'] as const)(
        'offline-upgrades a canonical legacy publication with a %s',
        async (claimLayout) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologyPublicationRepository(runtimeRepository);
            const publication = createPublication(
                createTopologySnapshot(createGroupRef(), 1),
                `canonical-legacy-${claimLayout}`,
            );
            const legacyPublication = toLegacyPublication(publication);
            const upgraded = toUpgradedLegacyPublication(legacyPublication);
            const expiry = Date.now() + 60_000;
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                repository.publicationKey(
                    legacyPublication.groupRef,
                    legacyPublication.publicationId,
                ),
                JSON.stringify(reorderJsonObjectKeys(legacyPublication)),
                expiry,
            );
            if (claimLayout === 'canonical-claim') {
                await runtimeRepository.upsert(
                    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    repository.workIndexKey(
                        legacyPublication.groupRef,
                        legacyPublication.workId,
                    ),
                    JSON.stringify(reorderJsonObjectKeys({
                        groupRef: legacyPublication.groupRef,
                        workId: legacyPublication.workId,
                        publicationId: legacyPublication.publicationId,
                    })),
                    expiry,
                );
            } else {
                await runtimeRepository.upsert(
                    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    legacyPublication.workId,
                    JSON.stringify(legacyPublication.publicationId),
                    expiry,
                );
            }

            await expect(repository.findPublication(
                legacyPublication.groupRef,
                legacyPublication.publicationId,
            )).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });

            await migrateLegacyRtcTopologyPublicationKeys(repository, {
                oldWritersStopped: true,
            });
            await migrateLegacyRtcTopologyPublicationKeys(repository, {
                oldWritersStopped: true,
            });

            await expect(repository.findPublicationForWork(
                upgraded.groupRef,
                upgraded.workId,
            )).resolves.toEqual(upgraded);
            await expect(runtimeRepository.findEntry(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                legacyPublication.workId,
            )).resolves.toBeUndefined();
        },
    );

    it.each(['claim', 'publication'] as const)(
        'recovers a %s-only canonical publication migration destination',
        async (partialDestination) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologyPublicationRepository(runtimeRepository);
            const publication = createPublication(
                createTopologySnapshot(createGroupRef(), 1),
                `legacy-partial-${partialDestination}`,
            );
            const legacyPublication = toLegacyPublication(publication);
            const upgraded = toUpgradedLegacyPublication(legacyPublication);
            const expiry = Date.now() + 60_000;
            await seedLegacyPublicationRows(
                runtimeRepository,
                legacyPublication,
                expiry,
            );
            if (partialDestination === 'claim') {
                await runtimeRepository.insertIfAbsent(
                    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    repository.workIndexKey(upgraded.groupRef, upgraded.workId),
                    JSON.stringify(reorderJsonObjectKeys({
                        groupRef: upgraded.groupRef,
                        workId: upgraded.workId,
                        publicationId: upgraded.publicationId,
                    })),
                    expiry,
                );
            } else {
                await runtimeRepository.insertIfAbsent(
                    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    repository.publicationKey(upgraded.groupRef, upgraded.publicationId),
                    JSON.stringify(reorderJsonObjectKeys(upgraded)),
                    expiry,
                );
            }

            await migrateLegacyRtcTopologyPublicationKeys(repository, {
                oldWritersStopped: true,
            });
            await migrateLegacyRtcTopologyPublicationKeys(repository, {
                oldWritersStopped: true,
            });

            await expect(repository.findPublicationForWork(
                upgraded.groupRef,
                upgraded.workId,
            )).resolves.toEqual(upgraded);
        },
    );

    it.each(['claim', 'publication'] as const)(
        'preserves immutable canonical migration rows when the %s expiry diverges',
        async (divergentRow) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologyPublicationRepository(runtimeRepository);
            const publication = createPublication(
                createTopologySnapshot(createGroupRef(), 1),
                `legacy-immutable-expiry-${divergentRow}`,
            );
            const legacyPublication = toLegacyPublication(publication);
            const upgraded = toUpgradedLegacyPublication(legacyPublication);
            const expiry = Date.now() + 60_000;
            await seedLegacyPublicationRows(runtimeRepository, legacyPublication, expiry);
            const claimKey = repository.workIndexKey(
                upgraded.groupRef,
                upgraded.workId,
            );
            const publicationKey = repository.publicationKey(
                upgraded.groupRef,
                upgraded.publicationId,
            );
            await runtimeRepository.insertIfAbsent(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                claimKey,
                JSON.stringify({
                    groupRef: upgraded.groupRef,
                    workId: upgraded.workId,
                    publicationId: upgraded.publicationId,
                }),
                divergentRow === 'claim' ? expiry + 1 : expiry,
            );
            await runtimeRepository.insertIfAbsent(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                publicationKey,
                JSON.stringify(upgraded),
                divergentRow === 'publication' ? expiry + 1 : expiry,
            );
            const claimBefore = await runtimeRepository.findEntry(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                claimKey,
            );
            const publicationBefore = await runtimeRepository.findEntry(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                publicationKey,
            );

            await expect(migrateLegacyRtcTopologyPublicationKeys(repository, {
                oldWritersStopped: true,
                sleep: async () => {},
            })).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });

            await expect(runtimeRepository.findEntry(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                claimKey,
            )).resolves.toEqual(claimBefore);
            await expect(runtimeRepository.findEntry(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                publicationKey,
            )).resolves.toEqual(publicationBefore);
            await expect(runtimeRepository.findEntry(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                legacyPublication.publicationId,
            )).resolves.toBeDefined();
            await expect(runtimeRepository.findEntry(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                legacyPublication.workId,
            )).resolves.toBeDefined();
        },
    );

    it('rejects a divergent canonical publication destination during legacy upgrade', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const publication = createPublication(
            createTopologySnapshot(createGroupRef(), 1),
            'legacy-divergent',
        );
        const legacyPublication = toLegacyPublication(publication);
        const upgraded = toUpgradedLegacyPublication(legacyPublication);
        const divergentSnapshot = {
            ...JSON.parse(upgraded.message.payload.resource),
            name: 'divergent destination',
        };
        const divergent = {
            ...upgraded,
            message: {
                ...upgraded.message,
                payload: {
                    ...upgraded.message.payload,
                    resource: JSON.stringify(divergentSnapshot),
                },
            },
        };
        const expiry = Date.now() + 60_000;
        await seedLegacyPublicationRows(runtimeRepository, legacyPublication, expiry);
        await runtimeRepository.insertIfAbsent(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            repository.workIndexKey(upgraded.groupRef, upgraded.workId),
            JSON.stringify({
                groupRef: upgraded.groupRef,
                workId: upgraded.workId,
                publicationId: upgraded.publicationId,
            }),
            expiry,
        );
        await runtimeRepository.insertIfAbsent(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            repository.publicationKey(upgraded.groupRef, upgraded.publicationId),
            JSON.stringify(divergent),
            expiry,
        );

        const sleep = vi.fn(async () => {});
        await expect(migrateLegacyRtcTopologyPublicationKeys(repository, {
            oldWritersStopped: true,
            sleep,
        } as Parameters<typeof migrateLegacyRtcTopologyPublicationKeys>[1]))
            .rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption',
        });
        expect(sleep).not.toHaveBeenCalled();
        expect(await runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            legacyPublication.publicationId,
        )).toBeDefined();
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

    it('accepts the canonical removed-topology tombstone shape', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const active = createTopologySnapshot(createGroupRef(), 1);
        const removed = {
            ...active,
            state: 'removed' as const,
            nextHopsBySessionId: {
                'session-a': [],
                'session-b': [],
            },
        };

        await expect(repository.observeSnapshot(removed)).resolves.toBe('inserted');
        await expect(repository.findSnapshot(removed.groupRef)).resolves.toEqual(removed);
    });

    it.each(topologyInvariantCases().flatMap(({ defect, snapshot }) =>
        (['direct', 'list', 'page', 'publication'] as const).map((surface) => ({
            defect,
            snapshot,
            surface,
        }))
    ))('rejects $defect topology corruption on the $surface surface before effects', async ({
        defect,
        snapshot,
        surface,
    }) => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            if (surface === 'publication') {
                const repository = new RtcTopologyPublicationRepository(runtimeRepository);
                const publication = createPublication(snapshot, `work-${defect}`);
                const key = repository.publicationKey(
                    publication.groupRef,
                    publication.publicationId,
                );
                await runtimeRepository.upsert(
                    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    key,
                    JSON.stringify(publication),
                    9_000,
                );

                await expect(repository.findPublication(
                    publication.groupRef,
                    publication.publicationId,
                )).rejects.toMatchObject({
                    code: 'rtc-topology-repository-invariant-corruption',
                });
                expect(await runtimeRepository.findEntry(
                    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    key,
                )).toBeDefined();
                return;
            }

            const repository = new RtcTopologySnapshotRepository(runtimeRepository);
            const key = repository.snapshotKey(snapshot.groupRef);
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                key,
                JSON.stringify(snapshot),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
            const read = surface === 'direct'
                ? repository.findSnapshot(snapshot.groupRef)
                : surface === 'list'
                ? repository.listSnapshotEntries()
                : repository.listSnapshotEntriesPage({ limit: 10 });
            await expect(read).rejects.toMatchObject({
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

    it('persists a required target snapshot version and binds it to the AL target', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const base = createPublication(snapshot, 'work-target-version');
        const publication = {
            ...base,
            targetGroupSnapshotVersion: 1,
        };

        await expect(repository.putOrLoad(publication)).resolves.toMatchObject({
            publication,
            inserted: true,
        });
        await expect(repository.putOrLoad({
            ...publication,
            publicationId: 'work-target-version-mismatch:1:1',
            workId: 'work-target-version-mismatch',
            targetGroupSnapshotVersion: 2,
        })).rejects.toThrow('snapshot version');
    });

    it('binds persisted publication message timestamps to explicit publication facts', async () => {
        const repository = new RtcTopologyPublicationRepository(
            new FakeRuntimeStateRepository(),
        );
        const publication = createPublication(
            createTopologySnapshot(createGroupRef(), 1),
            'work-explicit-time',
        );

        await expect(repository.putOrLoad({
            ...publication,
            message: {
                ...publication.message,
                id: { ...publication.message.id, ts: 11 },
                audit: { ...publication.message.audit, createdTs: 11 },
            },
        })).rejects.toThrow('timestamp');
    });

    it.each(['direct', 'list', 'page'] as const)(
        'rejects a nondeterministic publication message id on the %s surface',
        async (surface) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologyPublicationRepository(runtimeRepository);
            const publication = createPublication(
                createTopologySnapshot(createGroupRef(), 1),
                `work-message-id-${surface}`,
            );
            const tampered = {
                ...publication,
                message: {
                    ...publication.message,
                    id: { ...publication.message.id, msgId: 'random-legacy-message-id' },
                },
            };
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                repository.publicationKey(tampered.groupRef, tampered.publicationId),
                JSON.stringify(tampered),
                Date.now() + 60_000,
            );

            const read = surface === 'direct'
                ? repository.findPublication(tampered.groupRef, tampered.publicationId)
                : surface === 'list'
                ? repository.listPublicationEntries()
                : repository.listPublicationEntriesPage({ limit: 10 });
            await expect(read).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
        },
    );

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
        await runtimeRepository.insertIfAbsent(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            repository.snapshotKey(explicitSentinel),
            JSON.stringify(reorderJsonObjectKeys(snapshot)),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await migrateLegacyRtcTopologySnapshotKeys(repository, {
            oldWritersStopped: true,
            observedAtEpochMs: 10_000,
        });

        expect(repository.snapshotKey(explicitSentinel)).not.toBe(legacyAliasedKey);
        expect(await repository.findSnapshot(explicitSentinel)).toEqual(snapshot);
        expect(await runtimeRepository.findEntry(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            legacyAliasedKey,
        )).toBeUndefined();
    });

    it('normalizes an expiring legacy topology snapshot to a never-expiring canonical row', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const ref = {
            ...createGroupRef(),
            workspaceId: '_',
        };
        const snapshot = createTopologySnapshot(ref, 1);
        const legacyKey = 'app=app-1:ws=_:group=room-1';
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            legacyKey,
            JSON.stringify(snapshot),
            20_000,
        );

        await migrateLegacyRtcTopologySnapshotKeys(repository, {
            oldWritersStopped: true,
            observedAtEpochMs: 10_000,
        });

        const canonical = await runtimeRepository.findEntry(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            repository.snapshotKey(ref),
        );
        expect(canonical?.expireAtTimestamp).toBe(NEVER_EXPIRE_AT_TIMESTAMP);
        await expect(repository.findSnapshot(ref)).resolves.toEqual(snapshot);
        await expect(runtimeRepository.findEntry(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            legacyKey,
        )).resolves.toBeUndefined();
    });

    it.each([
        { label: 'at the observation boundary', expireAtTimestamp: 10_000 },
        { label: 'before the observation boundary', expireAtTimestamp: 9_999 },
    ])('never resurrects a legacy topology snapshot expiring $label', async ({
        expireAtTimestamp,
    }) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const ref = { ...createGroupRef(), workspaceId: '_' };
        const snapshot = createTopologySnapshot(ref, 1);
        const legacyKey = 'app=app-1:ws=_:group=room-1';
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            legacyKey,
            JSON.stringify(snapshot),
            expireAtTimestamp,
        );

        await expect(migrateLegacyRtcTopologySnapshotKeys(repository, {
            oldWritersStopped: true,
            observedAtEpochMs: 10_000,
        })).rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption',
        });

        await expect(runtimeRepository.findEntry(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            repository.snapshotKey(ref),
        )).resolves.toBeUndefined();
        await expect(runtimeRepository.findEntry(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            legacyKey,
        )).resolves.toMatchObject({ expireAtTimestamp });
    });

    it('revalidates a changed legacy snapshot lifetime against one stable migration observation', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const ref = { ...createGroupRef(), workspaceId: '_' };
        const snapshot = createTopologySnapshot(ref, 1);
        const legacyKey = 'app=app-1:ws=_:group=room-1';
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            legacyKey,
            JSON.stringify(snapshot),
            20_000,
        );
        const originalBegin = runtimeRepository.begin.bind(runtimeRepository);
        let attempts = 0;
        vi.spyOn(runtimeRepository, 'begin').mockImplementation(async (fn) => {
            attempts += 1;
            if (attempts === 1) throw new RuntimeStateWriteConflictError();
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                legacyKey,
                JSON.stringify(snapshot),
                10_000,
            );
            return await originalBegin(fn);
        });

        await expect(migrateLegacyRtcTopologySnapshotKeys(repository, {
            oldWritersStopped: true,
            observedAtEpochMs: 10_000,
            sleep: async () => {},
        })).rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption',
        });

        expect(attempts).toBe(2);
        await expect(runtimeRepository.findEntry(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            repository.snapshotKey(ref),
        )).resolves.toBeUndefined();
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

    it('fails closed when the compatibility RTT helper sees equal-version divergence', async () => {
        const repository = new RtcRttRepository(
            new FakeRuntimeStateRepository(),
            { now: () => 1 },
        );
        const measurement = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 1,
            createdAtEpochMs: 1,
            version: 1,
        };

        await expect(repository.putMeasurementIfNewer(measurement))
            .resolves.toBe(true);
        await expect(repository.putMeasurementIfNewer({ ...measurement }))
            .resolves.toBe(false);
        await expect(repository.putMeasurementIfNewer({
            ...measurement,
            rttMs: 2,
        })).rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption',
        });
    });

    it('surfaces a compatibility RTT CAS race as a typed conflict', async () => {
        const repository = new RtcRttRepository(
            new FakeRuntimeStateRepository(),
            { now: () => 1 },
        );
        const commit = vi.spyOn(repository, 'commitMeasurement')
            .mockResolvedValue({ status: 'conflict' });

        await expect(repository.putMeasurementIfNewer({
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 1,
            createdAtEpochMs: 1,
            version: 1,
        })).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it('uses stable code-unit ordering for Unicode RTT pairs and endpoint peers', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const composed = '\u00e9';
        const decomposed = 'e\u0301';
        const measurement = {
            sessionIdFrom: composed,
            sessionIdTo: decomposed,
            rttMs: 1,
            createdAtEpochMs: 1,
            version: 1,
        };

        expect(repository.measurementKey(composed, decomposed))
            .toBe(repository.measurementKey(decomposed, composed));
        await expect(repository.commitMeasurement(measurement, null, 100))
            .resolves.toMatchObject({ status: 'accepted' });
        await expect(repository.findMeasurement(decomposed, composed))
            .resolves.toEqual(measurement);
        await expect(repository.listMeasurements()).resolves.toEqual([measurement]);
        await expect(repository.listMeasurementEntriesPage({ limit: 10 }))
            .resolves.toMatchObject([{ value: measurement }]);

        const admission = {
            endpointId: 'endpoint',
            peers: [
                { peerSessionId: decomposed, expiresAtEpochMs: 100 },
                { peerSessionId: composed, expiresAtEpochMs: 101 },
            ],
            version: 1,
            updatedAtEpochMs: 1,
        };
        await expect(repository.commitEndpointAdmission(admission, null, 101))
            .resolves.toMatchObject({ status: 'accepted' });
        await expect(repository.findEndpointAdmissionEntry('endpoint'))
            .resolves.toMatchObject({ value: admission });
        await expect(repository.listEndpointAdmissionEntries())
            .resolves.toMatchObject([{ value: admission }]);
        await expect(repository.listEndpointAdmissionEntriesPage({ limit: 10 }))
            .resolves.toMatchObject([{ value: admission }]);
    });

    it.each([
        { operation: 'insert', expectedRevision: null, version: 2 },
        { operation: 'update', expectedRevision: 0, version: 1 },
    ] as const)(
        'rejects a direct endpoint admission $operation whose domain version differs from its storage guard',
        async ({ expectedRevision, version }) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => 1,
            });
            const admission = {
                endpointId: 'session-a',
                peers: [{
                    peerSessionId: 'session-b',
                    expiresAtEpochMs: 100,
                }],
                version,
                updatedAtEpochMs: 1,
            };

            await expect(repository.commitEndpointAdmission(
                admission,
                expectedRevision,
                100,
            )).rejects.toBeInstanceOf(TypeError);
            await expect(runtimeRepository.findAllEntries(
                RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
            )).resolves.toEqual([]);
        },
    );

    it.each(['direct', 'list', 'page'] as const)(
        'fails closed on endpoint domain/storage version corruption before expiry cleanup on %s reads',
        async (surface) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => 10_000,
            });
            const key = repository.endpointAdmissionKey('session-a');
            await runtimeRepository.upsert(
                RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                key,
                JSON.stringify({
                    endpointId: 'session-a',
                    peers: [{
                        peerSessionId: 'session-b',
                        expiresAtEpochMs: 9_000,
                    }],
                    version: 2,
                    updatedAtEpochMs: 1,
                }),
                9_000,
            );

            const read = surface === 'direct'
                ? repository.findEndpointAdmissionEntry('session-a')
                : surface === 'list'
                ? repository.listEndpointAdmissionEntries()
                : repository.listEndpointAdmissionEntriesPage({ limit: 10 });
            await expect(read).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            await expect(runtimeRepository.findEntry(
                RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                key,
            )).resolves.toBeDefined();
        },
    );

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
                readFacts: () => ({
                    purgeAfterEpochMs: 60_001,
                    requestedAtEpochMs: 1,
                }),
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
                readFacts: () => ({
                    purgeAfterEpochMs: 60_001,
                    requestedAtEpochMs: 1,
                }),
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
            readFacts: () => ({
                requestedAtEpochMs: 1,
                purgeAfterEpochMs: 60_001,
            }),
            sleep: async () => {},
        });
        if (result.computed.outcome !== 'write') throw new Error('Expected RTT write');
        const expectedCommandHash = await hashStateMutationCommand({
            rtt: result.computed.measurementGuard.value,
            alSenderId: 'session-a',
        });

        expect(await repository.findMutationReceipt(result.computed.receipt.receiptId))
            .toEqual(result.computed.receipt);
        expect(result.computed.receipt.commandHash).toBe(expectedCommandHash);
        expect(Object.keys(result.computed.receipt).sort()).toEqual([
            'acceptedAtEpochMs',
            'affectedGroupRefs',
            'commandHash',
            'measurementVersion',
            'outcome',
            'receiptId',
            'sessionIdFrom',
            'sessionIdTo',
        ]);
        expect(result.computed.recomputeIntents[0]).toMatchObject({
            commandHash: expectedCommandHash,
            outboxId: expect.stringContaining(encodeURIComponent(expectedCommandHash)),
            delivery: { state: 'pending' },
        });
        expect(await repository.findMutationReceiptEntry(
            result.computed.receipt.receiptId,
        )).toMatchObject({ value: result.computed.receipt });
        expect(await repository.listMutationReceiptEntries())
            .toMatchObject([{ value: result.computed.receipt }]);
        expect(await repository.listMutationReceiptEntriesPage({ limit: 10 }))
            .toMatchObject([{ value: result.computed.receipt }]);
        expect(await repository.listRecomputeIntents())
            .toEqual(result.computed.recomputeIntents);
        expect(await repository.findRecomputeIntentEntry(
            result.computed.recomputeIntents[0]!.outboxId,
        )).toMatchObject({ value: result.computed.recomputeIntents[0] });
        expect(await repository.listRecomputeIntentEntriesPage({ limit: 10 }))
            .toMatchObject([{ value: result.computed.recomputeIntents[0] }]);
    });

    it.each(rttWriteCandidateCorruptions)(
        'rejects $label before opening the RTT write transaction',
        async ({ corrupt }) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const begin = vi.spyOn(runtimeRepository, 'begin');
            const malformed = corrupt(
                structuredClone(createValidRttWriteCandidate()) as unknown as
                    MutableRttWriteCandidate,
            );

            await expect(writeRttMutation(
                runtimeRepository,
                { now: () => 2 },
                malformed as unknown as Extract<
                    RtcRttMutationComputed,
                    { outcome: 'write' }
                >,
            )).rejects.toBeInstanceOf(TypeError);
            expect(begin).not.toHaveBeenCalled();
        },
    );

    it('strictly rejects legacy delivery-less intents until explicit offline migration', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-legacy-intent-delivery',
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const entry = (await runtimeRepository.findEntry(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            seeded.intent.outboxId,
        ))!;
        const parsed = JSON.parse(entry.value) as Record<string, unknown>;
        delete parsed.delivery;
        await runtimeRepository.upsert(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            entry.key,
            JSON.stringify(parsed),
            entry.expireAtTimestamp,
        );
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });

        await expect(repository.findRecomputeIntentEntry(entry.key))
            .rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });

        await migrateLegacyRtcRttRecomputeIntentDeliveryState(repository, {
            oldWritersStopped: true,
            sleep: async () => {},
        });

        await expect(repository.findRecomputeIntentEntry(entry.key))
            .resolves.toMatchObject({
                value: { delivery: { state: 'pending' } },
            });
    });

    it.each(['group', 'session-from', 'session-to'] as const)(
        'rejects RTT authority when the candidate %s is expired at attempt time',
        async (expiredAuthority) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(runtimeRepository, { now: () => 10 });
            const baseGroup = createRttGroupSnapshot(
                `room-expired-${expiredAuthority}`,
                ['session-a', 'session-b'],
            );
            const group = expiredAuthority === 'group'
                ? {
                    ...baseGroup,
                    group: { ...baseGroup.group, expiresAtEpochMs: 10 },
                }
                : {
                    ...baseGroup,
                    activeSessions: baseGroup.activeSessions.map((session) =>
                        session.sessionId === (
                                expiredAuthority === 'session-from'
                                    ? 'session-a'
                                    : 'session-b'
                            )
                            ? { ...session, expiresAtEpochMs: 10 }
                            : session
                    ),
                };
            const command: RtcRttMutationCommand = {
                rtt: {
                    sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
                    rttMs: 1, createdAtEpochMs: 1, version: 1,
                },
                alSenderId: 'session-a',
                candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1,
            };

            await expect(executeRttMutation({
                repository,
                runtime: runtimeRepository,
                command,
                readFacts: () => ({
                    requestedAtEpochMs: 10,
                    purgeAfterEpochMs: 60_010,
                }),
                sleep: async () => {},
            })).resolves.toMatchObject({
                updated: false,
                computed: {
                    outcome: 'rejected',
                    reason: 'no-shared-active-group',
                },
            });
            await expect(runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE))
                .resolves.toEqual([]);
            await expect(runtimeRepository.findAllEntries(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            )).resolves.toEqual([]);
        },
    );

    it('reruns RTT lifecycle authority after a CAS conflict crosses group expiry', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const baseGroup = createRttGroupSnapshot(
            'room-retry-expiry',
            ['session-a', 'session-b'],
        );
        const group = {
            ...baseGroup,
            group: { ...baseGroup.group, expiresAtEpochMs: 2 },
        };
        const command: RtcRttMutationCommand = {
            rtt: {
                sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
                rttMs: 1, createdAtEpochMs: 1, version: 1,
            },
            alSenderId: 'session-a',
            candidateGroups: [group],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 1,
        };
        const readCommand = vi.fn(() => command);
        const readFacts = vi.fn()
            .mockReturnValueOnce({ requestedAtEpochMs: 1, purgeAfterEpochMs: 60_001 })
            .mockReturnValueOnce({ requestedAtEpochMs: 2, purgeAfterEpochMs: 60_002 });
        let forcedConflict = false;
        runtimeRepository.beforeConditionalWrite = async (
            operation,
            namespace,
            key,
        ) => {
            if (
                !forcedConflict && operation === 'insertIfAbsent' &&
                namespace === RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE
            ) {
                forcedConflict = true;
                const endpointId = decodeURIComponent(key.slice('endpoint='.length));
                const peerSessionId = endpointId === 'session-a'
                    ? 'session-b'
                    : 'session-a';
                await runtimeRepository.upsert(namespace, key, JSON.stringify({
                    endpointId,
                    peers: [{ peerSessionId, expiresAtEpochMs: 60_001 }],
                    version: 1,
                    updatedAtEpochMs: 1,
                }), 60_001);
            }
        };

        await expect(executeRttMutation({
            repository,
            runtime: runtimeRepository,
            command,
            readCommand,
            readFacts,
            sleep: async () => {},
        })).resolves.toMatchObject({
            updated: false,
            computed: {
                outcome: 'rejected',
                reason: 'no-shared-active-group',
            },
        });
        expect(readCommand).toHaveBeenCalledTimes(2);
        expect(readFacts).toHaveBeenCalledTimes(2);
        await expect(runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE))
            .resolves.toEqual([]);
        await expect(runtimeRepository.findAllEntries(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
        )).resolves.toEqual([]);
    });

    it.each(
        (['duplicate', 'out-of-order'] as const).flatMap((defect) =>
            (['direct', 'list', 'page'] as const).map((surface) => ({ defect, surface }))
        ),
    )('rejects $defect affected group refs on receipt $surface reads', async ({
        defect,
        surface,
    }) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const rtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 1, createdAtEpochMs: 1, version: 1,
        };
        const receiptId = toRtcRttMutationReceiptId(rtt);
        const refA = { applicationId: 'app-1', groupId: 'room-a' };
        const refB = { applicationId: 'app-1', groupId: 'room-b' };
        await runtimeRepository.upsert(
            RTC_RTT_RECEIPTS_NAMESPACE,
            receiptId,
            JSON.stringify({
                receiptId,
                sessionIdFrom: rtt.sessionIdFrom,
                sessionIdTo: rtt.sessionIdTo,
                measurementVersion: rtt.version,
                affectedGroupRefs: defect === 'duplicate'
                    ? [refA, refA]
                    : [refB, refA],
                acceptedAtEpochMs: 1,
                outcome: 'accepted',
                commandHash: `sha256:${'a'.repeat(64)}`,
            }),
            86_400_001,
        );

        const read = surface === 'direct'
            ? repository.findMutationReceiptEntry(receiptId)
            : surface === 'list'
            ? repository.listMutationReceiptEntries()
            : repository.listMutationReceiptEntriesPage({ limit: 10 });
        await expect(read).rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption',
        });
    });

    it.each(
        ([
            'missing-receipt',
            'hash',
            'time',
            'reversed-direction',
            'version',
            'group',
            'inactive-group',
            'expired-group',
            'missing-pair-member',
            'expired-pair-session',
            'future-pair-session',
        ] as const)
            .flatMap((defect) =>
                (['direct', 'list', 'page', 'drain', 'sweep'] as const).map((surface) => ({
                    defect,
                    surface,
                }))
            ),
    )('fails closed for a $defect recompute intent on $surface before enqueue', async ({
        defect,
        surface,
    }) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            `room-intent-${defect}-${surface}`,
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const receiptEntry = await runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            seeded.receipt.receiptId,
        );
        const intentEntry = await runtimeRepository.findEntry(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            seeded.intent.outboxId,
        );
        let intent = structuredClone(seeded.intent);
        let outboxId = intent.outboxId;
        if (defect === 'missing-receipt') {
            await runtimeRepository.deleteIfRevision(
                RTC_RTT_RECEIPTS_NAMESPACE,
                receiptEntry!.key,
                receiptEntry!.revision,
            );
        } else if (defect === 'hash') {
            const commandHash = `sha256:${'b'.repeat(64)}`;
            outboxId = toRtcRttRecomputeOutboxId(
                intent.receiptId,
                intent.groupSnapshot.group,
                commandHash,
            );
            intent = { ...intent, commandHash, outboxId };
        } else if (defect === 'time') {
            intent = { ...intent, createdAtEpochMs: intent.createdAtEpochMs + 1 };
        } else if (defect === 'reversed-direction') {
            intent = {
                ...intent,
                rtt: {
                    ...intent.rtt,
                    sessionIdFrom: intent.rtt.sessionIdTo,
                    sessionIdTo: intent.rtt.sessionIdFrom,
                },
            };
        } else if (defect === 'version') {
            const mismatchedReceipt = {
                ...seeded.receipt,
                measurementVersion: seeded.receipt.measurementVersion + 1,
            };
            const mismatchedReceiptId = toRtcRttMutationReceiptId({
                ...intent.rtt,
                version: mismatchedReceipt.measurementVersion,
            });
            await runtimeRepository.deleteIfRevision(
                RTC_RTT_RECEIPTS_NAMESPACE,
                receiptEntry!.key,
                receiptEntry!.revision,
            );
            await runtimeRepository.upsert(
                RTC_RTT_RECEIPTS_NAMESPACE,
                mismatchedReceiptId,
                JSON.stringify({
                    ...mismatchedReceipt,
                    receiptId: mismatchedReceiptId,
                }),
                receiptEntry!.expireAtTimestamp,
            );
            outboxId = toRtcRttRecomputeOutboxId(
                mismatchedReceiptId,
                intent.groupSnapshot.group,
                intent.commandHash,
            );
            intent = {
                ...intent,
                receiptId: mismatchedReceiptId,
                outboxId,
            };
        } else if (defect === 'group') {
            await runtimeRepository.upsert(
                RTC_RTT_RECEIPTS_NAMESPACE,
                receiptEntry!.key,
                JSON.stringify({
                    ...seeded.receipt,
                    affectedGroupRefs: [{
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'other-room',
                    }],
                }),
                receiptEntry!.expireAtTimestamp,
            );
        } else if (defect === 'inactive-group') {
            intent = {
                ...intent,
                groupSnapshot: {
                    ...intent.groupSnapshot,
                    group: {
                        ...intent.groupSnapshot.group,
                        status: 'archived',
                        archived: { atEpochMs: 2, byServiceId: 'test' },
                    },
                    activeSessions: [],
                    onlineMemberCount: 0,
                },
            };
        } else if (defect === 'expired-group') {
            intent = {
                ...intent,
                groupSnapshot: {
                    ...intent.groupSnapshot,
                    group: {
                        ...intent.groupSnapshot.group,
                        expiresAtEpochMs: intent.createdAtEpochMs,
                    },
                },
            };
        } else if (defect === 'expired-pair-session') {
            intent = {
                ...intent,
                groupSnapshot: {
                    ...intent.groupSnapshot,
                    activeSessions: intent.groupSnapshot.activeSessions.map((session) =>
                        session.sessionId === intent.rtt.sessionIdFrom
                            ? {
                                ...session,
                                connectedAtEpochMs: 0,
                                lastHeartbeatAtEpochMs: 0,
                                expiresAtEpochMs: intent.createdAtEpochMs,
                            }
                            : session
                    ),
                },
            };
        } else if (defect === 'future-pair-session') {
            intent = {
                ...intent,
                groupSnapshot: {
                    ...intent.groupSnapshot,
                    activeSessions: intent.groupSnapshot.activeSessions.map((session) =>
                        session.sessionId === intent.rtt.sessionIdFrom
                            ? {
                                ...session,
                                connectedAtEpochMs: intent.createdAtEpochMs + 1,
                                lastHeartbeatAtEpochMs: intent.createdAtEpochMs + 1,
                            }
                            : session
                    ),
                },
            };
        } else {
            intent = {
                ...intent,
                groupSnapshot: createRttGroupSnapshot(
                    intent.groupSnapshot.group.groupId,
                    ['session-a'],
                ),
            };
        }
        if (outboxId !== intentEntry!.key) {
            await runtimeRepository.deleteIfRevision(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                intentEntry!.key,
                intentEntry!.revision,
            );
        }
        await runtimeRepository.upsert(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            outboxId,
            JSON.stringify(intent),
            intentEntry!.expireAtTimestamp,
        );
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => surface === 'sweep' ? seeded.expireAtTimestamp + 1 : 1,
        });
        const enqueueForRtt = vi.fn(async () => {});
        const read = surface === 'direct'
            ? repository.findRecomputeIntentEntry(outboxId)
            : surface === 'list'
            ? repository.listRecomputeIntentEntries()
            : surface === 'page'
            ? repository.listRecomputeIntentEntriesPage({ limit: 10 })
            : surface === 'sweep'
            ? repository.cleanupExpiredReceiptFamilies()
            : drainRtcRttRecomputeOutbox({
                repository,
                publisher: createRttWorkPublisher(enqueueForRtt),
                debounceMs: 0,
            });

        await expect(read).rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption',
        });
        expect(enqueueForRtt).not.toHaveBeenCalled();
    });

    it('cleans a jointly expired receipt and recompute intent without false corruption', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-joint-expiry',
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => seeded.expireAtTimestamp + 1,
        });

        await expect(repository.listRecomputeIntentEntries()).resolves.toEqual([]);
        await expect(repository.findMutationReceipt(seeded.receipt.receiptId))
            .resolves.toBeUndefined();
    });

    it.each(
        ([-100, 100] as const).flatMap((expiryOffset) =>
            ([
                'probe',
                'receipt-direct',
                'receipt-list',
                'receipt-page',
                'intent',
                'drain',
                'sweep',
            ] as const).map((surface) => ({ expiryOffset, surface }))
        ),
    )(
        'rejects a jointly shifted noncanonical RTT retention family on $surface ($expiryOffset ms)',
        async ({ expiryOffset, surface }) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const group = createRttGroupSnapshot(
                `room-retention-${surface}`,
                ['session-a', 'session-b'],
            );
            const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
            const receiptEntry = (await runtimeRepository.findEntry(
                RTC_RTT_RECEIPTS_NAMESPACE,
                seeded.receipt.receiptId,
            ))!;
            const intentEntry = (await runtimeRepository.findEntry(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                seeded.intent.outboxId,
            ))!;
            const shiftedExpiry = seeded.expireAtTimestamp + expiryOffset;
            await runtimeRepository.upsert(
                RTC_RTT_RECEIPTS_NAMESPACE,
                receiptEntry.key,
                receiptEntry.value,
                shiftedExpiry,
            );
            await runtimeRepository.upsert(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                intentEntry.key,
                intentEntry.value,
                shiftedExpiry,
            );
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => surface === 'sweep' ? shiftedExpiry + 1 : 1,
            });
            const enqueueForRtt = vi.fn(async () => {});
            const read = surface === 'probe'
                ? repository.probeMutationReceiptEntry(seeded.receipt.receiptId)
                : surface === 'receipt-direct'
                ? repository.findMutationReceiptEntry(seeded.receipt.receiptId)
                : surface === 'receipt-list'
                ? repository.listMutationReceiptEntries()
                : surface === 'receipt-page'
                ? repository.listMutationReceiptEntriesPage({ limit: 10 })
                : surface === 'intent'
                ? repository.findRecomputeIntentEntry(seeded.intent.outboxId)
                : surface === 'sweep'
                ? repository.cleanupExpiredReceiptFamilies()
                : drainRtcRttRecomputeOutbox({
                    repository,
                    publisher: createRttWorkPublisher(enqueueForRtt),
                    debounceMs: 0,
                    now: () => 2,
                });

            await expect(read).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            expect(enqueueForRtt).not.toHaveBeenCalled();
        },
    );

    it('rejects receipt retention whose accepted time overflows the exact duration', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-retention-overflow',
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const receiptEntry = (await runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            seeded.receipt.receiptId,
        ))!;
        await runtimeRepository.upsert(
            RTC_RTT_RECEIPTS_NAMESPACE,
            receiptEntry.key,
            JSON.stringify({
                ...seeded.receipt,
                acceptedAtEpochMs: Number.MAX_SAFE_INTEGER -
                    DEFAULT_RTC_RTT_MUTATION_RETENTION_MS + 1,
            }),
            Number.MAX_SAFE_INTEGER,
        );
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });

        await expect(repository.probeMutationReceiptEntry(seeded.receipt.receiptId))
            .rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
    });

    it('rejects a mutation receipt write with a noncanonical physical expiry', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-retention-write',
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });

        await expect(repository.insertMutationReceipt(
            seeded.receipt,
            seeded.expireAtTimestamp + 1,
        )).rejects.toThrow(/expiry|expire/i);
    });

    it.each(
        ([
            'expired-intent-live-receipt',
            'live-intent-expired-receipt',
            'unequal-live-expiries',
            'jointly-expired-matching',
            'jointly-expired-value-mismatch',
        ] as const).flatMap((expiryCase) =>
            (['direct', 'list', 'page', 'drain'] as const).map((surface) => ({
                expiryCase,
                surface,
            }))
        ),
    )('enforces $expiryCase joint receipt/intent expiry on $surface', async ({
        expiryCase,
        surface,
    }) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            `room-expiry-${expiryCase}-${surface}`,
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const receiptEntry = (await runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            seeded.receipt.receiptId,
        ))!;
        const intentEntry = (await runtimeRepository.findEntry(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            seeded.intent.outboxId,
        ))!;
        let receiptExpiry = seeded.expireAtTimestamp;
        let intentExpiry = seeded.expireAtTimestamp;
        let now = seeded.expireAtTimestamp + 1;
        let receipt = seeded.receipt;
        if (expiryCase === 'expired-intent-live-receipt') {
            receiptExpiry += 100;
        } else if (expiryCase === 'live-intent-expired-receipt') {
            intentExpiry += 100;
        } else if (expiryCase === 'unequal-live-expiries') {
            receiptExpiry += 100;
            intentExpiry += 101;
            now = seeded.expireAtTimestamp - 1;
        } else if (expiryCase === 'jointly-expired-value-mismatch') {
            receipt = {
                ...receipt,
                commandHash: `sha256:${'b'.repeat(64)}`,
            };
        }
        await runtimeRepository.upsert(
            RTC_RTT_RECEIPTS_NAMESPACE,
            receiptEntry.key,
            JSON.stringify(receipt),
            receiptExpiry,
        );
        await runtimeRepository.upsert(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            intentEntry.key,
            JSON.stringify(seeded.intent),
            intentExpiry,
        );
        const repository = new RtcRttRepository(runtimeRepository, { now: () => now });
        const enqueueForRtt = vi.fn(async () => {});
        const read = surface === 'direct'
            ? repository.findRecomputeIntentEntry(seeded.intent.outboxId)
            : surface === 'list'
            ? repository.listRecomputeIntentEntries()
            : surface === 'page'
            ? repository.listRecomputeIntentEntriesPage({ limit: 10 })
            : drainRtcRttRecomputeOutbox({
                repository,
                publisher: createRttWorkPublisher(enqueueForRtt),
                debounceMs: 0,
            });
        const isMatchingJointExpiry = expiryCase === 'jointly-expired-matching';
        if (isMatchingJointExpiry) {
            if (surface === 'direct') {
                await expect(read).resolves.toBeUndefined();
            } else {
                await expect(read).resolves.toBeDefined();
            }
            await expect(runtimeRepository.findEntry(
                RTC_RTT_RECEIPTS_NAMESPACE,
                receiptEntry.key,
            )).resolves.toBeUndefined();
            await expect(runtimeRepository.findEntry(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                intentEntry.key,
            )).resolves.toBeUndefined();
        } else {
            await expect(read).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            await expect(runtimeRepository.findEntry(
                RTC_RTT_RECEIPTS_NAMESPACE,
                receiptEntry.key,
            )).resolves.toBeDefined();
            await expect(runtimeRepository.findEntry(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                intentEntry.key,
            )).resolves.toBeDefined();
        }
        expect(enqueueForRtt).not.toHaveBeenCalled();
    });

    it.each([
        'jointly-expired-siblings',
        'live-sibling',
        'missing-sibling',
    ] as const)(
        'preserves receipt authority while cleaning %s',
        async (caseName) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const groups = [
                createRttGroupSnapshot('room-expiry-sibling-a', [
                    'session-a',
                    'session-b',
                ]),
                createRttGroupSnapshot('room-expiry-sibling-b', [
                    'session-a',
                    'session-b',
                ]),
            ];
            const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
            const result = await executeRttMutation({
                repository,
                runtime: runtimeRepository,
                command: {
                    rtt: {
                        sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
                        rttMs: 1, createdAtEpochMs: 1, version: 1,
                    },
                    alSenderId: 'session-a',
                    candidateGroups: groups,
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 1,
                },
                readFacts: () => ({
                    requestedAtEpochMs: 1,
                    purgeAfterEpochMs: 60_001,
                }),
                sleep: async () => {},
            });
            if (result.computed.outcome !== 'write') {
                throw new Error('Expected accepted multi-group RTT mutation');
            }
            const [firstIntent, secondIntent] = result.computed.recomputeIntents;
            const receiptEntry = (await runtimeRepository.findEntry(
                RTC_RTT_RECEIPTS_NAMESPACE,
                result.computed.receipt.receiptId,
            ))!;
            const firstEntry = (await runtimeRepository.findEntry(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                firstIntent!.outboxId,
            ))!;
            const secondEntry = (await runtimeRepository.findEntry(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                secondIntent!.outboxId,
            ))!;
            if (caseName === 'live-sibling') {
                await runtimeRepository.upsert(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    secondEntry.key,
                    secondEntry.value,
                    secondEntry.expireAtTimestamp + 100,
                );
            } else if (caseName === 'missing-sibling') {
                await runtimeRepository.deleteIfRevision(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    secondEntry.key,
                    secondEntry.revision,
                );
            }
            const expiryRepository = new RtcRttRepository(runtimeRepository, {
                now: () => firstEntry.expireAtTimestamp + 1,
            });
            const read = expiryRepository.findRecomputeIntentEntry(firstEntry.key);

            if (caseName === 'jointly-expired-siblings') {
                await expect(read).resolves.toBeUndefined();
                await expect(runtimeRepository.findEntry(
                    RTC_RTT_RECEIPTS_NAMESPACE,
                    receiptEntry.key,
                )).resolves.toBeUndefined();
                await expect(runtimeRepository.findEntry(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    firstEntry.key,
                )).resolves.toBeUndefined();
                await expect(runtimeRepository.findEntry(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    secondEntry.key,
                )).resolves.toBeUndefined();
            } else {
                await expect(read).rejects.toMatchObject({
                    code: 'rtc-topology-repository-invariant-corruption',
                });
                await expect(runtimeRepository.findEntry(
                    RTC_RTT_RECEIPTS_NAMESPACE,
                    receiptEntry.key,
                )).resolves.toBeDefined();
                await expect(runtimeRepository.findEntry(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    firstEntry.key,
                )).resolves.toBeDefined();
                const persistedSecond = await runtimeRepository.findEntry(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    secondEntry.key,
                );
                if (caseName === 'missing-sibling') {
                    expect(persistedSecond).toBeUndefined();
                } else {
                    expect(persistedSecond).toBeDefined();
                }
            }
        },
    );

    it.each([
        { name: 'exact replay', divergent: false },
        { name: 'divergent reuse', divergent: true },
    ])('resolves $name from retained raw receipt authority without clocks or effects', async ({
        divergent,
    }) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const baseRtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 1, createdAtEpochMs: 1, version: 1,
        };
        const receiptId = toRtcRttMutationReceiptId(baseRtt);
        const commandHash = await hashStateMutationCommand({
            rtt: baseRtt,
            alSenderId: 'session-a',
        });
        await runtimeRepository.insertIfAbsent(
            RTC_RTT_RECEIPTS_NAMESPACE,
            receiptId,
            JSON.stringify({
                receiptId,
                sessionIdFrom: baseRtt.sessionIdFrom,
                sessionIdTo: baseRtt.sessionIdTo,
                measurementVersion: baseRtt.version,
                affectedGroupRefs: [{
                    applicationId: 'app-1',
                    groupId: 'room-retained-replay',
                }],
                acceptedAtEpochMs: 1,
                outcome: 'accepted',
                commandHash,
            }),
            1 + DEFAULT_RTC_RTT_MUTATION_RETENTION_MS,
        );
        const now = vi.fn(() => {
            throw new Error('RTT receipt replay clock');
        });
        const repository = new RtcRttRepository(runtimeRepository, { now });
        const policy = vi.fn(() => {
            throw new Error('RTT receipt replay policy');
        });
        const lifecycle = vi.fn(() => {
            throw new Error('RTT receipt replay lifecycle');
        });
        const measurement = vi.spyOn(repository, 'findMeasurementEntry')
            .mockRejectedValue(new Error('RTT receipt replay measurement'));
        const measurementList = vi.spyOn(repository, 'listMeasurementEntries')
            .mockRejectedValue(new Error('RTT receipt replay measurement list'));
        const admission = vi.spyOn(repository, 'findEndpointAdmissionEntry')
            .mockRejectedValue(new Error('RTT receipt replay admission'));
        const cleanup = vi.spyOn(runtimeRepository, 'deleteIfRevision')
            .mockRejectedValue(new Error('RTT receipt replay cleanup'));
        const transaction = vi.spyOn(runtimeRepository, 'begin')
            .mockRejectedValue(new Error('RTT receipt replay transaction'));
        const request = {
            rtt: divergent ? { ...baseRtt, rttMs: 2 } : baseRtt,
            alSenderId: 'session-a',
        };
        const executed = executeRttMutationService({
            repository,
            runtime: runtimeRepository,
            request,
            readCommand: policy,
            readFacts: lifecycle,
            sleep: async () => {},
        });

        if (divergent) {
            await expect(executed).rejects.toMatchObject({
                code: 'rtc-rtt-idempotency-conflict',
            });
        } else {
            await expect(executed).resolves.toMatchObject({
                updated: false,
                computed: { outcome: 'replay', reason: 'accepted' },
            });
        }
        expect(now).not.toHaveBeenCalled();
        expect(policy).not.toHaveBeenCalled();
        expect(lifecycle).not.toHaveBeenCalled();
        expect(measurement).not.toHaveBeenCalled();
        expect(measurementList).not.toHaveBeenCalled();
        expect(admission).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
    });

    it('replays an accepted RTT after measurement and admission expiry and rejects divergent reuse', async () => {
        let now = 1;
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            ttlMs: 10,
            now: () => now,
        });
        const group = createRttGroupSnapshot('room-replay', ['session-a', 'session-b']);
        const command = {
            rtt: {
                sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
                rttMs: 1, createdAtEpochMs: 1, version: 1,
            },
            alSenderId: 'session-a',
            candidateGroups: [group],
            overlaySnapshotsByGroupKey: new Map<string, RallarOverlayTopologySnapshot>(),
            degreeLimit: 1,
        };
        let readFacts: () => ReturnType<RtcRttRepository['readMutationFacts']> =
            () => repository.readMutationFacts();
        let readCommand: (() => typeof command) | undefined;
        const execute = (nextCommand = command) => executeRttMutation({
            repository,
            runtime: runtimeRepository,
            command: nextCommand,
            ...(readCommand ? { readCommand } : {}),
            readFacts,
            sleep: async () => {},
        });

        await expect(execute()).resolves.toMatchObject({
            updated: true,
            computed: { outcome: 'write' },
        });
        const receiptReads = vi.spyOn(repository, 'probeMutationReceiptEntry');
        const measurementReads = vi.spyOn(repository, 'findMeasurementEntry');
        const measurementLists = vi.spyOn(repository, 'listMeasurementEntries');
        const admissionReads = vi.spyOn(repository, 'findEndpointAdmissionEntry');
        const conditionalDeletes = vi.spyOn(runtimeRepository, 'deleteIfRevision');
        const conditionalUpdates = vi.spyOn(runtimeRepository, 'upsertIfRevision');
        const transactions = vi.spyOn(runtimeRepository, 'begin');
        const conditionalInserts = vi.spyOn(runtimeRepository, 'insertIfAbsent');
        const policyReads = vi.fn(() => {
            throw new Error('RTT replay read policy authority');
        });
        const lifecycleReads = vi.fn(() => {
            throw new Error('RTT replay read lifecycle clock');
        });
        readCommand = policyReads;
        readFacts = lifecycleReads;
        now = 12;
        await expect(execute()).resolves.toMatchObject({
            updated: false,
            computed: { outcome: 'replay', reason: 'accepted' },
        });
        expect(receiptReads).toHaveBeenCalledTimes(1);
        expect(measurementReads).not.toHaveBeenCalled();
        expect(measurementLists).not.toHaveBeenCalled();
        expect(admissionReads).not.toHaveBeenCalled();
        expect(conditionalDeletes).not.toHaveBeenCalled();
        expect(conditionalUpdates).not.toHaveBeenCalled();
        expect(transactions).not.toHaveBeenCalled();
        expect(conditionalInserts).not.toHaveBeenCalled();
        expect(policyReads).not.toHaveBeenCalled();
        expect(lifecycleReads).not.toHaveBeenCalled();
        await expect(execute({
            ...command,
            rtt: { ...command.rtt, rttMs: 2 },
        })).rejects.toMatchObject({ code: 'rtc-rtt-idempotency-conflict' });
        await expect(execute({
            ...command,
            alSenderId: 'session-b',
        })).rejects.toMatchObject({ code: 'rtc-rtt-idempotency-conflict' });
        expect(receiptReads).toHaveBeenCalledTimes(3);
        expect(measurementReads).not.toHaveBeenCalled();
        expect(measurementLists).not.toHaveBeenCalled();
        expect(admissionReads).not.toHaveBeenCalled();
        expect(conditionalDeletes).not.toHaveBeenCalled();
        expect(conditionalUpdates).not.toHaveBeenCalled();
        expect(transactions).not.toHaveBeenCalled();
        expect(conditionalInserts).not.toHaveBeenCalled();
        expect(policyReads).not.toHaveBeenCalled();
        expect(lifecycleReads).not.toHaveBeenCalled();
        expect(await runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE))
            .toHaveLength(1);
        expect(await runtimeRepository.findAllEntries(RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE))
            .toHaveLength(1);
    });

    it('converges concurrent identical RTT writers through the immutable receipt winner', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        runtimeRepository.serializeTransactions = true;
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const group = createRttGroupSnapshot('room-concurrent', ['session-a', 'session-b']);
        const command = {
            rtt: {
                sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
                rttMs: 1, createdAtEpochMs: 1, version: 1,
            },
            alSenderId: 'session-a',
            candidateGroups: [group],
            overlaySnapshotsByGroupKey: new Map<string, RallarOverlayTopologySnapshot>(),
            degreeLimit: 1,
        };
        let waiting = 0;
        let release!: () => void;
        const together = new Promise<void>((resolve) => release = resolve);
        const originalList = repository.listMeasurementEntries.bind(repository);
        vi.spyOn(repository, 'listMeasurementEntries').mockImplementation(async () => {
            const values = await originalList();
            waiting += 1;
            if (waiting === 2) release();
            if (waiting <= 2) await together;
            return values;
        });
        const execute = () => executeRttMutation({
            repository,
            runtime: runtimeRepository,
            command,
            readFacts: () => ({ requestedAtEpochMs: 1, purgeAfterEpochMs: 60_001 }),
            sleep: async () => {},
        });

        const results = await Promise.all([execute(), execute()]);

        expect(results.filter(({ updated }) => updated)).toHaveLength(1);
        expect(results.filter(({ computed }) => computed.outcome === 'replay'))
            .toHaveLength(1);
        expect(await runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE))
            .toHaveLength(1);
        expect(await runtimeRepository.findAllEntries(RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE))
            .toHaveLength(1);
    });

    it('validates receipt identity before expiry cleanup on direct, list, and page reads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const surfaces = ['direct', 'list', 'page'] as const;
            for (const surface of surfaces) {
                const runtimeRepository = new FakeRuntimeStateRepository();
                const repository = new RtcRttRepository(runtimeRepository, {
                    now: () => 10_000,
                }) as RtcRttRepository & {
                    listMutationReceiptEntries(): Promise<readonly unknown[]>;
                    listMutationReceiptEntriesPage(input: { limit: number }): Promise<readonly unknown[]>;
                };
                const rtt = {
                    sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
                    rttMs: 1, createdAtEpochMs: 1, version: 1,
                };
                const receiptId = toRtcRttMutationReceiptId(rtt);
                await runtimeRepository.upsert(
                    RTC_RTT_RECEIPTS_NAMESPACE,
                    receiptId,
                    JSON.stringify({
                        receiptId,
                        sessionIdFrom: rtt.sessionIdFrom,
                        sessionIdTo: rtt.sessionIdTo,
                        measurementVersion: rtt.version,
                        affectedGroupRefs: [],
                        acceptedAtEpochMs: 1,
                        outcome: 'accepted',
                        commandHash: `sha256:${'A'.repeat(64)}`,
                    }),
                    9_000,
                );

                const read = surface === 'direct'
                    ? repository.findMutationReceipt(receiptId)
                    : surface === 'list'
                    ? repository.listMutationReceiptEntries()
                    : repository.listMutationReceiptEntriesPage({ limit: 10 });
                await expect(read).rejects.toMatchObject({
                    code: 'rtc-topology-repository-invariant-corruption',
                });
                expect(await runtimeRepository.findEntry(
                    RTC_RTT_RECEIPTS_NAMESPACE,
                    receiptId,
                )).toBeDefined();
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('validates complete recompute snapshots before expiry cleanup on direct, list, and page reads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const surfaces = ['direct', 'list', 'page'] as const;
            for (const surface of surfaces) {
                const runtimeRepository = new FakeRuntimeStateRepository();
                const repository = new RtcRttRepository(runtimeRepository, {
                    now: () => 10_000,
                }) as RtcRttRepository & {
                    findRecomputeIntentEntry(id: string): Promise<unknown>;
                    listRecomputeIntentEntriesPage(input: { limit: number }): Promise<readonly unknown[]>;
                };
                const group = createRttGroupSnapshot(
                    `room-corrupt-${surface}`,
                    ['session-a', 'session-b'],
                );
                const malformed = structuredClone(group) as unknown as Record<
                    string,
                    unknown
                >;
                if (surface === 'direct') {
                    delete malformed.causalRevision;
                } else if (surface === 'list') {
                    delete ((malformed.members as Record<string, unknown>[])[0]!).role;
                } else {
                    ((malformed.activeSessions as Record<string, unknown>[])[0]!)
                        .principalId = 'missing-principal';
                }
                const rtt = {
                    sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
                    rttMs: 1, createdAtEpochMs: 1, version: 1,
                };
                const receiptId = toRtcRttMutationReceiptId(rtt);
                const commandHash = `sha256:${'a'.repeat(64)}`;
                const outboxId = toRtcRttRecomputeOutboxId(
                    receiptId,
                    group.group,
                    commandHash,
                );
                await runtimeRepository.upsert(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    outboxId,
                    JSON.stringify({
                        outboxId,
                        receiptId,
                        groupSnapshot: malformed,
                        rtt,
                        createdAtEpochMs: 1,
                        commandHash,
                    }),
                    9_000,
                );

                const read = surface === 'direct'
                    ? repository.findRecomputeIntentEntry(outboxId)
                    : surface === 'list'
                    ? repository.listRecomputeIntentEntries()
                    : repository.listRecomputeIntentEntriesPage({ limit: 10 });
                await expect(read).rejects.toMatchObject({
                    code: 'rtc-topology-repository-invariant-corruption',
                });
                expect(await runtimeRepository.findEntry(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    outboxId,
                )).toBeDefined();
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes lifecycle facts after an RTT conflict crosses peer expiry', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 0 });
        const originalBegin = runtimeRepository.begin.bind(runtimeRepository);
        vi.spyOn(runtimeRepository, 'begin')
            .mockImplementationOnce(async () => {
                await repository.commitEndpointAdmission({
                    endpointId: 'session-a',
                    peers: [{
                        peerSessionId: 'session-c',
                        expiresAtEpochMs: 5,
                    }],
                    version: 1,
                    updatedAtEpochMs: 0,
                }, null, 5);
                throw new RuntimeStateWriteConflictError();
            })
            .mockImplementation(originalBegin);
        const requestedAtEpochMs = [1, 6];
        const readFacts = vi.fn(() => {
            const requestedAt = requestedAtEpochMs.shift();
            if (requestedAt === undefined) throw new Error('facts exhausted');
            return {
                requestedAtEpochMs: requestedAt,
                purgeAfterEpochMs: requestedAt + 100,
            };
        });
        const group = createRttGroupSnapshot(
            'room-ab',
            ['session-a', 'session-b'],
        );

        const result = await executeRttMutation({
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
                candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1,
            },
            readFacts,
            sleep: async () => {},
        });

        expect(result).toMatchObject({
            updated: true,
            computed: {
                outcome: 'write',
                measurementGuard: { purgeAfterEpochMs: 106 },
                receipt: { acceptedAtEpochMs: 6 },
            },
        });
        if (result.computed.outcome !== 'write') throw new Error('Expected write');
        expect(result.computed.endpointGuards[0]).toMatchObject({
            endpointId: 'session-a',
            value: {
                peers: [{
                    peerSessionId: 'session-b',
                    expiresAtEpochMs: 106,
                }],
                updatedAtEpochMs: 6,
            },
        });
        expect(readFacts).toHaveBeenCalledTimes(2);
        expect(requestedAtEpochMs).toEqual([]);
        await expect(repository.findMeasurementEntry('session-a', 'session-b'))
            .resolves.toMatchObject({ entry: { expireAtTimestamp: 106 } });
    });

    it('fully rereads RTT authority after conflict when a session connection boundary moves past acceptance', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 0 });
        const originalBegin = runtimeRepository.begin.bind(runtimeRepository);
        const begin = vi.spyOn(runtimeRepository, 'begin')
            .mockImplementationOnce(async () => {
                throw new RuntimeStateWriteConflictError();
            })
            .mockImplementation(originalBegin);
        const initial = createRttGroupSnapshot(
            'room-session-boundary',
            ['session-a', 'session-b'],
        );
        const futureConnection: GroupSnapshot = {
            ...initial,
            activeSessions: initial.activeSessions.map((session) => ({
                ...session,
                generationVersion: 3,
                connectedAtEpochMs: 3,
                lastHeartbeatAtEpochMs: 3,
            })),
        };
        const commands = [initial, futureConnection];
        const readCommand = vi.fn(() => {
            const group = commands.shift();
            if (!group) throw new Error('commands exhausted');
            return {
                rtt: {
                    sessionIdFrom: 'session-a',
                    sessionIdTo: 'session-b',
                    rttMs: 1,
                    createdAtEpochMs: 1,
                    version: 1,
                },
                alSenderId: 'session-a',
                candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1,
            };
        });
        const stableCommand = readCommand();
        commands.unshift(initial);

        const result = await executeRttMutation({
            repository,
            runtime: runtimeRepository,
            command: stableCommand,
            readCommand,
            readFacts: () => ({
                requestedAtEpochMs: 2,
                purgeAfterEpochMs: 60_002,
            }),
            sleep: async () => {},
        });

        expect(result).toMatchObject({
            updated: false,
            computed: {
                outcome: 'rejected',
                reason: 'no-shared-active-group',
            },
        });
        expect(readCommand).toHaveBeenCalledTimes(3);
        expect(begin).toHaveBeenCalledTimes(1);
        await expect(repository.findMeasurement('session-a', 'session-b'))
            .resolves.toBeUndefined();
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
            readFacts: () => ({
                requestedAtEpochMs: 1,
                purgeAfterEpochMs: 60_001,
            }),
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

    it('autonomously retries a pending RTT recompute intent after enqueue failure and exact receipt replay', async () => {
        const module = await import(
            '../../shared-server/rallar-system/services/RtcTopologyOutboxWork.ts'
        ) as unknown as Record<string, unknown>;
        const initialiseWorker = module.initRtcRttRecomputeOutboxWorker as
            | ((input: Readonly<{
                repository: RtcRttRepository;
                publisher: RtcTopologyWorkPublisher;
                debounceMs: number;
                intervalMs: number;
                retryDelaysMs: readonly number[];
                now: () => number;
                schedule(callback: () => Promise<void>, delayMs: number): unknown;
                cancel(handle: unknown): void;
                onError(error: unknown): void;
            }>) => Readonly<{
                firstRun: Promise<number>;
                wake(): void;
                stop(): void;
            }>)
            | undefined;
        expect(typeof initialiseWorker).toBe('function');

        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-autonomous-retry',
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 2 });
        const enqueueForRtt = vi.fn()
            .mockRejectedValueOnce(new Error('queue temporarily unavailable'))
            .mockResolvedValue(undefined);
        const scheduled: Array<Readonly<{
            callback: () => Promise<void>;
            delayMs: number;
            handle: object;
        }>> = [];
        const cancelled: unknown[] = [];
        const onError = vi.fn(() => {
            throw new Error('observer failed');
        });
        const worker = initialiseWorker!({
            repository,
            publisher: createRttWorkPublisher(enqueueForRtt),
            debounceMs: 0,
            intervalMs: 1_000,
            retryDelaysMs: [2, 8],
            now: () => 2,
            schedule: (callback, delayMs) => {
                const handle = {};
                scheduled.push({ callback, delayMs, handle });
                return handle;
            },
            cancel: (handle) => cancelled.push(handle),
            onError,
        });

        await expect(worker.firstRun).rejects.toThrow('queue temporarily unavailable');
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith({
            name: 'Error',
            message: 'RTC RTT recompute outbox delivery failed',
        });
        expect(JSON.stringify(onError.mock.calls)).not.toContain(
            'queue temporarily unavailable',
        );
        expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([2]);
        await expect(repository.findRecomputeIntentEntry(seeded.intent.outboxId))
            .resolves.toMatchObject({ value: { delivery: { state: 'pending' } } });

        const replayReadCommand = vi.fn(() => {
            throw new Error('receipt replay must not read mutable authority');
        });
        const replay = await executeRttMutation({
            repository,
            runtime: runtimeRepository,
            command: {
                rtt: seeded.intent.rtt,
                alSenderId: seeded.intent.rtt.sessionIdFrom,
                candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1,
            },
            readCommand: replayReadCommand,
            readFacts: () => {
                throw new Error('receipt replay must not read lifecycle facts');
            },
        });
        expect(replay).toMatchObject({
            updated: false,
            computed: { outcome: 'replay' },
        });
        expect(replayReadCommand).not.toHaveBeenCalled();
        expect(enqueueForRtt).toHaveBeenCalledTimes(1);

        await scheduled[0]!.callback();
        expect(enqueueForRtt).toHaveBeenCalledTimes(2);
        await expect(repository.findRecomputeIntentEntry(seeded.intent.outboxId))
            .resolves.toMatchObject({
                value: { delivery: { state: 'delivered', deliveredAtEpochMs: 2 } },
            });
        expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([2, 1_000]);

        worker.stop();
        worker.stop();
        expect(cancelled).toEqual([scheduled[1]!.handle]);
    });

    it('coalesces worker wakes while an RTT recompute drain is in flight', async () => {
        const module = await import(
            '../../shared-server/rallar-system/services/RtcTopologyOutboxWork.ts'
        ) as unknown as Record<string, unknown>;
        const initialiseWorker = module.initRtcRttRecomputeOutboxWorker as
            | ((input: Readonly<{
                repository: RtcRttRepository;
                publisher: RtcTopologyWorkPublisher;
                debounceMs: number;
                intervalMs: number;
                now: () => number;
                schedule(callback: () => Promise<void>, delayMs: number): unknown;
                cancel(handle: unknown): void;
            }>) => Readonly<{
                firstRun: Promise<number>;
                wake(): void;
                stop(): void;
            }>)
            | undefined;
        expect(typeof initialiseWorker).toBe('function');

        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-non-overlap',
            ['session-a', 'session-b'],
        );
        await seedAcceptedRttMutation(runtimeRepository, group);
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 2 });
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => release = resolve);
        let active = 0;
        let maxActive = 0;
        const enqueueForRtt = vi.fn(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await blocked;
            active -= 1;
        });
        const worker = initialiseWorker!({
            repository,
            publisher: createRttWorkPublisher(enqueueForRtt),
            debounceMs: 0,
            intervalMs: 1_000,
            now: () => 2,
            schedule: () => ({}),
            cancel: () => {},
        });

        while (enqueueForRtt.mock.calls.length === 0) await Promise.resolve();
        worker.wake();
        worker.wake();
        expect(enqueueForRtt).toHaveBeenCalledTimes(1);
        release();
        await worker.firstRun;
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

        expect(maxActive).toBe(1);
        expect(enqueueForRtt).toHaveBeenCalledTimes(1);
        worker.stop();
    });

    it('prevents an in-flight RTT worker completion from scheduling after stop', async () => {
        const module = await import(
            '../../shared-server/rallar-system/services/RtcTopologyOutboxWork.ts'
        ) as unknown as Record<string, unknown>;
        const initialiseWorker = module.initRtcRttRecomputeOutboxWorker as (
            input: Readonly<{
                repository: RtcRttRepository;
                publisher: RtcTopologyWorkPublisher;
                debounceMs: number;
                intervalMs: number;
                now: () => number;
                schedule(callback: () => Promise<void>, delayMs: number): unknown;
                cancel(handle: unknown): void;
            }>,
        ) => Readonly<{
            firstRun: Promise<number>;
            wake(): void;
            stop(): void;
        }>;
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-stop-in-flight',
            ['session-a', 'session-b'],
        );
        await seedAcceptedRttMutation(runtimeRepository, group);
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 2 });
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => release = resolve);
        const enqueueForRtt = vi.fn(() => blocked);
        const schedule = vi.fn(() => ({}));
        const cancel = vi.fn();
        const worker = initialiseWorker({
            repository,
            publisher: createRttWorkPublisher(enqueueForRtt),
            debounceMs: 0,
            intervalMs: 1_000,
            now: () => 2,
            schedule,
            cancel,
        });

        while (enqueueForRtt.mock.calls.length === 0) await Promise.resolve();
        worker.stop();
        worker.wake();
        release();
        await worker.firstRun;

        expect(schedule).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(enqueueForRtt).toHaveBeenCalledTimes(1);
    });

    it('retains a delivered RTT intent proof after a worker restart drain', async () => {
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
            readFacts: () => ({
                requestedAtEpochMs: 1,
                purgeAfterEpochMs: 60_001,
            }),
            sleep: async () => {},
        });
        const restarted = new RtcRttRepository(runtimeRepository, { now: () => 2 });
        const enqueueForRtt = vi.fn(async () => {});
        const deliveryClock = vi.fn()
            .mockReturnValueOnce(1)
            .mockReturnValueOnce(2);

        await drainRtcRttRecomputeOutbox({
            repository: restarted,
            publisher: createRttWorkPublisher(enqueueForRtt),
            debounceMs: 5,
            now: deliveryClock,
        });

        expect(enqueueForRtt).toHaveBeenCalledWith(group, expect.objectContaining({ version: 1 }), 5);
        expect(await restarted.listRecomputeIntents()).toEqual([
            expect.objectContaining({
                delivery: { state: 'delivered', deliveredAtEpochMs: 2 },
            }),
        ]);
        expect(deliveryClock).toHaveBeenCalledTimes(2);
    });

    it('rejects an out-of-family delivered timestamp before enqueue or CAS', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-invalid-delivery-time',
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const enqueueForRtt = vi.fn(async () => {});

        await expect(drainRtcRttRecomputeOutbox({
            repository,
            publisher: createRttWorkPublisher(enqueueForRtt),
            debounceMs: 0,
            now: () => seeded.expireAtTimestamp + 1,
        })).rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption',
        });

        expect(enqueueForRtt).not.toHaveBeenCalled();
        await expect(repository.findRecomputeIntentEntry(seeded.intent.outboxId))
            .resolves.toMatchObject({
                value: { delivery: { state: 'pending' } },
            });
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
            readFacts: () => ({
                requestedAtEpochMs: 1,
                purgeAfterEpochMs: 60_001,
            }),
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
            drainRtcRttRecomputeOutbox({
                repository,
                publisher,
                debounceMs: 0,
                now: () => 2,
            }),
            drainRtcRttRecomputeOutbox({
                repository,
                publisher,
                debounceMs: 0,
                now: () => 2,
            }),
        ]);

        expect(delivered.reduce((sum, count) => sum + count, 0)).toBe(1);
        expect(enqueueForRtt).toHaveBeenCalledTimes(2);
        expect(await repository.listRecomputeIntents()).toEqual([
            expect.objectContaining({
                delivery: { state: 'delivered', deliveredAtEpochMs: 2 },
            }),
        ]);

        await expect(drainRtcRttRecomputeOutbox({
            repository,
            publisher,
            debounceMs: 0,
            now: () => 3,
        })).resolves.toBe(0);
        expect(enqueueForRtt).toHaveBeenCalledTimes(2);
    });

    it('retains all delivered multi-group intents as one complete family proof', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const groups = [
            createRttGroupSnapshot('room-delivered-family-a', [
                'session-a',
                'session-b',
            ]),
            createRttGroupSnapshot('room-delivered-family-b', [
                'session-a',
                'session-b',
            ]),
        ];
        const seeded = await seedAcceptedRttMutationFamily(runtimeRepository, groups);
        const enqueueForRtt = vi.fn(async () => {});

        await expect(drainRtcRttRecomputeOutbox({
            repository: seeded.repository,
            publisher: createRttWorkPublisher(enqueueForRtt),
            debounceMs: 0,
            now: () => 2,
        })).resolves.toBe(2);

        expect(enqueueForRtt).toHaveBeenCalledTimes(2);
        await expect(seeded.repository.listRecomputeIntentEntries())
            .resolves.toMatchObject([
                { value: { delivery: { state: 'delivered', deliveredAtEpochMs: 2 } } },
                { value: { delivery: { state: 'delivered', deliveredAtEpochMs: 2 } } },
            ]);
        await expect(seeded.repository.probeMutationReceiptEntry(
            seeded.receipt.receiptId,
        )).resolves.toBeDefined();
    });

    it('preserves pending and delivered siblings after a partial family drain', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const groups = [
            createRttGroupSnapshot('room-partial-family-a', [
                'session-a',
                'session-b',
            ]),
            createRttGroupSnapshot('room-partial-family-b', [
                'session-a',
                'session-b',
            ]),
        ];
        const seeded = await seedAcceptedRttMutationFamily(runtimeRepository, groups);
        const enqueueForRtt = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('second family enqueue failed'));

        await expect(drainRtcRttRecomputeOutbox({
            repository: seeded.repository,
            publisher: createRttWorkPublisher(enqueueForRtt),
            debounceMs: 0,
            now: () => 2,
        })).rejects.toThrow('second family enqueue failed');

        const family = await seeded.repository.listRecomputeIntentEntries();
        expect(family).toHaveLength(2);
        expect(family.map(({ value }) => value.delivery)).toEqual([
            { state: 'delivered', deliveredAtEpochMs: 2 },
            { state: 'pending' },
        ]);
        await expect(seeded.repository.probeMutationReceiptEntry(
            seeded.receipt.receiptId,
        )).resolves.toBeDefined();
    });

    it('atomically sweeps a complete jointly-expired pending/delivered family', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const groups = [
            createRttGroupSnapshot('room-sweep-complete-a', [
                'session-a',
                'session-b',
            ]),
            createRttGroupSnapshot('room-sweep-complete-b', [
                'session-a',
                'session-b',
            ]),
        ];
        const seeded = await seedAcceptedRttMutationFamily(runtimeRepository, groups);
        const enqueueForRtt = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('leave one pending'));
        await expect(drainRtcRttRecomputeOutbox({
            repository: seeded.repository,
            publisher: createRttWorkPublisher(enqueueForRtt),
            debounceMs: 0,
            now: () => 2,
        })).rejects.toThrow('leave one pending');
        const expiryRepository = new RtcRttRepository(runtimeRepository, {
            now: () => seeded.expireAtTimestamp + 1,
            sleep: async () => {},
        });
        await expect(runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE))
            .resolves.toHaveLength(1);
        await expect(runtimeRepository.findAllEntries(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
        )).resolves.toHaveLength(2);

        await expect(expiryRepository.cleanupExpiredReceiptFamilies())
            .resolves.toBe(1);

        await expect(runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE))
            .resolves.toEqual([]);
        await expect(runtimeRepository.findAllEntries(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
        )).resolves.toEqual([]);
    });

    it('fully rereads an expired receipt family after its aggregate guard conflicts', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-sweep-guard-conflict',
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const sleep = vi.fn(async () => {});
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => seeded.expireAtTimestamp + 1,
            sleep,
        });
        const receiptReads = vi.spyOn(runtimeRepository, 'findEntry');
        const siblingReads = vi.spyOn(runtimeRepository, 'findEntriesByPrefix');
        let conflicts = 0;
        runtimeRepository.beforeConditionalWrite = async (
            operation,
            namespace,
            key,
        ) => {
            if (
                conflicts === 0 &&
                operation === 'upsertIfRevision' &&
                namespace === RTC_RTT_RECEIPTS_NAMESPACE
            ) {
                conflicts += 1;
                const current = (await runtimeRepository.findEntry(namespace, key))!;
                await runtimeRepository.upsert(
                    namespace,
                    key,
                    current.value,
                    current.expireAtTimestamp,
                );
            }
        };

        await expect(repository.cleanupExpiredReceiptFamilies()).resolves.toBe(1);

        expect(conflicts).toBe(1);
        expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([2]);
        expect(receiptReads.mock.calls.filter(([namespace]) =>
            namespace === RTC_RTT_RECEIPTS_NAMESPACE
        )).toHaveLength(3);
        expect(siblingReads).toHaveBeenCalledTimes(2);
        await expect(runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE))
            .resolves.toEqual([]);
        await expect(runtimeRepository.findAllEntries(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
        )).resolves.toEqual([]);
    });

    it('cleans a later valid expired family before surfacing an earlier corrupt family', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-sweep-independent-families',
            ['session-a', 'session-b'],
        );
        const corrupt = await seedAcceptedRttMutation(runtimeRepository, group);
        const valid = await seedAcceptedRttMutation(runtimeRepository, group, {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 2,
            createdAtEpochMs: 2,
            version: 2,
        });
        const corruptReceipt = (await runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            corrupt.receipt.receiptId,
        ))!;
        await runtimeRepository.upsert(
            RTC_RTT_RECEIPTS_NAMESPACE,
            corruptReceipt.key,
            '{',
            corruptReceipt.expireAtTimestamp,
        );
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => valid.expireAtTimestamp + 1,
            sleep: async () => {},
        });

        await expect(repository.cleanupExpiredReceiptFamilies())
            .rejects.toMatchObject({
                name: 'RtcRttReceiptFamilyCleanupError',
                removedCount: 1,
                failures: [expect.objectContaining({
                    familyId: corrupt.receipt.receiptId,
                })],
            });

        await expect(runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            corrupt.receipt.receiptId,
        )).resolves.toBeDefined();
        await expect(runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            valid.receipt.receiptId,
        )).resolves.toBeUndefined();
        await expect(runtimeRepository.findEntry(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            valid.intent.outboxId,
        )).resolves.toBeUndefined();
    });

    it('detects and preserves an expired receiptless recompute-intent orphan', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-sweep-orphan',
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        const receiptEntry = (await runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            seeded.receipt.receiptId,
        ))!;
        await runtimeRepository.deleteIfRevision(
            RTC_RTT_RECEIPTS_NAMESPACE,
            receiptEntry.key,
            receiptEntry.revision,
        );
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => seeded.expireAtTimestamp + 1,
        });

        await expect(repository.cleanupExpiredReceiptFamilies())
            .rejects.toMatchObject({
                name: 'RtcRttReceiptFamilyCleanupError',
                removedCount: 0,
                failures: [expect.objectContaining({
                    familyId: seeded.receipt.receiptId,
                })],
            });
        await expect(runtimeRepository.findEntry(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            seeded.intent.outboxId,
        )).resolves.toBeDefined();
    });

    it('preserves malformed physical rows while cleaning an unrelated valid family', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const group = createRttGroupSnapshot(
            'room-sweep-malformed-physical-rows',
            ['session-a', 'session-b'],
        );
        const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
        await runtimeRepository.upsert(
            RTC_RTT_RECEIPTS_NAMESPACE,
            '!malformed-receipt-key',
            'receipt-secret-not-json',
            seeded.expireAtTimestamp,
        );
        await runtimeRepository.upsert(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            '!malformed-intent-key',
            'intent-secret-not-json',
            seeded.expireAtTimestamp,
        );
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => seeded.expireAtTimestamp + 1,
        });

        const cleanupError = await repository.cleanupExpiredReceiptFamilies()
            .catch((error: unknown) => error);
        expect(cleanupError).toBeInstanceOf(RtcRttReceiptFamilyCleanupError);
        if (!(cleanupError instanceof RtcRttReceiptFamilyCleanupError)) {
            throw cleanupError;
        }
        expect(cleanupError.removedCount).toBe(1);
        expect(cleanupError.failures.map(({ familyId }) => familyId)).toEqual([
            '!malformed-intent-key',
            '!malformed-receipt-key',
        ]);
        expect(JSON.stringify(cleanupError)).not.toContain('receipt-secret-not-json');
        expect(JSON.stringify(cleanupError)).not.toContain('intent-secret-not-json');
        await expect(runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            '!malformed-receipt-key',
        )).resolves.toBeDefined();
        await expect(runtimeRepository.findEntry(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            '!malformed-intent-key',
        )).resolves.toBeDefined();
        await expect(runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            seeded.receipt.receiptId,
        )).resolves.toBeUndefined();
    });

    it.each(['live-family', 'mismatched-expiry'] as const)(
        'preserves a %s during specialized receipt-family sweeping',
        async (caseName) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const group = createRttGroupSnapshot(
                `room-sweep-${caseName}`,
                ['session-a', 'session-b'],
            );
            const seeded = await seedAcceptedRttMutation(runtimeRepository, group);
            if (caseName === 'mismatched-expiry') {
                const intentEntry = (await runtimeRepository.findEntry(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    seeded.intent.outboxId,
                ))!;
                await runtimeRepository.upsert(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    intentEntry.key,
                    intentEntry.value,
                    intentEntry.expireAtTimestamp + 100,
                );
            }
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => caseName === 'live-family'
                    ? seeded.expireAtTimestamp - 1
                    : seeded.expireAtTimestamp + 1,
                sleep: async () => {},
            });

            if (caseName === 'live-family') {
                await expect(repository.cleanupExpiredReceiptFamilies())
                    .resolves.toBe(0);
            } else {
                await expect(repository.cleanupExpiredReceiptFamilies())
                    .rejects.toMatchObject({
                        code: 'rtc-topology-repository-invariant-corruption',
                    });
            }
            await expect(runtimeRepository.findAllEntries(
                RTC_RTT_RECEIPTS_NAMESPACE,
            )).resolves.toHaveLength(1);
            await expect(runtimeRepository.findAllEntries(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            )).resolves.toHaveLength(1);
        },
    );

    it.each(['zero', 'missing', 'extra', 'corrupt'] as const)(
        'fails closed while sweeping a %s expired receipt family',
        async (caseName) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const groups = [
                createRttGroupSnapshot(`room-sweep-${caseName}-a`, [
                    'session-a',
                    'session-b',
                ]),
                createRttGroupSnapshot(`room-sweep-${caseName}-b`, [
                    'session-a',
                    'session-b',
                ]),
            ];
            const seeded = await seedAcceptedRttMutationFamily(runtimeRepository, groups);
            const receiptEntry = (await runtimeRepository.findEntry(
                RTC_RTT_RECEIPTS_NAMESPACE,
                seeded.receipt.receiptId,
            ))!;
            const intentEntries = await runtimeRepository.findAllEntries(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            );
            if (caseName === 'zero') {
                await runtimeRepository.upsert(
                    RTC_RTT_RECEIPTS_NAMESPACE,
                    receiptEntry.key,
                    JSON.stringify({
                        ...seeded.receipt,
                        affectedGroupRefs: [],
                    }),
                    receiptEntry.expireAtTimestamp,
                );
            } else if (caseName === 'missing') {
                await runtimeRepository.deleteIfRevision(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    intentEntries[1]!.key,
                    intentEntries[1]!.revision,
                );
            } else if (caseName === 'extra') {
                const extraGroup = createRttGroupSnapshot(
                    'room-sweep-unexpected-extra',
                    ['session-a', 'session-b'],
                );
                const firstIntent = JSON.parse(intentEntries[0]!.value) as
                    Record<string, unknown>;
                const extraOutboxId = toRtcRttRecomputeOutboxId(
                    seeded.receipt.receiptId,
                    extraGroup.group,
                    seeded.receipt.commandHash,
                );
                await runtimeRepository.upsert(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    extraOutboxId,
                    JSON.stringify({
                        ...firstIntent,
                        outboxId: extraOutboxId,
                        groupSnapshot: extraGroup,
                        delivery: { state: 'pending' },
                    }),
                    receiptEntry.expireAtTimestamp,
                );
            } else {
                await runtimeRepository.upsert(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    intentEntries[1]!.key,
                    '{',
                    receiptEntry.expireAtTimestamp,
                );
            }
            const repository = new RtcRttRepository(runtimeRepository, {
                now: () => receiptEntry.expireAtTimestamp + 1,
                sleep: async () => {},
            });

            await expect(repository.cleanupExpiredReceiptFamilies())
                .rejects.toMatchObject({
                    code: 'rtc-topology-repository-invariant-corruption',
                });
            await expect(runtimeRepository.findEntry(
                RTC_RTT_RECEIPTS_NAMESPACE,
                receiptEntry.key,
            )).resolves.toBeDefined();
        },
    );

    it('starts and stops periodic receipt-family cleanup on a non-evicting runtime', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, { now: () => 1 });
        const scheduled: Array<Readonly<{
            callback: () => void;
            delayMs: number;
            handle: object;
        }>> = [];
        const cancelled: unknown[] = [];
        const errors: unknown[] = [];
        const handle = initRtcRttReceiptFamilyCleanup(repository, {
            intervalMs: 123,
            schedule: (callback, delayMs) => {
                const timer = {};
                scheduled.push({ callback, delayMs, handle: timer });
                return timer;
            },
            cancel: (timer) => cancelled.push(timer),
            onError: (error) => errors.push(error),
        });

        await expect(handle.firstRun).resolves.toBe(0);
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]!.delayMs).toBe(123);
        expect(errors).toEqual([]);

        handle.stop();
        expect(cancelled).toEqual([scheduled[0]!.handle]);
    });

    it('continues periodic family cleanup after an error without overlapping runs', async () => {
        const repository = new RtcRttRepository(
            new FakeRuntimeStateRepository(),
            { now: () => 1 },
        );
        const failure = new Error('one corrupt family');
        let resolveSecond!: (removed: number) => void;
        const secondRun = new Promise<number>((resolve) => {
            resolveSecond = resolve;
        });
        const cleanup = vi.spyOn(repository, 'cleanupExpiredReceiptFamilies')
            .mockRejectedValueOnce(failure)
            .mockImplementationOnce(() => secondRun);
        const scheduled: Array<Readonly<{
            callback: () => void;
            handle: object;
        }>> = [];
        const handle = initRtcRttReceiptFamilyCleanup(repository, {
            intervalMs: 10,
            schedule: (callback) => {
                const timer = {};
                scheduled.push({ callback, handle: timer });
                return timer;
            },
            cancel: () => {},
        });

        await expect(handle.firstRun).rejects.toBe(failure);
        expect(scheduled).toHaveLength(1);
        scheduled[0]!.callback();
        await Promise.resolve();
        expect(cleanup).toHaveBeenCalledTimes(2);
        expect(scheduled).toHaveLength(1);

        resolveSecond(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(scheduled).toHaveLength(2);
        handle.stop();
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
        stateRevision: 2,
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
            activeMemberCount: sessionIds.length,
            ownerPrincipalId: sessionIds[0]!,
            created: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        },
        members: sessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? 'owner' as const : 'member' as const,
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

type MutableRttWriteCandidate = Record<string, unknown> & {
    affectedGroups: unknown[];
    endpointGuards: Array<Record<string, unknown> & {
        endpointId: string;
        expectedRevision: number | null;
        expireAtTimestamp: number;
        value: Record<string, unknown> & {
            endpointId: string;
            peers: Array<Record<string, unknown> & {
                peerSessionId: string;
                expiresAtEpochMs: number;
            }>;
        };
    }>;
    measurementGuard: Record<string, unknown> & {
        expectedRevision: number | null;
        purgeAfterEpochMs: number;
        value: Record<string, unknown>;
    };
    recomputeIntents: Array<Record<string, unknown> & {
        rtt: Record<string, unknown>;
    }>;
};

function createValidRttWriteCandidate(): Extract<
    RtcRttMutationComputed,
    { outcome: 'write' }
> {
    const computed = computeRttMutation({
        command: {
            rtt: {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1,
            },
            alSenderId: 'session-a',
            candidateGroups: [
                createRttGroupSnapshot('room-write-gate', [
                    'session-a',
                    'session-b',
                ]),
            ],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 1,
        },
        read: {
            receipt: null,
            measurement: null,
            endpointAdmissions: [],
            measurements: [],
        },
        facts: {
            commandHash: `sha256:${'a'.repeat(64)}`,
            requestedAtEpochMs: 2,
            purgeAfterEpochMs: 60_002,
        },
    });
    if (computed.outcome !== 'write') throw new Error('Expected RTT write');
    return computed;
}

const rttWriteCandidateCorruptions: readonly Readonly<{
    label: string;
    corrupt(candidate: MutableRttWriteCandidate): MutableRttWriteCandidate;
}>[] = [
    {
        label: 'a missing endpoint guard field',
        corrupt: (candidate) => {
            delete (candidate as Record<string, unknown>).endpointGuards;
            return candidate;
        },
    },
    {
        label: 'an extra write-candidate field',
        corrupt: (candidate) => ({ ...candidate, unexpected: true }),
    },
    {
        label: 'only one endpoint guard',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: candidate.endpointGuards.slice(0, 1),
        }),
    },
    {
        label: 'an extra endpoint guard',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: [
                ...candidate.endpointGuards,
                structuredClone(candidate.endpointGuards[1]!),
            ],
        }),
    },
    {
        label: 'endpoint guards outside lexical order',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: [...candidate.endpointGuards].reverse(),
        }),
    },
    {
        label: 'duplicate endpoint guard identities',
        corrupt: (candidate) => {
            candidate.endpointGuards[1]!.endpointId = 'session-a';
            candidate.endpointGuards[1]!.value.endpointId = 'session-a';
            return candidate;
        },
    },
    {
        label: 'an extra endpoint guard field',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.unexpected = true;
            return candidate;
        },
    },
    {
        label: 'an invalid endpoint expected revision',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.expectedRevision = -1;
            return candidate;
        },
    },
    ...([0, 1] as const).map((endpointIndex) => ({
        label: `endpoint ${endpointIndex + 1} insert domain version differing from its storage guard`,
        corrupt: (candidate: MutableRttWriteCandidate) => {
            candidate.endpointGuards[endpointIndex]!.value.version = 2;
            return candidate;
        },
    })),
    ...([0, 1] as const).map((endpointIndex) => ({
        label: `endpoint ${endpointIndex + 1} update domain version differing from its storage guard`,
        corrupt: (candidate: MutableRttWriteCandidate) => {
            candidate.endpointGuards[endpointIndex]!.expectedRevision = 0;
            candidate.endpointGuards[endpointIndex]!.value.version = 1;
            return candidate;
        },
    })),
    {
        label: 'an endpoint update whose next domain version would overflow',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.expectedRevision =
                Number.MAX_SAFE_INTEGER - 1;
            candidate.endpointGuards[0]!.value.version = Number.MAX_SAFE_INTEGER;
            return candidate;
        },
    },
    {
        label: 'an endpoint value bound to another identity',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.value.endpointId = 'session-c';
            return candidate;
        },
    },
    {
        label: 'an endpoint value missing the receipt peer',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.value.peers = [{
                peerSessionId: 'session-c',
                expiresAtEpochMs: 60_002,
            }];
            return candidate;
        },
    },
    {
        label: 'an endpoint lease before the measurement purge time',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.value.peers[0]!.expiresAtEpochMs = 60_001;
            candidate.endpointGuards[0]!.expireAtTimestamp = 60_001;
            return candidate;
        },
    },
    {
        label: 'an endpoint physical expiry differing from its leases',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.expireAtTimestamp += 1;
            return candidate;
        },
    },
    {
        label: 'a missing measurement guard field',
        corrupt: (candidate) => {
            delete (candidate.measurementGuard as Record<string, unknown>)
                .expectedRevision;
            return candidate;
        },
    },
    {
        label: 'an extra measurement guard field',
        corrupt: (candidate) => {
            candidate.measurementGuard.unexpected = true;
            return candidate;
        },
    },
    {
        label: 'an invalid measurement expected revision',
        corrupt: (candidate) => {
            candidate.measurementGuard.expectedRevision = -1;
            return candidate;
        },
    },
    {
        label: 'a measurement value differing from receipt and intents',
        corrupt: (candidate) => {
            candidate.measurementGuard.value = {
                ...candidate.measurementGuard.value,
                sessionIdTo: 'session-c',
            };
            return candidate;
        },
    },
    {
        label: 'an intent measurement differing from the measurement guard',
        corrupt: (candidate) => {
            candidate.recomputeIntents[0]!.rtt = {
                ...candidate.recomputeIntents[0]!.rtt,
                rttMs: 99,
            };
            return candidate;
        },
    },
    {
        label: 'a purge time outside the accepted lifecycle',
        corrupt: (candidate) => {
            candidate.measurementGuard.purgeAfterEpochMs = 2;
            return candidate;
        },
    },
    {
        label: 'affected groups differing from receipt and intents',
        corrupt: (candidate) => ({ ...candidate, affectedGroups: [] }),
    },
];

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

async function seedAcceptedRttMutation(
    runtime: FakeRuntimeStateRepository,
    group: GroupSnapshot,
    rtt = {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 1,
        createdAtEpochMs: 1,
        version: 1,
    },
) {
    const repository = new RtcRttRepository(runtime, {
        now: () => rtt.createdAtEpochMs,
    });
    const result = await executeRttMutation({
        repository,
        runtime,
        command: {
            rtt,
            alSenderId: 'session-a',
            candidateGroups: [group],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 1,
        },
        readFacts: () => ({
            requestedAtEpochMs: rtt.createdAtEpochMs,
            purgeAfterEpochMs: rtt.createdAtEpochMs + 60_000,
        }),
        sleep: async () => {},
    });
    if (result.computed.outcome !== 'write') {
        throw new Error('Expected accepted RTT seed');
    }
    const intentEntry = await runtime.findEntry(
        RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
        result.computed.recomputeIntents[0]!.outboxId,
    );
    return {
        receipt: result.computed.receipt,
        intent: result.computed.recomputeIntents[0]!,
        expireAtTimestamp: intentEntry!.expireAtTimestamp,
    };
}

async function seedAcceptedRttMutationFamily(
    runtime: FakeRuntimeStateRepository,
    groups: readonly GroupSnapshot[],
) {
    const repository = new RtcRttRepository(runtime, { now: () => 1 });
    const result = await executeRttMutation({
        repository,
        runtime,
        command: {
            rtt: {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1,
            },
            alSenderId: 'session-a',
            candidateGroups: groups,
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 1,
        },
        readFacts: () => ({
            requestedAtEpochMs: 1,
            purgeAfterEpochMs: 60_001,
        }),
        sleep: async () => {},
    });
    if (result.computed.outcome !== 'write') {
        throw new Error('Expected accepted RTT family seed');
    }
    const firstIntentEntry = await runtime.findEntry(
        RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
        result.computed.recomputeIntents[0]!.outboxId,
    );
    return {
        repository,
        receipt: result.computed.receipt,
        intents: result.computed.recomputeIntents,
        expireAtTimestamp: firstIntentEntry!.expireAtTimestamp,
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

function topologyInvariantCases(): readonly Readonly<{
    defect: string;
    snapshot: RallarOverlayTopologySnapshot;
}>[] {
    const base = createTopologySnapshot(createGroupRef(), 1);
    const threeSessionBase: RallarOverlayTopologySnapshot = {
        ...base,
        activeSessionIds: ['session-a', 'session-b', 'session-c'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a', 'session-c'],
            'session-c': ['session-b'],
        },
    };
    const fourSessionBase: RallarOverlayTopologySnapshot = {
        ...base,
        activeSessionIds: ['session-a', 'session-b', 'session-c', 'session-d'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
            'session-c': ['session-d'],
            'session-d': ['session-c'],
        },
    };
    return [
        { defect: 'overlay-mismatch', snapshot: { ...base, overlayId: 'wrong-overlay' } },
        {
            defect: 'duplicate-active-session',
            snapshot: { ...base, activeSessionIds: ['session-a', 'session-a', 'session-b'] },
        },
        {
            defect: 'noncanonical-active-session-order',
            snapshot: { ...base, activeSessionIds: ['session-b', 'session-a'] },
        },
        {
            defect: 'unknown-hop',
            snapshot: {
                ...base,
                nextHopsBySessionId: {
                    'session-a': ['session-b', 'session-z'],
                    'session-b': ['session-a'],
                },
            },
        },
        {
            defect: 'self-hop',
            snapshot: {
                ...base,
                nextHopsBySessionId: {
                    'session-a': ['session-a', 'session-b'],
                    'session-b': ['session-a'],
                },
            },
        },
        {
            defect: 'duplicate-hop',
            snapshot: {
                ...base,
                nextHopsBySessionId: {
                    'session-a': ['session-b', 'session-b'],
                    'session-b': ['session-a'],
                },
            },
        },
        {
            defect: 'noncanonical-hop-order',
            snapshot: {
                ...threeSessionBase,
                nextHopsBySessionId: {
                    ...threeSessionBase.nextHopsBySessionId,
                    'session-b': ['session-c', 'session-a'],
                },
            },
        },
        {
            defect: 'nonreciprocal-hop',
            snapshot: {
                ...base,
                nextHopsBySessionId: {
                    'session-a': ['session-b'],
                    'session-b': [],
                },
            },
        },
        {
            defect: 'missing-routing-key',
            snapshot: {
                ...base,
                nextHopsBySessionId: { 'session-a': ['session-b'] },
            },
        },
        {
            defect: 'unknown-routing-key',
            snapshot: {
                ...base,
                nextHopsBySessionId: {
                    ...base.nextHopsBySessionId,
                    'session-z': [],
                },
            },
        },
        { defect: 'disconnected-graph', snapshot: fourSessionBase },
        {
            defect: 'over-degree-graph',
            snapshot: { ...threeSessionBase, degreeLimit: 1 },
        },
        {
            defect: 'inverted-timestamps',
            snapshot: { ...base, createdAtEpochMs: 3, updatedAtEpochMs: 2 },
        },
        {
            defect: 'removed-nonempty-edge',
            snapshot: { ...base, state: 'removed' },
        },
        {
            defect: 'removed-missing-routing-key',
            snapshot: {
                ...base,
                state: 'removed',
                nextHopsBySessionId: { 'session-a': [] },
            },
        },
        {
            defect: 'removed-zero-degree-limit',
            snapshot: {
                ...base,
                state: 'removed',
                nextHopsBySessionId: {
                    'session-a': [],
                    'session-b': [],
                },
                degreeLimit: 0,
            },
        },
    ];
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
        targetGroupSnapshotVersion: 1,
        recipientSessionIds: snapshot.activeSessionIds,
        message: {
            id: {
                v: 2,
                msgId: JSON.stringify(['rtc-topology-publication', workId]),
                ts: 10,
                senderId: 'rallar-server',
            },
            route: {
                topicId: AppTopics.overlayTopology,
                contextId: snapshot.groupRef.groupId,
                resourceId: `${snapshot.overlayId}:${snapshot.sourceGroupStateRevision}:${snapshot.version}`,
            },
            payload: {
                typeId: AppTopics.overlayTopology,
                contentType: 'application/json',
                resource: JSON.stringify(snapshot),
            },
            targets: {
                mode: 'broadcast',
                scope: 'room',
                groupRef: snapshot.groupRef,
                minSnapshotVersion: 1,
            },
            delivery: { reliability: 'best-effort', ack: 'none' },
            audit: { createdBy: 'rallar-server', createdTs: 10 },
        } as unknown as ALMessage,
        createdAtEpochMs: 10,
    };
}

type LegacyRtcTopologyPublication = Omit<
    RtcTopologyPublication,
    'targetGroupSnapshotVersion'
>;

function toLegacyPublication(
    publication: RtcTopologyPublication,
): LegacyRtcTopologyPublication {
    const {
        targetGroupSnapshotVersion: _targetGroupSnapshotVersion,
        ...legacy
    } = structuredClone(publication);
    return {
        ...legacy,
        message: {
            ...legacy.message,
            id: {
                ...legacy.message.id,
                msgId: `legacy-random-${legacy.workId}`,
                ts: legacy.createdAtEpochMs + 1,
            },
            audit: {
                ...legacy.message.audit,
                createdTs: legacy.createdAtEpochMs + 1,
            },
        },
    };
}

function toUpgradedLegacyPublication(
    legacy: LegacyRtcTopologyPublication,
): RtcTopologyPublication {
    if (
        legacy.message.targets?.mode !== 'broadcast' ||
        legacy.message.targets.minSnapshotVersion === undefined
    ) {
        throw new Error('Expected legacy room publication target');
    }
    return {
        ...legacy,
        targetGroupSnapshotVersion:
            legacy.message.targets.minSnapshotVersion,
        message: {
            ...legacy.message,
            id: {
                ...legacy.message.id,
                msgId: JSON.stringify([
                    'rtc-topology-publication',
                    legacy.workId,
                ]),
                ts: legacy.createdAtEpochMs,
            },
            audit: {
                ...legacy.message.audit,
                createdTs: legacy.createdAtEpochMs,
            },
        },
    };
}

async function seedLegacyPublicationRows(
    runtime: FakeRuntimeStateRepository,
    publication: LegacyRtcTopologyPublication,
    expiry: number,
): Promise<void> {
    await runtime.upsert(
        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
        publication.publicationId,
        JSON.stringify(publication),
        expiry,
    );
    await runtime.upsert(
        RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
        publication.workId,
        JSON.stringify(publication.publicationId),
        expiry,
    );
}

function reorderJsonObjectKeys<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map((entry) => reorderJsonObjectKeys(entry)) as T;
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, entry]) => [key, reorderJsonObjectKeys(entry)]),
    ) as T;
}
