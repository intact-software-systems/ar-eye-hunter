import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import {
    computeRtcTopologyExecutionCommandDigest,
    createRtcTopologyExecutionReceipt,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE
} from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository.ts';
import { type RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    corruptTopologyExecutionReceipt,
    createGroupRef,
    createPublication,
    createTopologySnapshot
} from '../rtc-topology-repository-test-fixtures.ts';

describe('RTC topology publication repository', () => {
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
                commandHash: computeRtcTopologyExecutionCommandDigest(publication),
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

    it('rejects incomplete persisted topology publications before cleanup on every read surface', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const defects = ['snapshot', 'expiresAtEpochMs', 'workId'] as const;
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
                    const malformedPublication = omitPublicationField(
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

    it('skips a pre-v4 publication row on every listing and reads it as unsupported, never as corruption', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const groupRef = createGroupRef();
        const preV4 = createPublication(createTopologySnapshot(groupRef, 1), 'work-pre-v4');
        const current = createPublication(createTopologySnapshot(groupRef, 2), 'work-v4');
        const { traceId: _traceId, ...preV4Row } = preV4;
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            repository.publicationKey(groupRef, preV4.publicationId),
            JSON.stringify(preV4Row),
            Date.now() + 60_000
        );
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            repository.publicationKey(groupRef, current.publicationId),
            JSON.stringify(current),
            Date.now() + 60_000
        );

        expect((await repository.listPublicationEntries()).map((entry) => entry.value)).toEqual([current]);
        expect((await repository.listPublicationEntriesPage({ limit: 10 })).map((entry) => entry.value)).toEqual([
            current
        ]);
        await expect(repository.readPublication(groupRef, preV4.publicationId)).resolves.toEqual({
            status: 'unsupported',
            message: 'RTC topology publication predates AL envelope version 4'
        });
        await expect(repository.findPublication(groupRef, preV4.publicationId)).resolves.toBeUndefined();
        await expect(repository.readPublication(groupRef, current.publicationId)).resolves.toEqual({
            status: 'found',
            publication: current
        });
        await expect(repository.readPublication(groupRef, 'work-absent:1:1:1')).resolves.toEqual({ status: 'absent' });
    });

    it.each(['direct', 'read', 'list', 'page'] as const)(
        'keeps a malformed v4 publication trace as corruption on the %s surface',
        async (surface) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologyPublicationRepository(runtimeRepository);
            const groupRef = createGroupRef();
            const publication = createPublication(createTopologySnapshot(groupRef, 1), `work-bad-trace-${surface}`);
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                repository.publicationKey(groupRef, publication.publicationId),
                JSON.stringify({ ...publication, traceId: 'not a trace' }),
                Date.now() + 60_000
            );

            const read = surface === 'direct'
                ? repository.findPublication(groupRef, publication.publicationId)
                : surface === 'read'
                ? repository.readPublication(groupRef, publication.publicationId)
                : surface === 'list'
                ? repository.listPublicationEntries()
                : repository.listPublicationEntriesPage({ limit: 10 });
            await expect(read).rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
        }
    );
});

function omitPublicationField(publication: RtcTopologyPublication, defect: 'snapshot' | 'expiresAtEpochMs' | 'workId') {
    return Object.fromEntries(Object.entries(publication).filter(([key]) => key !== defect));
}
