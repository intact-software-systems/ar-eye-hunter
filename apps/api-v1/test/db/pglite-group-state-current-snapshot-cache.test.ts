import assert from 'node:assert/strict';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { GroupStateCurrentSnapshotCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-current-snapshot-cache.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { GroupMember, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';
import { canonicalAuditStamp, groupFixture } from './pglite-state-mutation-test-runtime.ts';

const REF: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'cached-room' };
const SESSION_EXPIRES_AT_EPOCH_MS = Date.parse('2999-01-01T00:00:00.000Z');

interface SeededCache {
    readonly repository: GroupStateRepository;
    readonly cache: GroupStateCurrentSnapshotCache;
    readonly durableReads: () => number;
    readonly setNow: (epochMs: number) => void;
    readonly close: () => Promise<void>;
}

Deno.test('two current reads of an unchanged group cost one full read and a revision probe each (D289)', async () => {
    const seeded = await seedCache();
    try {
        const first = await seeded.cache.readSnapshot(REF);
        const second = await seeded.cache.readSnapshot(REF);

        assert.equal(second, first);
        assert.equal(seeded.durableReads(), 1);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a write to the group, a member or a session moves the probe, and the next read is the written state (D289)', async () => {
    const seeded = await seedCache();
    try {
        await seeded.cache.readSnapshot(REF);
        const group = await seeded.repository.findGroup(REF);
        assert.ok(group);
        await seeded.repository.putGroup({ ...group, displayName: 'renamed' });
        assert.equal((await seeded.cache.readSnapshot(REF))?.group.displayName, 'renamed');

        await seeded.repository.putMember({ ...createOwner(), invitedByPrincipalId: 'nobody' });
        assert.equal((await seeded.cache.readSnapshot(REF))?.members[0]?.invitedByPrincipalId, 'nobody');

        await seeded.repository.putPresenceSession({ ...createSession(), lastHeartbeatAtEpochMs: 7 });
        assert.equal((await seeded.cache.readSnapshot(REF))?.activeSessions[0]?.lastHeartbeatAtEpochMs, 7);
        await seeded.cache.readSnapshot(REF);
        assert.equal(seeded.durableReads(), 4);
    }
    finally {
        await seeded.close();
    }
});

Deno.test('a cached snapshot is read again once a presence lease it shows has expired (D289)', async () => {
    const seeded = await seedCache();
    try {
        assert.equal((await seeded.cache.readSnapshot(REF))?.activeSessions.length, 1);
        seeded.setNow(SESSION_EXPIRES_AT_EPOCH_MS);

        await seeded.cache.readSnapshot(REF);

        assert.equal(seeded.durableReads(), 2);
    }
    finally {
        await seeded.close();
    }
});

async function seedCache(): Promise<SeededCache> {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const runtime = new PSqlRuntimeStateRepository(lifecycle.database);
    const repository = new GroupStateRepository(runtime, new InMemoryGroupStateEventStore());
    await repository.putGroup(groupFixture(REF, 'Cached room'));
    await repository.putMember(createOwner());
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
    let durableReads = 0;
    const cache = new GroupStateCurrentSnapshotCache({
        durable: {
            readSnapshot: async (ref: GroupRef): Promise<GroupSnapshot | undefined> => {
                durableReads += 1;
                return await repository.readSnapshot(ref);
            }
        },
        versionReader: runtime,
        nowEpochMs: () => nowEpochMs,
        maxEntries: 8
    });
    return {
        repository,
        cache,
        durableReads: () => durableReads,
        setNow: (epochMs) => {
            nowEpochMs = epochMs;
        },
        close: async () => await lifecycle.close()
    };
}

function createOwner(): GroupMember {
    const audit = canonicalAuditStamp(1);
    return {
        ...REF,
        principalId: 'alice',
        role: 'owner',
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
