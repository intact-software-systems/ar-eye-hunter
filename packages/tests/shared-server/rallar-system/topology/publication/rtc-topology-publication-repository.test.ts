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
import type { GroupRef } from '@shared/api/group-types.ts';
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
    it('validates publication and work claim rows, direct and by room page, before expiry', async () => {
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
                {
                    namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    key: publicationKey,
                    value: JSON.stringify({
                        ...publication,
                        publicationId: 'wrong-publication'
                    }),
                    expireAtTimestamp: 9_000
                }
            );
            await runtimeRepository.upsert(
                {
                    namespace: RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    key: workKey,
                    value: JSON.stringify({
                        groupRef,
                        workId: 'wrong-work',
                        publicationId: publication.publicationId
                    }),
                    expireAtTimestamp: 9_000
                }
            );

            await expect(
                repository.findPublication(groupRef, publication.publicationId)
            ).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            await expect(repository.listGroupPublicationEntriesPage(groupRef, { limit: 10 })).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption'
            });
            await expect(
                repository.findWorkClaimEntry(groupRef, publication.workId)
            ).rejects.toMatchObject({
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
                {
                    namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    key: publications.publicationKey(publication.groupRef, publication.publicationId),
                    value: JSON.stringify(publication),
                    expireAtTimestamp
                }
            );
            await runtimeRepository.upsert(
                {
                    namespace: RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    key: publications.workIndexKey(publication.groupRef, publication.workId),
                    value: JSON.stringify(corrupted),
                    expireAtTimestamp
                }
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
            const defects = ['snapshot', 'expiresAtEpochMs', 'workId', 'traceId'] as const;
            const surfaces = ['direct', 'page'] as const;
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
                        { namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, key, value: JSON.stringify(malformedPublication), expireAtTimestamp: 9_000 }
                    );

                    const read = surface === 'direct'
                        ? repository.findPublication(groupRef, publication.publicationId)
                        : repository.listGroupPublicationEntriesPage(groupRef, { limit: 10 });
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

    it.each(['direct', 'page'] as const)(
        'keeps a malformed v4 publication trace as corruption on the %s surface',
        async (surface) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new RtcTopologyPublicationRepository(runtimeRepository);
            const groupRef = createGroupRef();
            const publication = createPublication(createTopologySnapshot(groupRef, 1), `work-bad-trace-${surface}`);
            await runtimeRepository.upsert(
                {
                    namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    key: repository.publicationKey(groupRef, publication.publicationId),
                    value: JSON.stringify({ ...publication, traceId: 'not a trace' }),
                    expireAtTimestamp: Date.now() + 60_000
                }
            );

            const read = surface === 'direct'
                ? repository.findPublication(groupRef, publication.publicationId)
                : repository.listGroupPublicationEntriesPage(groupRef, { limit: 10 });
            await expect(read).rejects.toMatchObject({ code: 'rtc-topology-repository-invariant-corruption' });
        }
    );

    it('lists only the room\'s own publications, never a room whose id extends it', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const groupRef = createGroupRef();
        const extendingRef = { ...groupRef, groupId: `${groupRef.groupId}:publication=x` };
        const siblingRef = { ...groupRef, groupId: `${groupRef.groupId}-2` };
        for (const [ref, workId] of [[groupRef, 'work-own'], [extendingRef, 'work-extending'], [siblingRef, 'work-sibling']] as const) {
            const publication = createPublication(createTopologySnapshot(ref, 1), workId);
            await runtimeRepository.upsert({
                namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                key: repository.publicationKey(ref, publication.publicationId),
                value: JSON.stringify(publication),
                expireAtTimestamp: Date.now() + 60_000
            });
        }

        const entries = await repository.listGroupPublicationEntriesPage(groupRef, { limit: 10 });

        expect(entries.map((entry) => entry.value.workId)).toEqual(['work-own']);
    });

    it('walks past expired rows to the live ones, naming each live publication once', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const groupRef = createGroupRef();
        await storePublicationsInKeyOrder(runtimeRepository, repository, groupRef, [
            ['work-1', 'live'],
            ['work-2', 'expired'],
            ['work-3', 'expired'],
            ['work-4', 'live'],
            ['work-5', 'live']
        ]);

        const first = await repository.listGroupPublicationEntriesPage(groupRef, { limit: 2 });
        const second = await repository.listGroupPublicationEntriesPage(groupRef, {
            limit: 2,
            afterKey: repository.publicationKey(groupRef, first[1]!.value.publicationId)
        });

        expect(first.map((entry) => entry.value.workId)).toEqual(['work-1', 'work-4']);
        expect(second.map((entry) => entry.value.workId)).toEqual(['work-5']);
    });

    it('lists nothing from a room whose publications are all expired, and from a trailing run of expired ones', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const groupRef = createGroupRef();
        await storePublicationsInKeyOrder(runtimeRepository, repository, groupRef, [
            ['work-1', 'expired'],
            ['work-2', 'expired'],
            ['work-3', 'expired']
        ]);
        expect(await repository.listGroupPublicationEntriesPage(groupRef, { limit: 2 })).toEqual([]);

        const trailing = { ...groupRef, groupId: 'room-trailing' };
        await storePublicationsInKeyOrder(runtimeRepository, repository, trailing, [
            ['work-1', 'live'],
            ['work-2', 'expired'],
            ['work-3', 'expired']
        ]);
        const entries = await repository.listGroupPublicationEntriesPage(trailing, { limit: 2 });
        expect(entries.map((entry) => entry.value.workId)).toEqual(['work-1']);
    });

    it('an expired publication is not listed', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtimeRepository);
        const groupRef = createGroupRef();
        for (const [workId, expireAtTimestamp] of [['work-live', Date.now() + 60_000], ['work-expired', Date.now() - 1]] as const) {
            const publication = createPublication(createTopologySnapshot(groupRef, 1), workId);
            await runtimeRepository.upsert({
                namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                key: repository.publicationKey(groupRef, publication.publicationId),
                value: JSON.stringify(publication),
                expireAtTimestamp
            });
        }

        const entries = await repository.listGroupPublicationEntriesPage(groupRef, { limit: 10 });

        expect(entries.map((entry) => entry.value.workId)).toEqual(['work-live']);
    });
});

async function storePublicationsInKeyOrder(
    runtimeRepository: FakeRuntimeStateRepository,
    repository: RtcTopologyPublicationRepository,
    groupRef: GroupRef,
    rows: readonly (readonly [workId: string, liveness: 'live' | 'expired'])[]
): Promise<void> {
    for (const [workId, liveness] of rows) {
        const publication = createPublication(createTopologySnapshot(groupRef, 1), workId);
        await runtimeRepository.upsert({
            namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            key: repository.publicationKey(groupRef, publication.publicationId),
            value: JSON.stringify(publication),
            expireAtTimestamp: liveness === 'live' ? Date.now() + 60_000 : Date.now() - 1
        });
    }
}

function omitPublicationField(publication: RtcTopologyPublication, defect: 'snapshot' | 'expiresAtEpochMs' | 'workId' | 'traceId') {
    return Object.fromEntries(Object.entries(publication).filter(([key]) => key !== defect));
}
