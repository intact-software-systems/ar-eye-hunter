import { describe, expect, it, vi } from 'vitest';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    RTC_RTT_LATEST_NAMESPACE,
    RtcRttRepository,
} from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
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
