import { describe, expect, it } from 'vitest';

import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { canReadGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import {
    createCachedGroupStateService,
    type CachedGroupStateService
} from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { GroupStateCurrentSnapshotCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-current-snapshot-cache.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { AuditStamp, GroupMember, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { createTestGroup } from '../../../create-test-group.ts';
import { createRuntimeStatePostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';

const POSTGRES_INTEGRATION_ENABLED = process.env.RALLAR_POSTGRES_INTEGRATION === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;

type SeededMember = readonly [principalId: string, status: GroupMember['status']];

interface SeededGroup {
    readonly workspaceId: string;
    readonly groupId: string;
    readonly members: readonly SeededMember[];
    readonly deleted: boolean;
}

/** Owners come first: a stored roster has exactly one active owner. */
const SEEDED_GROUPS: readonly SeededGroup[] = [
    { workspaceId: 'workspace-1', groupId: 'room', members: [['alice', 'active'], ['bob', 'active'], ['carol', 'banned']], deleted: false },
    { workspaceId: 'workspace-1', groupId: 'room-2', members: [['alice', 'active'], ['bob', 'invited']], deleted: false },
    { workspaceId: 'workspace-1', groupId: 'room-bob', members: [['bob', 'active'], ['alice', 'left']], deleted: false },
    { workspaceId: 'workspace-1', groupId: 'room-banned', members: [['bob', 'active'], ['alice', 'banned']], deleted: false },
    { workspaceId: 'workspace-1', groupId: 'room-removed', members: [['bob', 'active'], ['alice', 'removed']], deleted: false },
    { workspaceId: 'workspace-1', groupId: 'room-deleted', members: [['alice', 'active'], ['bob', 'active']], deleted: true },
    { workspaceId: 'workspace-2', groupId: 'room', members: [['alice', 'active']], deleted: false }
];

describe('Postgres strict group list', () => {
    postgresIt('serves each principal the set and order the workspace scan and readability filter serve', async () => {
        const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl(), 2);
        const applicationId = `strict-group-list-${crypto.randomUUID()}`;
        const scope: StateScope = { applicationId, workspaceId: 'workspace-1' };
        try {
            try {
                const service = createStrictListService(sql);
                for (const seeded of SEEDED_GROUPS) {
                    await seedGroup(service.repository, applicationId, seeded);
                }

                const lists = await Promise.all(['alice', 'bob', 'carol'].map(async (principalId) => ({
                    principalId,
                    scanned: readable(await service.groups.listSnapshots(scope), principalId),
                    listed: readable(await service.groups.listSnapshotsForPrincipal(scope, principalId), principalId)
                })));

                expect(lists.map(({ principalId, listed }) => [principalId, toGroupIds(listed)])).toEqual([
                    ['alice', ['room', 'room-2']],
                    ['bob', ['room', 'room-banned', 'room-bob', 'room-removed']],
                    ['carol', []]
                ]);
                for (const { listed, scanned } of lists) {
                    expect(listed).toEqual(scanned);
                }
            }
            finally {
                await deletePostgresRunRows(sql, applicationId);
            }
            expect(await readPostgresRunRowCounts(sql, applicationId)).toEqual(NO_POSTGRES_RUN_ROWS);
        }
        finally {
            await sql.end();
        }
    }, 30_000);
});

function createStrictListService(
    sql: Awaited<ReturnType<typeof createRuntimeStatePostgresSql>>
): Readonly<{ repository: GroupStateRepository; groups: CachedGroupStateService; }> {
    const runtimeRepository = new PSqlRuntimeStateRepository(sql);
    const groupStateEventStore = new PSqlGroupStateEventRepository(sql);
    const repository = new GroupStateRepository(runtimeRepository, groupStateEventStore);
    const current = new GroupStateCurrentSnapshotCache({
        repository,
        versionReader: runtimeRepository,
        nowEpochMs: () => Date.now(),
        maxEntries: 16
    });
    const durable = createGroupStateService({
        runtimeRepository,
        groupStateEventStore,
        serviceId: 'strict-group-list-test',
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null
    });
    const groups = createCachedGroupStateService({
        durable,
        cache: { findOrLoadByRef: (ref) => durable.readSnapshot(ref), observe: () => 'inserted' },
        current,
        principalGroups: {
            listSnapshotsForPrincipal: async (groupScope, principalId) => await repository.listSnapshotsForPrincipal(groupScope, principalId, current)
        }
    });
    return { repository, groups };
}

async function seedGroup(repository: GroupStateRepository, applicationId: string, seeded: SeededGroup): Promise<void> {
    const ref: GroupRef = { applicationId, workspaceId: seeded.workspaceId, groupId: seeded.groupId };
    const activePrincipalIds = seeded.members.flatMap(([principalId, status]) => status === 'active' ? [principalId] : []);
    const ownerPrincipalId = activePrincipalIds[0];
    await repository.putGroup(createTestGroup({
        ...ref,
        displayName: seeded.groupId,
        activeMemberCount: activePrincipalIds.length,
        ownerPrincipalId,
        formationElectorate: [ownerPrincipalId],
        ...(seeded.deleted ? { status: 'deleted', archived: null, deleted: auditStamp() } : {})
    }));
    for (const [principalId, status] of seeded.members) {
        await repository.putMember(createMember(ref, principalId, status, principalId === ownerPrincipalId));
    }
}

function createMember(ref: GroupRef, principalId: string, status: GroupMember['status'], isOwner: boolean): GroupMember {
    const stamp = auditStamp();
    const base = {
        ...ref,
        principalId,
        role: isOwner ? 'owner' : 'member',
        updated: stamp,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    } as const;
    switch (status) {
        case 'invited':
        case 'pending':
            return { ...base, status, joined: null };
        case 'active':
            return { ...base, status, joined: stamp };
        case 'left':
            return { ...base, status, joined: stamp, left: stamp };
        case 'removed':
            return { ...base, status, joined: stamp, removed: stamp };
        case 'banned':
            return { ...base, status, joined: stamp, banned: stamp };
    }
}

function auditStamp(): AuditStamp {
    return { atEpochMs: 1, actor: { kind: 'service', serviceId: 'test' }, reason: null, traceId: null, requestId: null };
}

function readable(snapshots: readonly GroupSnapshot[], principalId: string): readonly GroupSnapshot[] {
    return snapshots.filter((snapshot) => canReadGroupSnapshot({ snapshot, actor: { principalId } }).allowed);
}

function toGroupIds(snapshots: readonly GroupSnapshot[]): readonly string[] {
    return snapshots.map((snapshot) => snapshot.group.groupId);
}

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}
