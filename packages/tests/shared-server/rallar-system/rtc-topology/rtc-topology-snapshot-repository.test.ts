import { describe, expect, it, vi } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    migrateLegacyRtcTopologySnapshotKeys,
    decideTopologySnapshot,
    RtcTopologySnapshotRevisionConflictError,
    RtcTopologySnapshotRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import {
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import {
    createGroupRef,
    createPublication,
    createTopologySnapshot,
    putOrLoadTopologyPublication,
    reorderJsonObjectKeys,
    topologyInvariantCases,
} from './rtc-topology-repository-test-fixtures.ts';

describe('RTC topology snapshot repository', () => {
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

        await expect(repository.observeSnapshot(snapshot)).resolves.toBe(
            'inserted',
        );

        expect(await repository.findSnapshot(groupRef)).toEqual(snapshot);
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('treats reordered topology object keys as one semantic tuple across decision and CAS', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const reordered = reorderJsonObjectKeys(snapshot);

        expect(decideTopologySnapshot(snapshot, reordered)).toBe('duplicate');
        await expect(
            repository.commitSnapshot({
                expected: undefined,
                candidate: snapshot,
            }),
        ).resolves.toMatchObject({
            status: 'accepted',
            observation: 'inserted',
        });
        const writes = vi.spyOn(runtimeRepository, 'upsertIfRevision');
        await expect(
            repository.commitSnapshot({
                expected: reordered,
                candidate: reordered,
            }),
        ).resolves.toMatchObject({
            status: 'accepted',
            observation: 'duplicate',
        });
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
            repository.commitSnapshot({
                expected: undefined,
                candidate: first,
            }),
            repository.commitSnapshot({
                expected: undefined,
                candidate: second,
            }),
        ]);

        expect(
            results.filter((result) => result.status === 'accepted'),
        ).toHaveLength(1);
        expect(
            results.filter((result) => result.status !== 'accepted'),
        ).toHaveLength(1);
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('observes topology snapshots monotonically by source revision before version', async () => {
        const repository = new RtcTopologySnapshotRepository(
            new FakeRuntimeStateRepository(),
        );
        const groupRef = createGroupRef();
        const revision2 = {
            ...createTopologySnapshot(groupRef, 1),
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 2,
            },
        };
        const revision1WithHigherOverlayVersion = {
            ...createTopologySnapshot(groupRef, 9),
            sourceGroupStateCausalRevision: {
                groupRevision: 1,
                presenceRevision: 1,
            },
        };

        expect(await repository.observeSnapshot(revision2)).toBe('inserted');
        expect(
            await repository.observeSnapshot(revision1WithHigherOverlayVersion),
        ).toBe('stale');
        expect(await repository.findSnapshot(groupRef)).toEqual(revision2);
        expect(await repository.observeSnapshot(revision2)).toBe('duplicate');
        await expect(
            repository.observeSnapshot({
                ...revision2,
                name: 'conflicting payload',
            }),
        ).rejects.toBeInstanceOf(RtcTopologySnapshotRevisionConflictError);
    });

    it('accepts a topology candidate only for the exact durable predecessor', async () => {
        const repository = new RtcTopologySnapshotRepository(
            new FakeRuntimeStateRepository(),
        );
        const groupRef = createGroupRef();
        const revision1 = createTopologySnapshot(groupRef, 1);
        const revision2 = {
            ...createTopologySnapshot(groupRef, 2),
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 2,
            },
        };

        await expect(
            repository.commitSnapshot({
                expected: undefined,
                candidate: revision1,
            }),
        ).resolves.toEqual({
            status: 'accepted',
            observation: 'inserted',
            snapshot: revision1,
        });
        await expect(
            repository.commitSnapshot({
                expected: undefined,
                candidate: revision2,
            }),
        ).resolves.toEqual({
            status: 'retry',
            current: revision1,
        });
        await expect(
            repository.commitSnapshot({
                expected: revision1,
                candidate: revision2,
            }),
        ).resolves.toEqual({
            status: 'accepted',
            observation: 'advanced',
            snapshot: revision2,
        });
    });

    it('uses injective topology keys and rejects wrong-slot snapshots before lazy expiry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologySnapshotRepository(
                runtimeRepository,
            );
            const absent = createGroupRef();
            delete (absent as { workspaceId?: string }).workspaceId;
            const sentinel = { ...absent, workspaceId: '_' };
            const delimiter = { ...absent, workspaceId: 'a:b%5F＿' };

            expect(
                new Set([
                    repository.snapshotKey(absent),
                    repository.snapshotKey(sentinel),
                    repository.snapshotKey(delimiter),
                ]).size,
            ).toBe(3);

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

            await expect(
                repository.findSnapshot(requested),
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            expect(
                await runtimeRepository.findEntry(
                    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                    key,
                ),
            ).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('validates snapshot direct, list, and page rows against physical identity', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(
            runtimeRepository,
        ) as RtcTopologySnapshotRepository & {
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
        await expect(
            repository.listSnapshotEntriesPage({ limit: 1 }),
        ).resolves.toHaveLength(1);
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

        await expect(repository.observeSnapshot(removed)).resolves.toBe(
            'inserted',
        );
        await expect(
            repository.findSnapshot(removed.groupRef),
        ).resolves.toEqual(removed);
    });

    it('rejects invalid computed next-hop maps at the write boundary before persisting or publishing', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const valid = createTopologySnapshot(createGroupRef(), 1);
        const invalid = {
            ...valid,
            nextHopsBySessionId: {
                'session-a': ['session-b'],
                'session-b': [],
            },
        };

        await expect(
            repository.commitSnapshot({
                expected: undefined,
                candidate: invalid,
            }),
        ).rejects.toThrow('next hops are not reciprocal');
        await expect(
            repository.findSnapshot(valid.groupRef),
        ).resolves.toBeUndefined();
        expect(
            await runtimeRepository.findAllEntries(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            ),
        ).toEqual([]);
    });

    it.each(
        topologyInvariantCases().flatMap(({ defect, snapshot }) =>
            (['direct', 'list', 'page', 'publication'] as const).map(
                (surface) => ({
                    defect,
                    snapshot,
                    surface,
                }),
            ),
        ),
    )(
        'rejects $defect topology corruption on the $surface surface before effects',
        async ({ defect, snapshot, surface }) => {
            vi.useFakeTimers();
            vi.setSystemTime(10_000);
            try {
                const runtimeRepository = new FakeRuntimeStateRepository();
                if (surface === 'publication') {
                    const repository = new RtcTopologyPublicationRepository(
                        runtimeRepository,
                    );
                    const publication = createPublication(
                        snapshot,
                        `work-${defect}`,
                    );
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

                    await expect(
                        repository.findPublication(
                            publication.groupRef,
                            publication.publicationId,
                        ),
                    ).rejects.toMatchObject({
                        code: 'rtc-topology-repository-invariant-corruption',
                    });
                    expect(
                        await runtimeRepository.findEntry(
                            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                            key,
                        ),
                    ).toBeDefined();
                    return;
                }

                const repository = new RtcTopologySnapshotRepository(
                    runtimeRepository,
                );
                const key = repository.snapshotKey(snapshot.groupRef);
                await runtimeRepository.upsert(
                    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                    key,
                    JSON.stringify(snapshot),
                    NEVER_EXPIRE_AT_TIMESTAMP,
                );
                const read =
                    surface === 'direct'
                        ? repository.findSnapshot(snapshot.groupRef)
                        : surface === 'list'
                          ? repository.listSnapshotEntries()
                          : repository.listSnapshotEntriesPage({ limit: 10 });
                await expect(read).rejects.toMatchObject({
                    code: 'rtc-topology-repository-invariant-corruption',
                });
                expect(
                    await runtimeRepository.findEntry(
                        RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                        key,
                    ),
                ).toBeDefined();
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it('persists a required target snapshot version and binds it to the AL target', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(
            runtimeRepository,
        );
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const base = createPublication(snapshot, 'work-target-version');
        const publication = {
            ...base,
            targetGroupSnapshotVersion: 1,
        };

        await expect(
            putOrLoadTopologyPublication(repository, publication, snapshot),
        ).resolves.toMatchObject({
            publication,
            inserted: true,
        });
        await expect(
            putOrLoadTopologyPublication(
                repository,
                {
                    ...publication,
                    publicationId: 'work-target-version-mismatch:1:1:1',
                    workId: 'work-target-version-mismatch',
                    targetGroupSnapshotVersion: 2,
                },
                snapshot,
            ),
        ).rejects.toThrow('snapshot version');
    });

    it('binds persisted publication message timestamps to explicit publication facts', async () => {
        const repository = new RtcTopologyPublicationRepository(
            new FakeRuntimeStateRepository(),
        );
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const publication = createPublication(snapshot, 'work-explicit-time');

        await expect(
            putOrLoadTopologyPublication(
                repository,
                {
                    ...publication,
                    message: {
                        ...publication.message,
                        id: { ...publication.message.id, ts: 11 },
                        audit: { ...publication.message.audit, createdTs: 11 },
                    },
                },
                snapshot,
            ),
        ).rejects.toThrow('timestamp');
    });

    it.each(['direct', 'list', 'page'] as const)(
        'rejects a nondeterministic publication message id on the %s surface',
        async (surface) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologyPublicationRepository(
                runtimeRepository,
            );
            const publication = createPublication(
                createTopologySnapshot(createGroupRef(), 1),
                `work-message-id-${surface}`,
            );
            const tampered = {
                ...publication,
                message: {
                    ...publication.message,
                    id: {
                        ...publication.message.id,
                        msgId: 'random-legacy-message-id',
                    },
                },
            };
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                repository.publicationKey(
                    tampered.groupRef,
                    tampered.publicationId,
                ),
                JSON.stringify(tampered),
                Date.now() + 60_000,
            );

            const read =
                surface === 'direct'
                    ? repository.findPublication(
                          tampered.groupRef,
                          tampered.publicationId,
                      )
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

        expect(repository.snapshotKey(explicitSentinel)).not.toBe(
            legacyAliasedKey,
        );
        expect(await repository.findSnapshot(explicitSentinel)).toEqual(
            snapshot,
        );
        expect(
            await runtimeRepository.findEntry(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                legacyAliasedKey,
            ),
        ).toBeUndefined();
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
        await expect(
            runtimeRepository.findEntry(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                legacyKey,
            ),
        ).resolves.toBeUndefined();
    });

    it.each([
        { label: 'at the observation boundary', expireAtTimestamp: 10_000 },
        { label: 'before the observation boundary', expireAtTimestamp: 9_999 },
    ])(
        'never resurrects a legacy topology snapshot expiring $label',
        async ({ expireAtTimestamp }) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologySnapshotRepository(
                runtimeRepository,
            );
            const ref = { ...createGroupRef(), workspaceId: '_' };
            const snapshot = createTopologySnapshot(ref, 1);
            const legacyKey = 'app=app-1:ws=_:group=room-1';
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                legacyKey,
                JSON.stringify(snapshot),
                expireAtTimestamp,
            );

            await expect(
                migrateLegacyRtcTopologySnapshotKeys(repository, {
                    oldWritersStopped: true,
                    observedAtEpochMs: 10_000,
                }),
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });

            await expect(
                runtimeRepository.findEntry(
                    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                    repository.snapshotKey(ref),
                ),
            ).resolves.toBeUndefined();
            await expect(
                runtimeRepository.findEntry(
                    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                    legacyKey,
                ),
            ).resolves.toMatchObject({ expireAtTimestamp });
        },
    );

    it('fails a snapshot migration conflict closed after one attempt without partial effects or backoff', async () => {
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
        const entriesBefore = await runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
        );
        runtimeRepository.beforeConditionalWrite = async (
            operation,
            namespace,
            key,
        ) => {
            if (
                operation === 'deleteIfRevision' &&
                namespace === RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE &&
                key === legacyKey
            ) {
                await runtimeRepository.upsert(
                    namespace,
                    key,
                    JSON.stringify(snapshot),
                    20_000,
                );
            }
        };
        const begin = vi.spyOn(runtimeRepository, 'begin');
        const sleep = vi.fn(async () => {});

        await expect(
            migrateLegacyRtcTopologySnapshotKeys(repository, {
                oldWritersStopped: true,
                observedAtEpochMs: 10_000,
                sleep,
            } as Parameters<typeof migrateLegacyRtcTopologySnapshotKeys>[1]),
        ).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);

        expect(begin).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        await expect(
            runtimeRepository.findAllEntries(RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE),
        ).resolves.toEqual(entriesBefore);
    });
});
