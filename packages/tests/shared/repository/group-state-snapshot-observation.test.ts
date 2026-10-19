import {
    describe,
    expect,
    it
} from 'vitest';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    configureGroupStateSnapshotRepository,
    findGroupStateSnapshotByRef,
    observeGroupStateSnapshot,
    onGroupStateSnapshotChange,
    replaceGroupStateSnapshotIfUnchanged,
    waitForGroupStateSnapshotChangesIdle
} from '@shared/repository/group-state-snapshots-repository.ts';

import { createGroupSnapshot } from '../../shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';

describe('group snapshot observation', () => {
    it.each(
        [
            ['group revision', 2, 0, 1],
            ['group revision with larger metadata', 2, 0, 1_024],
            ['presence revision', 1, 1, 1],
            ['presence revision with larger metadata', 1, 1, 1_024]
        ] as const
    )('classifies an advanced %s without traversing metadata', async (_name, groupRevision, presenceRevision, metadataEntries) => {
        const manager = new RepositoryManager();
        configureGroupStateSnapshotRepository({ ttlMs: 60_000 }, manager);
        let metadataReads = 0;
        const current = createGroupSnapshot(1, []);
        const incoming: GroupSnapshot = {
            ...current,
            causalRevision: { groupRevision, presenceRevision },
            group: {
                ...current.group,
                snapshotVersion: groupRevision,
                presenceVersion: presenceRevision,
                metadata: {
                    payload: Array.from({ length: metadataEntries }, () => ({
                        get value() {
                            metadataReads += 1;
                            return 'content';
                        }
                    }))
                }
            }
        };
        const events: string[] = [];
        const unsubscribe = onGroupStateSnapshotChange((change) => {
            events.push(change.kind);
        }, manager);

        try {
            expect(observeGroupStateSnapshot(current, manager)).toBe('inserted');
            expect(observeGroupStateSnapshot(incoming, manager)).toBe('advanced');
            await waitForGroupStateSnapshotChangesIdle(manager);

            expect(events).toEqual(['created', 'updated']);
            expect(findGroupStateSnapshotByRef(current.group, manager)).toBe(incoming);
            // Revision inequality makes event classification independent of metadata size.
            expect(metadataReads).toBe(0);
        }
        finally {
            unsubscribe();
            await manager.clear();
        }
    });

    it('keeps content-sensitive replacement events at the same causal tuple', async () => {
        const manager = new RepositoryManager();
        configureGroupStateSnapshotRepository({ ttlMs: 60_000 }, manager);
        const current = createGroupSnapshot(1, ['session-a']);
        const equal: GroupSnapshot = structuredClone(current);
        const renewed: GroupSnapshot = {
            ...equal,
            activeSessions: equal.activeSessions.map((session) => ({
                ...session,
                lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs + 1,
                expiresAtEpochMs: session.expiresAtEpochMs + 1
            }))
        };
        const events: string[] = [];
        const unsubscribe = onGroupStateSnapshotChange((change) => {
            events.push(change.kind);
        }, manager);

        try {
            expect(observeGroupStateSnapshot(current, manager)).toBe('inserted');
            expect(replaceGroupStateSnapshotIfUnchanged(current, current, manager)).toBe(true);
            expect(replaceGroupStateSnapshotIfUnchanged(current, equal, manager)).toBe(true);
            expect(replaceGroupStateSnapshotIfUnchanged(equal, renewed, manager)).toBe(true);
            expect(replaceGroupStateSnapshotIfUnchanged(current, equal, manager)).toBe(false);
            await waitForGroupStateSnapshotChangesIdle(manager);

            expect(events).toEqual(['created', 'refreshed', 'refreshed', 'updated']);
            expect(findGroupStateSnapshotByRef(current.group, manager)).toBe(renewed);
        }
        finally {
            unsubscribe();
            await manager.clear();
        }
    });
});
