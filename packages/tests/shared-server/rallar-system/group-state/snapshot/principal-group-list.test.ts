import { describe, expect, it } from 'vitest';

import type { GroupStatePrincipalSnapshotList } from '@shared-server/rallar-system/group-state/persistence/read-group-state-snapshots-for-principal.ts';
import { createPrincipalGroupList } from '@shared-server/rallar-system/group-state/snapshot/principal-group-list.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { GroupScope, GroupSnapshot } from '@shared/api/group-types.ts';

const SCOPE: GroupScope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('principal group list', () => {
    it('records one list-for-principal line with the statements and member rows the read reports', async () => {
        const events: RallarTimingEvent[] = [];
        const snapshot = { group: { groupId: 'room' } } as GroupSnapshot;
        const list = createPrincipalGroupList({
            repository: { readSnapshotListForPrincipal: async () => toList([snapshot]) },
            currentSnapshots: { readSnapshots: async () => ({ snapshots: [], probes: 0, reads: 0 }) },
            timing: (event) => events.push(event),
            serviceId: 'server-1'
        });

        expect(await list.listSnapshotsForPrincipal(SCOPE, 'alice')).toEqual([snapshot]);
        expect(events).toEqual([expect.objectContaining({
            type: 'rallar.timing',
            component: 'group-state',
            operation: 'list-for-principal',
            status: 'ok',
            serviceId: 'server-1',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: 'alice',
            details: { groups: 1, selectedMembers: 3, statements: 4, fallbackReads: 1 }
        })]);
    });

    it('records nothing with timing off', async () => {
        const reads: string[] = [];
        const list = createPrincipalGroupList({
            repository: {
                readSnapshotListForPrincipal: async (_scope, principalId) => {
                    reads.push(principalId);
                    return toList([]);
                }
            },
            currentSnapshots: { readSnapshots: async () => ({ snapshots: [], probes: 0, reads: 0 }) },
            timing: undefined,
            serviceId: 'server-1'
        });

        expect(await list.listSnapshotsForPrincipal(SCOPE, 'alice')).toEqual([]);
        expect(reads).toEqual(['alice']);
    });
});

function toList(snapshots: readonly GroupSnapshot[]): GroupStatePrincipalSnapshotList {
    return { snapshots, selectedMembers: 3, statements: 4, fallbackReads: 1 };
}
