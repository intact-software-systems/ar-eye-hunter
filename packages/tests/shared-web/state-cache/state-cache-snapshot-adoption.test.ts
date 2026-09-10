import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { GroupStateSnapshotIncomparableError } from '@shared/repository/group-state-snapshots-repository.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';

import {
    acceptAuthoritativeGroupStateSnapshot,
    acceptGroupStateSnapshotsOrRecompute
} from '@shared-web/browser/state-cache/state-cache-snapshot-adoption.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const repository = vi.hoisted(() => ({
    findGroupStateSnapshotByRef: vi.fn<
        typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef
    >(),
    replaceGroupStateSnapshotIfUnchanged: vi.fn<
        typeof GroupStateSnapshotsRepositoryModule.replaceGroupStateSnapshotIfUnchanged
    >(),
    setGroupStateSnapshots: vi.fn<
        typeof GroupStateSnapshotsRepositoryModule.setGroupStateSnapshots
    >()
}));

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    async (importOriginal) => ({
        ...await importOriginal(),
        findGroupStateSnapshotByRef: repository.findGroupStateSnapshotByRef,
        replaceGroupStateSnapshotIfUnchanged: repository.replaceGroupStateSnapshotIfUnchanged,
        setGroupStateSnapshots: repository.setGroupStateSnapshots
    })
);

const scope = { applicationId: 'app', workspaceId: 'workspace' };
const snapshot = createGroupSnapshotFixture({
    ...scope,
    groupId: 'room',
    sessionIds: ['session']
});

describe('browser state-cache snapshot adoption', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        repository.findGroupStateSnapshotByRef.mockReturnValue(snapshot);
        repository.replaceGroupStateSnapshotIfUnchanged.mockReturnValue(true);
    });

    it('checks lifecycle ownership again before conflict replacement', async () => {
        let replacedAfterAbort = false;
        repository.setGroupStateSnapshots.mockImplementation(() => {
            throw new StateSnapshotRevisionConflictError(
                'Group',
                snapshot.group.snapshotVersion
            );
        });
        repository.replaceGroupStateSnapshotIfUnchanged.mockImplementation(() => {
            replacedAfterAbort = true;
            return true;
        });
        const assertCanMutate = failAfterFirstMutationBoundary();

        await expect(acceptAuthoritativeGroupStateSnapshot(snapshot, scope, {
            assertCanMutate
        })).rejects.toMatchObject({ name: 'AbortError' });

        expect(replacedAfterAbort).toBe(false);
    });

    it('checks lifecycle ownership after fallback reread and before reconciliation', async () => {
        const writes: string[] = [];
        repository.setGroupStateSnapshots.mockImplementation(() => {
            writes.push('group-cache');
            throw new GroupStateSnapshotIncomparableError(snapshot.group);
        });
        const assertCanMutate = failAfterFirstMutationBoundary();

        await expect(acceptGroupStateSnapshotsOrRecompute([snapshot], scope, {
            assertCanMutate,
            rereadGroupSnapshots: async () => [snapshot]
        })).rejects.toMatchObject({ name: 'AbortError' });

        expect(writes).toEqual(['group-cache']);
    });
});

function failAfterFirstMutationBoundary() {
    let mutationBoundaryCount = 0;
    return () => {
        mutationBoundaryCount += 1;
        if (mutationBoundaryCount > 1) {
            throw new DOMException('RTC snapshot refresh was disposed', 'AbortError');
        }
    };
}
