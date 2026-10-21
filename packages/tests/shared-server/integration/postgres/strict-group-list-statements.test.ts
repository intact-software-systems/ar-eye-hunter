import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
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
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';
import { recordPostgresStatements, type PostgresStatementLog } from './test-support/record-postgres-statements.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

interface StrictListRuntime {
    readonly repository: GroupStateRepository;
    readonly groups: CachedGroupStateService;
    readonly log: PostgresStatementLog;
}

describe('Postgres strict group list statements', () => {
    postgresIt(
        'lists a principal\'s kept groups in three statements and a changed, joined or removed group in four, as the scan and filter list them',
        async () => {
            const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 2);
            const applicationId = `strict-group-list-statements-${crypto.randomUUID()}`;
            const scope: StateScope = { applicationId, workspaceId: 'workspace-1' };
            const ref = (groupId: string): GroupRef => ({ ...scope, groupId });
            try {
                try {
                    const runtime = createStrictListRuntime(sql);
                    for (const groupId of ['room-a', 'room-b', 'room-c']) {
                        await seedGroup(runtime.repository, ref(groupId), ['alice', 'bob']);
                    }
                    await seedGroup(runtime.repository, ref('room-bob'), ['bob']);
                    await listCounted(runtime, scope);

                    expect(await listCounted(runtime, scope)).toEqual({ statements: 3, groupIds: ['room-a', 'room-b', 'room-c'] });

                    const renamed = await runtime.repository.findGroup(ref('room-b'));
                    await runtime.repository.putGroup({ ...renamed!, displayName: 'renamed' });
                    expect(await listCounted(runtime, scope)).toEqual({ statements: 4, groupIds: ['room-a', 'room-b', 'room-c'] });

                    const joined = await runtime.repository.findGroup(ref('room-bob'));
                    await runtime.repository.putMember(createMember(ref('room-bob'), 'alice', false));
                    await runtime.repository.putGroup({ ...joined!, activeMemberCount: 2 });
                    expect(await listCounted(runtime, scope)).toEqual({ statements: 4, groupIds: ['room-a', 'room-b', 'room-bob', 'room-c'] });

                    await runtime.repository.removeGroup(ref('room-c'));
                    expect(await listCounted(runtime, scope)).toEqual({ statements: 4, groupIds: ['room-a', 'room-b', 'room-bob'] });

                    const listed = readable(await runtime.groups.listSnapshotsForPrincipal(scope, 'alice'));
                    expect(listed).toEqual(readable(await runtime.groups.listSnapshots(scope)));
                    expect(listed.find((snapshot) => snapshot.group.groupId === 'room-b')?.group.displayName).toBe('renamed');
                }
                finally {
                    await deletePostgresRunRows(sql, applicationId);
                }
                expect(await readPostgresRunRowCounts(sql, applicationId)).toEqual(NO_POSTGRES_RUN_ROWS);
            }
            finally {
                await sql.end();
            }
        },
        30_000
    );
});

async function listCounted(
    runtime: StrictListRuntime,
    scope: StateScope
): Promise<Readonly<{ statements: number; groupIds: readonly string[]; }>> {
    runtime.log.statements.length = 0;
    const listed = await runtime.groups.listSnapshotsForPrincipal(scope, 'alice');
    return { statements: runtime.log.statements.length, groupIds: listed.map((snapshot) => snapshot.group.groupId) };
}

/** The production strict-list stack, its every statement recorded; the current-snapshot cache keeps what it reads. */
function createStrictListRuntime(sql: PSqlSql): StrictListRuntime {
    const log: PostgresStatementLog = { statements: [], transactions: 0 };
    const runtimeRepository = new PSqlRuntimeStateRepository(recordPostgresStatements(sql, log, null));
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
        serviceId: 'strict-group-list-statements-test',
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
    return { repository, groups, log };
}

/** The first principal owns the group; every principal is an active member. */
async function seedGroup(repository: GroupStateRepository, ref: GroupRef, principalIds: readonly string[]): Promise<void> {
    await repository.putGroup(createTestGroup({
        ...ref,
        displayName: ref.groupId,
        activeMemberCount: principalIds.length,
        ownerPrincipalId: principalIds[0],
        formationElectorate: [principalIds[0]!]
    }));
    for (const [index, principalId] of principalIds.entries()) {
        await repository.putMember(createMember(ref, principalId, index === 0));
    }
}

function createMember(ref: GroupRef, principalId: string, isOwner: boolean): GroupMember {
    const stamp = auditStamp();
    return {
        ...ref,
        principalId,
        role: isOwner ? 'owner' : 'member',
        status: 'active',
        joined: stamp,
        updated: stamp,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    };
}

function auditStamp(): AuditStamp {
    return { atEpochMs: 1, actor: { kind: 'service', serviceId: 'test' }, reason: null, traceId: null, requestId: null };
}

function readable(snapshots: readonly GroupSnapshot[]): readonly GroupSnapshot[] {
    return snapshots.filter((snapshot) => canReadGroupSnapshot({ snapshot, actor: { principalId: 'alice' } }).allowed);
}
