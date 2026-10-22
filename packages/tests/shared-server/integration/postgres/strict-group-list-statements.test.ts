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
import type { RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { AuditStamp, GroupMember, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { createTestGroup } from '../../../create-test-group.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
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
    /** Writes on its own connection handle, outside the recorded statements. */
    readonly writer: GroupStateRepository;
    readonly runtime: RoundHoldingRuntimeStateRepository;
    readonly groups: CachedGroupStateService;
    readonly log: PostgresStatementLog;
}

/** Runtime-state reads that can hold a list's second member selection until its snapshot read has answered. */
class RoundHoldingRuntimeStateRepository extends PSqlRuntimeStateRepository {
    private memberSelections = 0;
    private beforeSecondMemberSelection: (() => Promise<void>) | undefined;
    private settleSnapshotRead: (() => void) | undefined;

    holdSecondMemberSelection(write: () => Promise<void>): void {
        const snapshotRead = new Promise<void>((resolve) => {
            this.settleSnapshotRead = resolve;
        });
        this.memberSelections = 0;
        this.beforeSecondMemberSelection = async () => {
            await snapshotRead;
            await write();
        };
    }

    override async readRuntimeStateBatch(selectors: readonly RuntimeStateReadBatchSelector[]) {
        if (selectors[0]?.kind === 'prefix-suffix') {
            this.memberSelections += 1;
            const beforeSecondMemberSelection = this.beforeSecondMemberSelection;
            if (this.memberSelections === 2 && beforeSecondMemberSelection !== undefined) {
                this.beforeSecondMemberSelection = undefined;
                await beforeSecondMemberSelection();
            }
        }
        return await super.readRuntimeStateBatch(selectors);
    }

    override async readRuntimeStateBatchVersions(selectorGroups: readonly (readonly RuntimeStateReadBatchSelector[])[]) {
        const versions = await super.readRuntimeStateBatchVersions(selectorGroups);
        this.settleSnapshotRead?.();
        return versions;
    }

    override async readRuntimeStateBatchWithVersion(selectors: readonly RuntimeStateReadBatchSelector[]) {
        const batch = await super.readRuntimeStateBatchWithVersion(selectors);
        this.settleSnapshotRead?.();
        return batch;
    }
}

describe('Postgres strict group list statements', () => {
    postgresIt(
        'lists kept and purged groups in three statements, a changed, joined or removed one in four, and re-reads a group written between the rounds',
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
                    expect(await listCounted(runtime, scope)).toEqual({ statements: 3, groupIds: ['room-a', 'room-b', 'room-bob'] });

                    const changed = await runtime.repository.findGroup(ref('room-a'));
                    runtime.runtime.holdSecondMemberSelection(async () => {
                        await runtime.writer.putGroup({ ...changed!, displayName: 'changed', snapshotVersion: changed!.snapshotVersion + 1 });
                    });
                    expect(await listCounted(runtime, scope)).toEqual({ statements: 4, groupIds: ['room-a', 'room-b', 'room-bob'] });

                    const listed = readable(await runtime.groups.listSnapshotsForPrincipal(scope, 'alice'));
                    expect(listed).toEqual(readable(await runtime.groups.listSnapshots(scope)));
                    expect(listed.map((snapshot) => snapshot.group.displayName)).toEqual(['changed', 'renamed', 'room-bob']);
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
    const runtimeRepository = new RoundHoldingRuntimeStateRepository(recordPostgresStatements(sql, log, null));
    const groupStateEventStore = new PSqlGroupStateEventRepository(sql);
    const repository = new GroupStateRepository(runtimeRepository, groupStateEventStore);
    const writer = new GroupStateRepository(new PSqlRuntimeStateRepository(sql), groupStateEventStore);
    const current = new GroupStateCurrentSnapshotCache({
        repository,
        versionReader: runtimeRepository,
        nowEpochMs: () => Date.now(),
        maxEntries: 16
    });
    const durable = createGroupStateService({
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
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
    return { repository, writer, runtime: runtimeRepository, groups, log };
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
