import {
    describe,
    expect,
    it
} from 'vitest';

import { toCanonicalGroupRef, type GroupSnapshot } from '@shared/api/group-types.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import { toGroupStateAppliedRevision } from '@shared/repository/group-state-applied-revision.ts';
import type { GroupStateSnapshotChange } from '@shared/repository/group-state-snapshots-repository.ts';

import { createGroupSnapshot } from '../../shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';

interface ChangedSnapshots {
    readonly named: GroupSnapshot;
    readonly snapshot?: GroupSnapshot;
    readonly previous?: GroupSnapshot;
}

function toChange(kind: ObservableValueEventType, snapshots: ChangedSnapshots): GroupStateSnapshotChange {
    return {
        kind,
        groupRef: snapshots.named.group,
        snapshot: snapshots.snapshot,
        previous: snapshots.previous,
        version: snapshots.named.group.snapshotVersion
    };
}

function withSessionLease(snapshot: GroupSnapshot, addedMs: number): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({
            ...session,
            lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs + addedMs,
            expiresAtEpochMs: session.expiresAtEpochMs + addedMs
        }))
    };
}

describe('the applied group revision a runtime states', () => {
    it('states the held revision of a created and an advanced snapshot', () => {
        const created = createGroupSnapshot(4, ['session-a']);
        const advanced = createGroupSnapshot(5, ['session-a', 'session-b']);

        expect(toGroupStateAppliedRevision(toChange(ObservableValueEventType.Created, { named: created, snapshot: created }))).toEqual({
            group: toCanonicalGroupRef(created.group),
            groupRevision: 4,
            presenceRevision: 1,
            rosterVersion: 1,
            activeSessionCount: 1,
            change: 'held'
        });
        expect(
            toGroupStateAppliedRevision(
                toChange(ObservableValueEventType.Updated, { named: advanced, snapshot: advanced, previous: created })
            )
        ).toEqual({
            group: toCanonicalGroupRef(advanced.group),
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
            toGroupStateAppliedRevision(toChange(ObservableValueEventType.Refreshed, { named: held, snapshot: held, previous: held }))
        ).toBeUndefined();
    });

    it('states a removal', () => {
        const removed = createGroupSnapshot(6, ['session-a', 'session-b']);

        expect(toGroupStateAppliedRevision(toChange(ObservableValueEventType.Deleted, { named: removed, previous: removed }))).toEqual({
            group: toCanonicalGroupRef(removed.group),
            groupRevision: 6,
            presenceRevision: 2,
            rosterVersion: 1,
            activeSessionCount: 2,
            change: 'removed'
        });
    });

    it('states nothing for a replacement at an equal tuple', () => {
        const held = createGroupSnapshot(4, ['session-a']);
        const renewed = withSessionLease(held, 10_000);

        expect(
            toGroupStateAppliedRevision(toChange(ObservableValueEventType.Updated, { named: renewed, snapshot: renewed, previous: held }))
        ).toBeUndefined();
    });

    it('states a session restored at an equal tuple', () => {
        const restored = withSessionLease(createGroupSnapshot(4, ['session-a', 'session-b']), 10_000);
        const reduced: GroupSnapshot = { ...restored, activeSessions: restored.activeSessions.slice(0, 1) };

        expect(
            toGroupStateAppliedRevision(
                toChange(ObservableValueEventType.Updated, { named: restored, snapshot: restored, previous: reduced })
            )
        ).toEqual({
            group: toCanonicalGroupRef(restored.group),
            groupRevision: 4,
            presenceRevision: 2,
            rosterVersion: 1,
            activeSessionCount: 2,
            change: 'held'
        });
    });
});
