import { describe, expect, it, vi } from 'vitest';
import {
  createRtcTopologyExecutionReceipt,
  RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
  RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
  hashRtcTopologyExecutionCommand,
  migrateLegacyRtcTopologyPublicationKeys,
  type RtcTopologyPublication,
  RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import {
  corruptTopologyExecutionReceipt,
  createGroupRef,
  createPublication,
  createTopologySnapshot,
  putOrLoadTopologyPublication,
  reorderJsonObjectKeys,
  seedLegacyPublicationRows,
  toLegacyPublication,
  toUpgradedLegacyPublication,
} from './rtc-topology-repository-test-fixtures.ts';

describe('RTC topology publication repository', () => {
  it('persists immutable topology publications and rejects a divergent loaded retry', async () => {
    const repository = new RtcTopologyPublicationRepository(new FakeRuntimeStateRepository());
    const snapshot = createTopologySnapshot(createGroupRef(), 2);
    const publication = createPublication(snapshot, 'work-1');

    expect(await putOrLoadTopologyPublication(repository, publication, snapshot)).toEqual({
      publication,
      inserted: true,
    });
    const retrySnapshot = {
      ...snapshot,
      activeSessionIds: ['session-b'],
      nextHopsBySessionId: { 'session-b': [] },
    };
    await expect(
      putOrLoadTopologyPublication(
        repository,
        {
          ...publication,
          recipientSessionIds: ['session-b'],
          message: {
            ...publication.message,
            payload: {
              ...publication.message.payload,
              resource: JSON.stringify(retrySnapshot),
            },
          },
        },
        snapshot,
      ),
    ).rejects.toMatchObject({
      code: 'rtc-topology-publication-collision',
    });
  });

  it('loads a semantically equal publication retry with reordered object keys', async () => {
    const repository = new RtcTopologyPublicationRepository(new FakeRuntimeStateRepository());
    const snapshot = createTopologySnapshot(createGroupRef(), 2);
    const publication = createPublication(snapshot, 'work-reordered-load');

    await expect(
      putOrLoadTopologyPublication(repository, publication, snapshot),
    ).resolves.toMatchObject({
      inserted: true,
    });
    await expect(
      putOrLoadTopologyPublication(repository, reorderJsonObjectKeys(publication), snapshot),
    ).resolves.toEqual({ publication, inserted: false });
  });

  it('claims immutable publications without invoking an application lock', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    vi.spyOn(runtimeRepository, 'lockKey').mockRejectedValue(
      new Error('targeted publication locks are forbidden'),
    );
    const repository = new RtcTopologyPublicationRepository(runtimeRepository);
    const snapshot = createTopologySnapshot(createGroupRef(), 1);
    const publication = createPublication(snapshot, 'work-no-lock');

    await expect(putOrLoadTopologyPublication(repository, publication, snapshot)).resolves.toEqual({
      publication,
      inserted: true,
    });
    expect(runtimeRepository.locks).toEqual([]);
  });

  it('accepts documented optional AL envelope sections on durable publications', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new RtcTopologyPublicationRepository(runtimeRepository);
    const snapshot = createTopologySnapshot(createGroupRef(), 1);
    const base = createPublication(snapshot, 'work-optional-envelope');
    const publication = {
      ...base,
      message: {
        ...base.message,
        id: {
          ...base.message.id,
          sessionId: 'session-a',
          traceId: 'trace-1',
        },
        targets: {
          mode: 'broadcast' as const,
          scope: 'room' as const,
          groupRef: snapshot.groupRef,
          minSnapshotVersion: 1,
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
          reliability: 'best-effort' as const,
          ack: 'none' as const,
          ownership: 'shared' as const,
        },
        actions: { corrId: 'corr-1', replyToMsgId: 'reply-1' },
        qos: {
          dedup: {
            algo: 'semantic-key' as const,
            opts: {
              windowMs: 1_000,
              semanticKey: 'topology:room-1',
            },
          },
          expiry: {
            algo: 'expires-at' as const,
            opts: { expiresAtMs: 1_000 },
          },
        },
        diagnostics: { visitedPeerIds: ['session-a'] },
        audit: { createdBy: 'rallar-server', createdTs: 10 },
      },
    } satisfies RtcTopologyPublication;

    await expect(
      putOrLoadTopologyPublication(repository, publication, snapshot),
    ).resolves.toMatchObject({
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
    const seeded = await new RtcTopologySnapshotRepository(runtimeRepository).commitSnapshotGuard(
      createTopologySnapshot(createGroupRef(), 1),
      null,
    );
    if (seeded.status !== 'accepted') {
      throw new Error('Expected topology race snapshot seed');
    }

    const results = await Promise.allSettled([
      putOrLoadTopologyPublication(repository, first, createTopologySnapshot(createGroupRef(), 1)),
      putOrLoadTopologyPublication(repository, second, createTopologySnapshot(createGroupRef(), 1)),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'rtc-topology-publication-collision' },
    });
    expect(runtimeRepository.locks).toEqual([]);
  });

  it('requests recomputation when the topology predecessor moves before commit', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
    const current = createTopologySnapshot(createGroupRef(), 4);
    await expect(snapshots.commitSnapshotGuard(current, null)).resolves.toMatchObject({
      status: 'accepted',
    });
    const repository = new RtcTopologyExecutionRepository(runtimeRepository);
    const candidate = createTopologySnapshot(createGroupRef(), 3);

    await expect(
      repository.commit({
        expected: undefined,
        candidate,
        publication: createPublication(candidate, 'work-stale'),
      }),
    ).resolves.toEqual({
      status: 'retry',
      current,
    });
    expect(
      await new RtcTopologyPublicationRepository(runtimeRepository).findPublicationForWork(
        'work-stale',
      ),
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
        JSON.stringify({
          ...publication,
          publicationId: 'wrong-publication',
        }),
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

      await expect(
        repository.findPublication(groupRef, publication.publicationId),
      ).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });
      await expect(repository.listPublicationEntries()).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });
      await expect(repository.listPublicationEntriesPage({ limit: 10 })).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });
      await expect(
        repository.findWorkClaimEntry(groupRef, publication.workId),
      ).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });
      await expect(repository.listWorkClaimEntries()).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });
      await expect(repository.listWorkClaimEntriesPage({ limit: 10 })).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });
      expect(
        await runtimeRepository.findEntry(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, publicationKey),
      ).toBeDefined();
      expect(
        await runtimeRepository.findEntry(RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE, workKey),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'legacy',
    'missing',
    'extra',
    'hash',
    'attempt',
    'causal',
    'storage',
    'event',
    'outbox',
  ] as const)(
    'fails closed on a %s topology execution receipt before changing authority',
    async (defect) => {
      const runtimeRepository = new FakeRuntimeStateRepository();
      const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
      const publications = new RtcTopologyPublicationRepository(runtimeRepository);
      const snapshot = createTopologySnapshot(createGroupRef(), 1);
      const publication = createPublication(snapshot, `work-corrupt-receipt-${defect}`);
      const guard = await snapshots.commitSnapshotGuard(snapshot, null);
      if (guard.status !== 'accepted') {
        throw new Error('Expected topology snapshot seed to be accepted');
      }
      const receipt = createRtcTopologyExecutionReceipt(publication, {
        commandHash: await hashRtcTopologyExecutionCommand(publication),
        attemptCount: 1,
        acceptedStorageRevision: guard.storageRevision,
      });
      const corrupted = corruptTopologyExecutionReceipt(receipt, defect);
      const expireAtTimestamp = Date.now() + 60_000;
      await runtimeRepository.upsert(
        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
        publications.publicationKey(publication.groupRef, publication.publicationId),
        JSON.stringify(publication),
        expireAtTimestamp,
      );
      await runtimeRepository.upsert(
        RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
        publications.workIndexKey(publication.groupRef, publication.workId),
        JSON.stringify(corrupted),
        expireAtTimestamp,
      );
      const snapshotWrites = vi.spyOn(runtimeRepository, 'upsertIfRevision');
      const inserts = vi.spyOn(runtimeRepository, 'insertIfAbsent');

      await expect(
        new RtcTopologyExecutionRepository(runtimeRepository).readTopologyMutation(
          publication.groupRef,
          publication.workId,
        ),
      ).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });
      expect(snapshotWrites).not.toHaveBeenCalled();
      expect(inserts).not.toHaveBeenCalled();
    },
  );

  it('rejects incomplete persisted topology envelopes before cleanup on every read surface', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const defects = ['id', 'route', 'typeId'] as const;
      const surfaces = ['direct', 'list', 'page'] as const;
      for (const defect of defects) {
        for (const surface of surfaces) {
          const runtimeRepository = new FakeRuntimeStateRepository();
          const repository = new RtcTopologyPublicationRepository(runtimeRepository);
          const groupRef = createGroupRef();
          const publication = structuredClone(
            createPublication(
              createTopologySnapshot(groupRef, 1),
              `work-envelope-${defect}-${surface}`,
            ),
          );
          const message = publication.message as unknown as Record<string, unknown>;
          if (defect === 'typeId') {
            delete (message.payload as Record<string, unknown>).typeId;
          } else {
            delete message[defect];
          }
          const key = repository.publicationKey(groupRef, publication.publicationId);
          await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            key,
            JSON.stringify(publication),
            9_000,
          );

          const read =
            surface === 'direct'
              ? repository.findPublication(groupRef, publication.publicationId)
              : surface === 'list'
                ? repository.listPublicationEntries()
                : repository.listPublicationEntriesPage({
                    limit: 10,
                  });
          await expect(read).rejects.toMatchObject({
            code: 'rtc-topology-repository-invariant-corruption',
          });
          expect(
            await runtimeRepository.findEntry(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, key),
          ).toBeDefined();
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

    await expect(repository.findPublication(publication.publicationId)).rejects.toMatchObject({
      code: 'rtc-topology-repository-invariant-corruption',
    });

    await migrateLegacyRtcTopologyPublicationKeys(repository, {
      oldWritersStopped: true,
    });
    await migrateLegacyRtcTopologyPublicationKeys(repository, {
      oldWritersStopped: true,
    });

    expect(
      await repository.findPublicationForWork(publication.groupRef, publication.workId),
    ).toEqual(upgradedPublication);
    expect(
      await runtimeRepository.findEntry(
        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
        publication.publicationId,
      ),
    ).toBeUndefined();
    expect(
      await runtimeRepository.findEntry(
        RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
        publication.workId,
      ),
    ).toBeUndefined();
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

    await expect(
      Promise.all([
        migrateLegacyRtcTopologyPublicationKeys(repository, {
          oldWritersStopped: true,
        }),
        migrateLegacyRtcTopologyPublicationKeys(repository, {
          oldWritersStopped: true,
        }),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    await expect(
      repository.findPublicationForWork(upgraded.groupRef, upgraded.workId),
    ).resolves.toEqual(upgraded);
    await expect(
      runtimeRepository.findEntry(
        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
        legacyPublication.publicationId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      runtimeRepository.findEntry(
        RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
        legacyPublication.workId,
      ),
    ).resolves.toBeUndefined();
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

    await expect(
      migrateLegacyRtcTopologyPublicationKeys(repository, {
        oldWritersStopped: true,
      }),
    ).rejects.toMatchObject({
      code: 'rtc-topology-repository-invariant-corruption',
    });
  });

  it('fails a publication migration conflict closed after one attempt without partial effects or backoff', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new RtcTopologyPublicationRepository(runtimeRepository);
    const publication = createPublication(
      createTopologySnapshot(createGroupRef(), 1),
      'legacy-migration-conflict',
    );
    const legacyPublication = toLegacyPublication(publication);
    const expiry = Date.now() + 60_000;
    await seedLegacyPublicationRows(runtimeRepository, legacyPublication, expiry);
    const publicationsBefore = await runtimeRepository.findAllEntries(
      RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    );
    const claimsBefore = await runtimeRepository.findAllEntries(
      RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    );
    runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
      if (
        operation === 'deleteIfRevision' &&
        namespace === RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE &&
        key === legacyPublication.publicationId
      ) {
        await runtimeRepository.upsert(namespace, key, JSON.stringify(legacyPublication), expiry);
      }
    };
    const begin = vi.spyOn(runtimeRepository, 'begin');
    const sleep = vi.fn(async () => {});

    await expect(
      migrateLegacyRtcTopologyPublicationKeys(repository, {
        oldWritersStopped: true,
        sleep,
      } as Parameters<typeof migrateLegacyRtcTopologyPublicationKeys>[1]),
    ).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);

    expect(begin).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    await expect(
      runtimeRepository.findAllEntries(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE),
    ).resolves.toEqual(publicationsBefore);
    await expect(
      runtimeRepository.findAllEntries(RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE),
    ).resolves.toEqual(claimsBefore);
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
        repository.publicationKey(legacyPublication.groupRef, legacyPublication.publicationId),
        JSON.stringify(reorderJsonObjectKeys(legacyPublication)),
        expiry,
      );
      if (claimLayout === 'canonical-claim') {
        await runtimeRepository.upsert(
          RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
          repository.workIndexKey(legacyPublication.groupRef, legacyPublication.workId),
          JSON.stringify(
            reorderJsonObjectKeys({
              groupRef: legacyPublication.groupRef,
              workId: legacyPublication.workId,
              publicationId: legacyPublication.publicationId,
            }),
          ),
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

      await expect(
        repository.findPublication(legacyPublication.groupRef, legacyPublication.publicationId),
      ).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });

      await migrateLegacyRtcTopologyPublicationKeys(repository, {
        oldWritersStopped: true,
      });
      await migrateLegacyRtcTopologyPublicationKeys(repository, {
        oldWritersStopped: true,
      });

      await expect(
        repository.findPublicationForWork(upgraded.groupRef, upgraded.workId),
      ).resolves.toEqual(upgraded);
      await expect(
        runtimeRepository.findEntry(
          RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
          legacyPublication.workId,
        ),
      ).resolves.toBeUndefined();
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
      await seedLegacyPublicationRows(runtimeRepository, legacyPublication, expiry);
      if (partialDestination === 'claim') {
        await runtimeRepository.insertIfAbsent(
          RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
          repository.workIndexKey(upgraded.groupRef, upgraded.workId),
          JSON.stringify(
            reorderJsonObjectKeys({
              groupRef: upgraded.groupRef,
              workId: upgraded.workId,
              publicationId: upgraded.publicationId,
            }),
          ),
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

      await expect(
        repository.findPublicationForWork(upgraded.groupRef, upgraded.workId),
      ).resolves.toEqual(upgraded);
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
      const claimKey = repository.workIndexKey(upgraded.groupRef, upgraded.workId);
      const publicationKey = repository.publicationKey(upgraded.groupRef, upgraded.publicationId);
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

      await expect(
        migrateLegacyRtcTopologyPublicationKeys(repository, {
          oldWritersStopped: true,
        }),
      ).rejects.toMatchObject({
        code: 'rtc-topology-repository-invariant-corruption',
      });

      await expect(
        runtimeRepository.findEntry(RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE, claimKey),
      ).resolves.toEqual(claimBefore);
      await expect(
        runtimeRepository.findEntry(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, publicationKey),
      ).resolves.toEqual(publicationBefore);
      await expect(
        runtimeRepository.findEntry(
          RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
          legacyPublication.publicationId,
        ),
      ).resolves.toBeDefined();
      await expect(
        runtimeRepository.findEntry(
          RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
          legacyPublication.workId,
        ),
      ).resolves.toBeDefined();
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

    await expect(
      migrateLegacyRtcTopologyPublicationKeys(repository, {
        oldWritersStopped: true,
      }),
    ).rejects.toMatchObject({
      code: 'rtc-topology-repository-invariant-corruption',
    });
    expect(
      await runtimeRepository.findEntry(
        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
        legacyPublication.publicationId,
      ),
    ).toBeDefined();
  });
});
