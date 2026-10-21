import assert from 'node:assert/strict';

import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { canReadGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { GroupStateCurrentSnapshotCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-current-snapshot-cache.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { GroupMember, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';

import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';
import { canonicalAuditStamp, groupFixture } from './pglite-state-mutation-test-runtime.ts';

const REF: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'cached-room' };
const SESSION_EXPIRES_AT_EPOCH_MS = Date.parse('2999-01-01T00:00:00.000Z');

interface SeededCache {
    readonly runtime: AudienceReadRuntime;
    readonly repository: GroupStateRepository;
    readonly cache: GroupStateCurrentSnapshotCache;
    readonly fullReads: () => number;
    readonly takeValueRows: () => number;
    /** Database statements issued since the previous call. */
    readonly takeStatements: () => number;
    readonly setNow: (epochMs: number) => void;
    readonly close: () => Promise<void>;
}

class AudienceReadRuntime extends PSqlRuntimeStateRepository {
    valueRows = 0;
    versionReads = 0;
    versionedValueReads = 0;

    override async readRuntimeStateBatchVersion(selectors: readonly RuntimeStateReadBatchSelector[]) {
        this.versionReads += 1;
        return await super.readRuntimeStateBatchVersion(selectors);
    }

    override async readRuntimeStateBatch(selectors: readonly RuntimeStateReadBatchSelector[]) {
        const selections = await super.readRuntimeStateBatch(selectors);
        this.valueRows += selections.reduce((count, selection) => count + selection.entries.length, 0);
        return selections;
    }

    override async readRuntimeStateBatchWithVersion(selectors: readonly RuntimeStateReadBatchSelector[]) {
        this.versionedValueReads += 1;
        const batch = await super.readRuntimeStateBatchWithVersion(selectors);
        this.valueRows += batch.selections.reduce((count, selection) => count + selection.entries.length, 0);
        return batch;
    }
}

Deno.test('five principal audiences share unchanged group values while retaining durable membership reads', async () => {
    const seeded = await seedCache();
    try {
        const group = await seeded.repository.findGroup(REF);
        assert.ok(group);
        for (let index = 0; index < 49; index += 1) {
            await seeded.repository.putMember(createMember(`member-${index}`, 'member'));
        }
        await seeded.repository.putGroup({ ...group, activeMemberCount: 50 });
        seeded.takeValueRows();

        for (const principalId of ['alice', 'member-0', 'member-1', 'member-2', 'member-3']) {
            const snapshots = await seeded.repository.listSnapshotsForPrincipal(REF, principalId, seeded.cache);
            assert.equal(snapshots.length, 1);
            assert.equal(snapshots[0].members.length, 50);
        }

        assert.ok(seeded.takeValueRows() <= 80, 'unchanged roster values must not transfer again for each principal');
        assert.equal(seeded.fullReads(), 1);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a principal audience observes revoked membership and expired presence despite a warm group cache', async () => {
    const seeded = await seedCache();
    try {
        const group = await seeded.repository.findGroup(REF);
        assert.ok(group);
        await seeded.repository.putMember(createMember('bob', 'member'));
        await seeded.repository.putGroup({ ...group, activeMemberCount: 2 });
        const first = await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', seeded.cache);
        assert.equal(first[0].activeSessions.length, 1);
        seeded.setNow(SESSION_EXPIRES_AT_EPOCH_MS);
        const expired = await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', seeded.cache);
        assert.equal(expired[0].activeSessions.length, 0);
        assert.equal(seeded.fullReads(), 2);

        const member = createMember('alice', 'owner');
        await seeded.repository.putMember({ ...member, status: 'left', left: canonicalAuditStamp(2) });
        await seeded.repository.putGroup({ ...group, activeMemberCount: 1 });
        assert.deepEqual(await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', seeded.cache), []);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a group changed during its cached audience read falls back to current authority', async () => {
    const seeded = await seedCache();
    try {
        const snapshots = await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', {
            readSnapshots: async (refs) => {
                const before = await seeded.cache.readSnapshots(refs);
                const group = before[0]?.group;
                assert.ok(group);
                await seeded.repository.putMember(createMember('bob', 'member'));
                await seeded.repository.putGroup({ ...group, activeMemberCount: 2 });
                return before;
            }
        });

        assert.deepEqual(snapshots[0].members.map((member) => member.principalId), ['alice', 'bob']);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('revocation during a cached audience read is excluded by the second membership selection', async () => {
    const seeded = await seedCache();
    try {
        const snapshots = await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', {
            readSnapshots: async (refs) => {
                const before = await seeded.cache.readSnapshots(refs);
                await seeded.repository.removeMember({ ...REF, principalId: 'alice' });
                return before;
            }
        });

        assert.deepEqual(snapshots, []);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a failed current group read preserves the failure and allows a later fresh read', async () => {
    const seeded = await seedCache();
    try {
        const failure = new Error('version reader unavailable');
        await assert.rejects(
            seeded.repository.listSnapshotsForPrincipal(REF, 'alice', {
                readSnapshots: () => Promise.reject(failure)
            }),
            (error) => error === failure
        );
        const snapshots = await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', seeded.cache);
        assert.equal(snapshots[0].group.groupId, REF.groupId);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('principal audience cache entries remain isolated by workspace', async () => {
    const seeded = await seedCache();
    try {
        const other = { ...REF, workspaceId: 'other-workspace' };
        await seeded.repository.putGroup(groupFixture(other, 'Other workspace'));
        await seeded.repository.putMember({ ...createMember('alice', 'owner'), ...other });

        const first = await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', seeded.cache);
        const second = await seeded.repository.listSnapshotsForPrincipal(other, 'alice', seeded.cache);
        assert.equal(first[0].group.workspaceId, REF.workspaceId);
        assert.equal(second[0].group.workspaceId, other.workspaceId);
        assert.equal(second[0].group.displayName, 'Other workspace');
        assert.equal(seeded.fullReads(), 2);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a first read is one statement and a read of the unchanged group one revision probe (D289)', async () => {
    const seeded = await seedCache();
    try {
        seeded.takeStatements();
        const first = await seeded.cache.readSnapshot(REF);
        assert.equal(seeded.takeStatements(), 1);
        const second = await seeded.cache.readSnapshot(REF);
        assert.equal(seeded.takeStatements(), 1);

        assert.equal(second, first);
        assert.equal(seeded.fullReads(), 1);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a write to the group, a member or a session moves the probe, and the next read is the written state in two statements (D289)', async () => {
    const seeded = await seedCache();
    try {
        await seeded.cache.readSnapshot(REF);
        const group = await seeded.repository.findGroup(REF);
        assert.ok(group);
        await seeded.repository.putGroup({ ...group, displayName: 'renamed' });
        seeded.takeStatements();
        assert.equal((await seeded.cache.readSnapshot(REF))?.group.displayName, 'renamed');
        assert.equal(seeded.takeStatements(), 2);

        await seeded.repository.putMember({ ...createMember('alice', 'owner'), invitedByPrincipalId: 'nobody' });
        assert.equal((await seeded.cache.readSnapshot(REF))?.members[0]?.invitedByPrincipalId, 'nobody');

        await seeded.repository.putPresenceSession({ ...createSession(), lastHeartbeatAtEpochMs: 7 });
        assert.equal((await seeded.cache.readSnapshot(REF))?.activeSessions[0]?.lastHeartbeatAtEpochMs, 7);
        await seeded.cache.readSnapshot(REF);
        assert.equal(seeded.fullReads(), 4);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a removed member, session or group moves the probe as a shorter row set, and the next read shows the removal (D289)', async () => {
    const seeded = await seedCache();
    try {
        const group = await seeded.repository.findGroup(REF);
        assert.ok(group);
        await seeded.repository.putMember(createMember('bob', 'member'));
        await seeded.repository.putGroup({ ...group, activeMemberCount: 2 });
        assert.equal((await seeded.cache.readSnapshot(REF))?.members.length, 2);

        await seeded.repository.removeMember({ ...REF, principalId: 'bob' });
        await seeded.repository.putGroup({ ...group, activeMemberCount: 1 });
        assert.deepEqual((await seeded.cache.readSnapshot(REF))?.members.map((member) => member.principalId), ['alice']);

        await seeded.repository.removePresenceSession({ ...REF, sessionId: 'session-alice' });
        assert.deepEqual((await seeded.cache.readSnapshot(REF))?.activeSessions, []);

        await seeded.repository.removeGroup(REF);
        assert.equal(await seeded.cache.readSnapshot(REF), undefined);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a cached snapshot is read again, without the session, once a presence lease it shows has expired on the cache clock (D289)', async () => {
    const seeded = await seedCache();
    try {
        assert.equal((await seeded.cache.readSnapshot(REF))?.activeSessions.length, 1);
        seeded.setNow(SESSION_EXPIRES_AT_EPOCH_MS);

        assert.deepEqual((await seeded.cache.readSnapshot(REF))?.activeSessions, []);
        assert.equal(seeded.fullReads(), 2);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a principal in 21 unchanged kept groups costs one version statement for all of them, and a changed group one probe plus one value read', async () => {
    const seeded = await seedCache(32);
    try {
        const refs = Array.from({ length: 20 }, (_, index) => ({ ...REF, groupId: `kept-room-${index}` }));
        for (const ref of refs) {
            await seeded.repository.putGroup(groupFixture(ref, `Kept ${ref.groupId}`));
            await seeded.repository.putMember({ ...createMember('alice', 'owner'), ...ref });
        }
        const warm = await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', seeded.cache);
        assert.equal(warm.length, 21);
        seeded.runtime.versionReads = 0;
        seeded.runtime.versionedValueReads = 0;
        seeded.takeStatements();

        const kept = await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', seeded.cache);

        assert.deepEqual(kept, warm);
        assert.equal(seeded.runtime.versionReads, 1, 'one version statement probes every kept group');
        assert.equal(seeded.runtime.versionedValueReads, 0);
        // Two membership selections before and two after, around the one probe.
        assert.equal(seeded.takeStatements(), 5);

        const changed = refs[7]!;
        const group = await seeded.repository.findGroup(changed);
        assert.ok(group);
        await seeded.repository.putGroup({ ...group, displayName: 'renamed' });
        seeded.runtime.versionReads = 0;
        seeded.takeStatements();

        const afterChange = await seeded.repository.listSnapshotsForPrincipal(REF, 'alice', seeded.cache);

        assert.equal(afterChange.find((snapshot) => snapshot.group.groupId === changed.groupId)?.group.displayName, 'renamed');
        assert.equal(seeded.runtime.versionReads, 1);
        assert.equal(seeded.runtime.versionedValueReads, 1, 'only the changed group is read again');
        assert.equal(seeded.takeStatements(), 6);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('the cached principal group list answers in group-key order, as the scan and readability filter do', async () => {
    const seeded = await seedCache();
    try {
        const scope = { applicationId: REF.applicationId, workspaceId: REF.workspaceId };
        const longer = { ...REF, groupId: `${REF.groupId}-2` };
        await seeded.repository.putGroup(groupFixture(longer, 'Longer room id'));
        await seeded.repository.putMember({ ...createMember('alice', 'owner'), ...longer });
        const durable = createGroupStateService({
            runtimeRepository: seeded.runtime,
            groupStateEventStore: new InMemoryGroupStateEventStore(),
            serviceId: 'pglite-principal-group-list',
            readPlannedLayoutRow: async () => null,
            readAcceptedLayoutRow: async () => null
        });
        const service = createCachedGroupStateService({
            durable,
            cache: { findOrLoadByRef: (ref) => durable.readSnapshot(ref), observe: () => 'inserted' },
            current: durable,
            principalGroups: {
                listSnapshotsForPrincipal: async (scope, principalId) => await seeded.repository.listSnapshotsForPrincipal(scope, principalId, seeded.cache)
            }
        });

        const memberIndexOrder = await seeded.repository.listSnapshotsForPrincipal(scope, 'alice', seeded.cache);
        const listed = await service.listSnapshotsForPrincipal(scope, 'alice');
        const scanned = (await durable.listSnapshots(scope))
            .filter((snapshot) => canReadGroupSnapshot({ snapshot, actor: { principalId: 'alice' } }).allowed);

        assert.deepEqual(memberIndexOrder.map((snapshot) => snapshot.group.groupId), [longer.groupId, REF.groupId]);
        assert.deepEqual(listed.map((snapshot) => snapshot.group.groupId), [REF.groupId, longer.groupId]);
        assert.deepEqual(
            listed.map((snapshot) => snapshot.group.groupId),
            scanned.map((snapshot) => snapshot.group.groupId)
        );
    }
    finally {
        await seeded.close();
    }
});

async function seedCache(maxEntries = 8): Promise<SeededCache> {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const runtime = new AudienceReadRuntime(lifecycle.database);
    const repository = new GroupStateRepository(runtime, new InMemoryGroupStateEventStore());
    await repository.putGroup(groupFixture(REF, 'Cached room'));
    await repository.putMember(createMember('alice', 'owner'));
    await repository.putPresenceSession(createSession());
    await repository.insertPresenceSummary({
        ...REF,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        activePrincipalIds: ['alice'],
        activeSessionIds: ['session-alice'],
        activeSessions: [createSession()],
        activePrincipalCount: 1,
        activeSessionCount: 1,
        computedAtEpochMs: 1
    });
    let nowEpochMs = Date.now();
    let fullReads = 0;
    let statementsSeen = lifecycle.database.getExecutorCounters?.()?.statements ?? 0;
    const cache = new GroupStateCurrentSnapshotCache({
        repository: {
            readVersionedSnapshot: async (reader, ref, observedAtEpochMs) => {
                fullReads += 1;
                return await repository.readVersionedSnapshot(reader, ref, observedAtEpochMs);
            }
        },
        versionReader: runtime,
        nowEpochMs: () => nowEpochMs,
        maxEntries
    });
    return {
        runtime,
        repository,
        cache,
        fullReads: () => fullReads,
        takeValueRows: () => {
            const rows = runtime.valueRows;
            runtime.valueRows = 0;
            return rows;
        },
        takeStatements: () => {
            const statements = lifecycle.database.getExecutorCounters?.()?.statements ?? 0;
            const taken = statements - statementsSeen;
            statementsSeen = statements;
            return taken;
        },
        setNow: (epochMs) => {
            nowEpochMs = epochMs;
        },
        close: async () => await lifecycle.close()
    };
}

function createMember(
    principalId: string,
    role: GroupMember['role']
): Extract<GroupMember, { status: 'active'; }> {
    const audit = canonicalAuditStamp(1);
    return {
        ...REF,
        principalId,
        role,
        status: 'active',
        joined: audit,
        updated: audit,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    };
}

function createSession(): GroupPresenceSession {
    return {
        ...REF,
        principalId: 'alice',
        sessionId: 'session-alice',
        generationId: 'generation-alice',
        connectionGenerationId: 'ws-generation-alice',
        generationVersion: 1,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: SESSION_EXPIRES_AT_EPOCH_MS
    };
}
