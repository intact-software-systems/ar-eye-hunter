import { describe, expect, it } from 'vitest';

import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { toGroupStateSnapshotRepositoryKey } from '@shared/repository/group-state-snapshots-repository.ts';

import { createAuthorityHarness, createRoom, SCOPE } from './group-state-inbox-test-runtime.ts';

describe('GroupStateInboxService committed snapshot observation', () => {
    it('makes a committed mutation visible through the configured snapshot cache', async () => {
        const snapshots = new Map<string, GroupSnapshot>();
        const harness = await createAuthorityHarness(['owner'], {
            snapshotCache: {
                findOrLoadByRef: async (ref) => snapshots.get(toGroupStateSnapshotRepositoryKey(ref)),
                observe: (snapshot) => {
                    snapshots.set(toGroupStateSnapshotRepositoryKey(snapshot.group), snapshot);
                    return 'inserted';
                }
            }
        });

        const created = await createRoom(harness, 'cache-observation-room', 'Cache observation room');
        const ref: GroupRef = { ...SCOPE, groupId: 'cache-observation-room' };

        await expect(harness.groupStateService.readSnapshot(ref)).resolves.toEqual(
            created.result.snapshot
        );
    });
});
