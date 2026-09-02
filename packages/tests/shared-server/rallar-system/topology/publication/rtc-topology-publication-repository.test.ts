// dprint-ignore
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import {
    createRtcTopologyExecutionReceipt,
    hashRtcTopologyExecutionCommand,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE
} from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    corruptTopologyExecutionReceipt,
    createGroupRef,
    createPublication,
    createTopologySnapshot,
    putOrLoadTopologyPublication,
    reorderJsonObjectKeys
} from '../rtc-topology-repository-test-fixtures.ts';

describe('RTC topology publication repository', () => {
    it('persists immutable topology publications and rejects a divergent loaded retry', async () => {
        const repository = new RtcTopologyPublicationRepository(new FakeRuntimeStateRepository());
        const snapshot = createTopologySnapshot(createGroupRef(), 2);
        const publication = createPublication(snapshot, 'work-1');

        expect(await putOrLoadTopologyPublication(repository, publication, snapshot)).toEqual({
            publication,
            inserted: true
        });
        const retrySnapshot = {
            ...snapshot,
            activeSessionIds: ['session-b'],
            nextHopsBySessionId: { 'session-b': [] }
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
                            resource: JSON.stringify(retrySnapshot)
                        }
                    }
                },
                snapshot
            )
        ).rejects.toMatchObject({
            code: 'rtc-topology-publication-collision'
        });
    });

    it('loads a semantically equal publication retry with reordered object keys', async () => {
        const repository = new RtcTopologyPublicationRepository(new FakeRuntimeStateRepository());
        const snapshot = createTopologySnapshot(createGroupRef(), 2);
        const publication = createPublication(snapshot, 'work-reordered-load');

        await expect(
            putOrLoadTopologyPublication(repository, publication, snapshot)
        ).resolves.toMatchObject({
            inserted: true
        });
        await expect(
            putOrLoadTopologyPublication(repository, reorderJsonObjectKeys(publication), snapshot)
        ).resolves.toEqual({ publication, inserted: false });
    });

    it('claims an immutable publication with its snapshot guard', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const publication = createPublication(snapshot, 'work-snapshot-guard');

        await expect(putOrLoadTopologyPublication(repository, publication, snapshot)).resolves.toEqual({
            publication,
            inserted: true
        });
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
                    traceId: 'trace-1'
                },
                targets: {
                    mode: 'broadcast' as const,
                    scope: 'room' as const,
                    groupRef: snapshot.groupRef,
                    minSnapshotVersion: 1,
                    exceptPeerIds: ['session-z']
                },
                forwarding: {
                    nextHopPeerIds: ['session-b'],
                    overlayId: 'overlay-1',
                    fanoutLimit: 2
                },
                constraints: { ttlHops: 4, expiresAtMs: 1_000 },
                ordering: { orderingKey: 'room-1', epoch: 1, seq: 2 },
                delivery: {
                    reliability: 'best-effort' as const,
                    ack: 'none' as const,
                    ownership: 'shared' as const
                },
                actions: { corrId: 'corr-1', replyToMsgId: 'reply-1' },
                qos: {
                    dedup: {
                        algo: 'semantic-key' as const,
                        opts: {
                            windowMs: 1_000,
                            semanticKey: 'topology:room-1'
                        }
                    },
                    expiry: {
                        algo: 'expires-at' as const,
                        opts: { expiresAtMs: 1_000 }
                    }
                },
                diagnostics: { visitedPeerIds: ['session-a'] },
                audit: { createdBy: 'rallar-server', createdTs: 10 }
            }
        } satisfies RtcTopologyPublication;

        await expect(
            putOrLoadTopologyPublication(repository, publication, snapshot)
        ).resolves.toMatchObject({
            inserted: true,
            publication
        });
    });

    it('lets exactly one immutable publication claim a work id under concurrency', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const first = createPublication(createTopologySnapshot(createGroupRef(), 1), 'work-race');
        const secondSnapshot = {
            ...JSON.parse(first.message.payload.resource),
            activeSessionIds: ['session-b'],
            nextHopsBySessionId: { 'session-b': [] }
        };
        const second = {
            ...first,
            recipientSessionIds: ['session-b'],
            message: {
                ...first.message,
                payload: {
                    ...first.message.payload,
                    resource: JSON.stringify(secondSnapshot)
                }
            }
        };
        let waiting = 0;
        const together = Promise.withResolvers<void>();
        runtimeRepository.beforeUpsert = async (namespace) => {
            if (namespace !== RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE) {
                return;
            }
            waiting += 1;
            if (waiting === 2) {
                together.resolve();
            }
            await together.promise;
        };
        const seeded = await new RtcTopologySnapshotRepository(runtimeRepository).commitSnapshotGuard(
            createTopologySnapshot(createGroupRef(), 1),
            null
        );
        if (seeded.status !== 'accepted') {
            throw new Error('Expected topology race snapshot seed');
        }

        const results = await Promise.allSettled([
            putOrLoadTopologyPublication(repository, first, createTopologySnapshot(createGroupRef(), 1)),
            putOrLoadTopologyPublication(repository, second, createTopologySnapshot(createGroupRef(), 1))
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({
            reason: { code: 'rtc-topology-publication-collision' }
        });
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
                    publicationId: 'wrong-publication'
                }),
                9_000
            );
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                workKey,
                JSON.stringify({
                    groupRef,
                    workId: 'wrong-work',
                    publicationId: publication.publicationId
                }),
                9_000
            );

            await expect(
                repository.findPublication(groupRef, publication.publicationId)
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            await expect(repository.listPublicationEntries()).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            await expect(repository.listPublicationEntriesPage({ limit: 10 })).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            await expect(
                repository.findWorkClaimEntry(groupRef, publication.workId)
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            await expect(repository.listWorkClaimEntries()).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            await expect(repository.listWorkClaimEntriesPage({ limit: 10 })).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            expect(
                await runtimeRepository.findEntry(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, publicationKey)
            ).toBeDefined();
            expect(
                await runtimeRepository.findEntry(RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE, workKey)
            ).toBeDefined();
        }
        finally {
            vi.useRealTimers();
        }
    });

    it.each(
        [
            'identity-only',
            'missing',
            'extra',
            'hash',
            'attempt',
            'causal',
            'storage',
            'event',
            'outbox'
        ] as const
    )(
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
                acceptedStorageRevision: guard.storageRevision
            });
            const corrupted = corruptTopologyExecutionReceipt(receipt, defect);
            const expireAtTimestamp = Date.now() + 60_000;
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                publications.publicationKey(publication.groupRef, publication.publicationId),
                JSON.stringify(publication),
                expireAtTimestamp
            );
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                publications.workIndexKey(publication.groupRef, publication.workId),
                JSON.stringify(corrupted),
                expireAtTimestamp
            );
            const snapshotWrites = vi.spyOn(runtimeRepository, 'upsertIfRevision');
            const inserts = vi.spyOn(runtimeRepository, 'insertIfAbsent');

            await expect(
                new RtcTopologyExecutionRepository(runtimeRepository).readTopologyMutation(
                    publication.groupRef,
                    publication.workId
                )
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            expect(snapshotWrites).not.toHaveBeenCalled();
            expect(inserts).not.toHaveBeenCalled();
        }
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
                    const publication = createPublication(
                        createTopologySnapshot(groupRef, 1),
                        `work-envelope-${defect}-${surface}`
                    );
                    const malformedPublication = omitPublicationMessageField(
                        publication,
                        defect
                    );
                    const key = repository.publicationKey(groupRef, publication.publicationId);
                    await runtimeRepository.upsert(
                        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                        key,
                        JSON.stringify(malformedPublication),
                        9_000
                    );

                    const read = surface === 'direct'
                        ? repository.findPublication(groupRef, publication.publicationId)
                        : surface === 'list'
                        ? repository.listPublicationEntries()
                        : repository.listPublicationEntriesPage({
                            limit: 10
                        });
                    await expect(read).rejects.toMatchObject({
                        code: 'rtc-topology-repository-invariant-corruption'
                    });
                    expect(
                        await runtimeRepository.findEntry(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, key)
                    ).toBeDefined();
                }
            }
        }
        finally {
            vi.useRealTimers();
        }
    });
});

function omitPublicationMessageField(
    publication: RtcTopologyPublication,
    defect: 'id' | 'route' | 'typeId'
) {
    if (defect === 'typeId') {
        const { typeId: _typeId, ...payload } = publication.message.payload;
        return {
            ...publication,
            message: { ...publication.message, payload }
        };
    }
    if (defect === 'id') {
        const { id: _id, ...message } = publication.message;
        return { ...publication, message };
    }
    const { route: _route, ...message } = publication.message;
    return { ...publication, message };
}
