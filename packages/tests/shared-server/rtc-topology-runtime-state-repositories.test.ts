import { describe, expect, it, vi } from 'vitest';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    RTC_RTT_LATEST_NAMESPACE,
    RtcRttRepository,
} from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRevisionConflictError,
    RtcTopologySnapshotRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import {
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
    RtcTopologyExecutionRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import type { ALMessage } from '@shared/mod.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('RTC topology runtime-state repositories', () => {
    it('stores topology snapshots behind a scoped locked key', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcTopologySnapshotRepository(runtimeRepository);
        const groupRef = createGroupRef();
        const snapshot = createTopologySnapshot(groupRef, 3);

        await repository.withSnapshotLock(groupRef, async (lockedRepository) => {
            await lockedRepository.putSnapshot(snapshot);
        });

        expect(await repository.findSnapshot(groupRef)).toEqual(snapshot);
        expect(runtimeRepository.locks).toEqual([
            {
                namespace: RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                key: repository.snapshotKey(groupRef),
            },
        ]);
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

    it('persists immutable topology publications and reuses the first retry result', async () => {
        const repository = new RtcTopologyPublicationRepository(
            new FakeRuntimeStateRepository(),
        );
        const publication = {
            publicationId: 'publication-1',
            workId: 'work-1',
            groupRef: createGroupRef(),
            sourceGroupStateRevision: 3,
            overlayVersion: 2,
            recipientSessionIds: ['session-a'],
            message: { id: 'message-1' } as unknown as ALMessage,
            createdAtEpochMs: Date.now(),
        };

        expect(await repository.putOrLoad(publication)).toEqual({
            publication,
            inserted: true,
        });
        expect(await repository.putOrLoad({
            ...publication,
            recipientSessionIds: ['session-b'],
        })).toEqual({
            publication,
            inserted: false,
        });
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
        runtimeRepository.beforeUpsert = (namespace) => {
            if (namespace === RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE) {
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
            expect(runtimeRepository.locks.map((lock) => lock.namespace))
                .toEqual([
                    RTC_RTT_LATEST_NAMESPACE,
                    RTC_RTT_LATEST_NAMESPACE,
                    RTC_RTT_LATEST_NAMESPACE,
                ]);

            now = 1_051;
            vi.setSystemTime(now);
            expect(await repository.findMeasurement('session-a', 'session-b'))
                .toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });
});

function createGroupRef(): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
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
        message: { id: `message-${workId}` } as unknown as ALMessage,
        createdAtEpochMs: 10,
    };
}
