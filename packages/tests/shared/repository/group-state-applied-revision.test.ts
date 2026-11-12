import {
    describe,
    expect,
    it
} from 'vitest';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import { toGroupStateAppliedRevision } from '@shared/repository/group-state-applied-revision.ts';
import type { GroupStateSnapshotChange } from '@shared/repository/group-state-snapshots-repository.ts';

import { createGroupSnapshot } from '../../shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';

interface ChangedSnapshots {
    readonly snapshot?: GroupSnapshot;
    readonly previous?: GroupSnapshot;
}

function toChange(kind: ObservableValueEventType, snapshots: ChangedSnapshots): GroupStateSnapshotChange {
    const named = snapshots.snapshot ?? snapshots.previous!;
    return {
        kind,
        groupRef: named.group,
        snapshot: snapshots.snapshot,
        previous: snapshots.previous,
        version: named.group.snapshotVersion
    };
}

function toGroupRef(snapshot: GroupSnapshot) {
    const { applicationId, workspaceId, groupId } = snapshot.group;
    return { applicationId, workspaceId, groupId };
}

describe('the applied group revision a runtime states', () => {
    it('states the held revision of a created and an advanced snapshot', () => {
        const created = createGroupSnapshot(4, ['session-a']);
        const advanced = createGroupSnapshot(5, ['session-a', 'session-b']);

        expect(toGroupStateAppliedRevision(toChange(ObservableValueEventType.Created, { snapshot: created }))).toEqual({
            group: toGroupRef(created),
            groupRevision: 4,
            presenceRevision: 1,
            rosterVersion: 1,
            activeSessionCount: 1,
            change: 'held'
        });
        expect(
            toGroupStateAppliedRevision(
                toChange(ObservableValueEventType.Updated, { snapshot: advanced, previous: created })
            )
        ).toEqual({
            group: toGroupRef(advanced),
            groupRevision: 5,
            presenceRevision: 2,
            rosterVersion: 1,
            activeSessionCount: 2,
            change: 'held'
        });
    });

    it('states nothing for a refreshed lease', () => {
        const held = createGroupSnapshot(4, ['session-a']);

        expect(
            toGroupStateAppliedRevision(toChange(ObservableValueEventType.Refreshed, { snapshot: held, previous: held }))
        ).toBeUndefined();
    });

    it('states a removal', () => {
        const removed = createGroupSnapshot(6, ['session-a', 'session-b']);

        expect(toGroupStateAppliedRevision(toChange(ObservableValueEventType.Deleted, { previous: removed }))).toEqual({
            group: toGroupRef(removed),
            groupRevision: 6,
            presenceRevision: 2,
            rosterVersion: 1,
            activeSessionCount: 2,
            change: 'removed'
        });
    });

    it('states nothing for a replacement at an equal tuple', () => {
        const held = createGroupSnapshot(4, ['session-a']);
        const renewed: GroupSnapshot = {
            ...held,
            activeSessions: held.activeSessions.map((session) => ({
                ...session,
                lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs + 10_000,
                expiresAtEpochMs: session.expiresAtEpochMs + 10_000
            }))
        };

        expect(
            toGroupStateAppliedRevision(toChange(ObservableValueEventType.Updated, { snapshot: renewed, previous: held }))
        ).toBeUndefined();
    });
});
