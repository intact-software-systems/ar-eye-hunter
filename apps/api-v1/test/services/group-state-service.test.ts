import assert from 'node:assert/strict';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { createGroupStateService } from '../../src/services/group-state-service.ts';
import type { StateSyncPublisher } from '../../src/services/state-sync-service.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateTransactionalRepositoryLike,
} from '../../src/repository/RuntimeStateRepository.ts';

const TEST_SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};
const INITIAL_EXPIRES_AT_EPOCH_MS = 4_102_444_821_000;
const REFRESHED_EXPIRES_AT_EPOCH_MS = 4_102_444_822_000;

const NO_OP_SYNC_PUBLISHER: StateSyncPublisher = {
    publishClientSnapshot: async () => {
    },
    publishClientEvent: async () => {
    },
    publishGroupSnapshot: async () => {
    },
    publishGroupEvent: async () => {
    },
};

Deno.test('connectPresenceSession rejects missing and non-active group members', async () => {
    const service = createTestGroupStateService();
    await service.createGroup(TEST_SCOPE, {
        groupId: 'group-1',
        displayName: 'Room 1',
        kind: 'room',
        createdByPrincipalId: 'owner-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
    });

    await assert.rejects(
        () =>
            service.connectPresenceSession(TEST_SCOPE, 'group-1', 'missing-session', {
                principalId: 'missing-member',
                actorPrincipalId: 'missing-member',
                actorSessionId: 'missing-session',
            }),
        /Forbidden: group member not found for presence session: missing-member/,
    );

    for (const status of ['left', 'removed', 'banned'] as const) {
        await service.upsertMember(TEST_SCOPE, 'group-1', 'member-2', {
            status,
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
        });

        await assert.rejects(
            () =>
                service.connectPresenceSession(
                    TEST_SCOPE,
                    'group-1',
                    `session-${status}`,
                    {
                        principalId: 'member-2',
                        actorPrincipalId: 'member-2',
                        actorSessionId: `session-${status}`,
                    },
                ),
            /Forbidden: group member is not active for presence session: member-2/,
        );
    }
});

Deno.test('upsertMember preserves existing roles across leave and rejoin', async () => {
    const service = createTestGroupStateService();
    await service.createGroup(TEST_SCOPE, {
        groupId: 'group-1',
        displayName: 'Room 1',
        kind: 'room',
        createdByPrincipalId: 'owner-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
    });

    await service.upsertMember(TEST_SCOPE, 'group-1', 'owner-1', {
        status: 'left',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
    });
    assertMember(await readSnapshot(service), 'owner-1', 'owner', 'left');

    await service.upsertMember(TEST_SCOPE, 'group-1', 'owner-1', {
        status: 'active',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
    });
    assertMember(await readSnapshot(service), 'owner-1', 'owner', 'active');
});

Deno.test('heartbeatPresenceSession refreshes TTL without publishing unchanged snapshots', async () => {
    const syncPublisher = createRecordingStateSyncPublisher();
    const service = createTestGroupStateService(syncPublisher);

    await service.createGroup(TEST_SCOPE, {
        groupId: 'group-1',
        displayName: 'Room 1',
        kind: 'room',
        createdByPrincipalId: 'owner-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
    });
    await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session', {
        principalId: 'owner-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        lastHeartbeatAtEpochMs: 1_000,
        expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
    });
    syncPublisher.reset();

    const before = await readSnapshot(service);
    const refreshed = await service.heartbeatPresenceSession(
        TEST_SCOPE,
        'group-1',
        'owner-session',
        {
            principalId: 'owner-1',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            lastHeartbeatAtEpochMs: 2_000,
            expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
        },
    );

    assert.equal(refreshed.group.presenceVersion, before.group.presenceVersion);
    assert.equal(refreshed.activeSessions[0].lastHeartbeatAtEpochMs, 2_000);
    assert.equal(
        refreshed.activeSessions[0].expiresAtEpochMs,
        REFRESHED_EXPIRES_AT_EPOCH_MS,
    );
    assert.equal(syncPublisher.groupSnapshots.length, 0);
    assert.equal(syncPublisher.groupEvents.length, 0);
});

Deno.test('updateGroup ignores unchanged metadata state', async () => {
    const syncPublisher = createRecordingStateSyncPublisher();
    const service = createTestGroupStateService(syncPublisher);

    const created = await service.createGroup(TEST_SCOPE, {
        groupId: 'group-1',
        displayName: 'Room 1',
        kind: 'room',
        createdByPrincipalId: 'owner-1',
        actorPrincipalId: 'owner-1',
    });
    syncPublisher.reset();

    const unchanged = await service.updateGroup(TEST_SCOPE, 'group-1', {
        displayName: 'Room 1',
        kind: 'room',
        actorPrincipalId: 'owner-1',
    });

    assert.equal(unchanged.group.metadataVersion, created.group.metadataVersion);
    assert.equal(syncPublisher.groupSnapshots.length, 0);
    assert.equal(syncPublisher.groupEvents.length, 0);
});

Deno.test('upsertMember and connectPresenceSession ignore unchanged semantic state', async () => {
    const syncPublisher = createRecordingStateSyncPublisher();
    const service = createTestGroupStateService(syncPublisher);

    await service.createGroup(TEST_SCOPE, {
        groupId: 'group-1',
        displayName: 'Room 1',
        kind: 'room',
        createdByPrincipalId: 'owner-1',
        actorPrincipalId: 'owner-1',
    });
    syncPublisher.reset();

    const joined = await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
        status: 'active',
        role: 'member',
        actorPrincipalId: 'owner-1',
    });
    syncPublisher.reset();

    const unchangedMember = await service.upsertMember(
        TEST_SCOPE,
        'group-1',
        'member-1',
        {
            status: 'active',
            role: 'member',
            actorPrincipalId: 'owner-1',
        },
    );
    const connected = await service.connectPresenceSession(
        TEST_SCOPE,
        'group-1',
        'member-session',
        {
            principalId: 'member-1',
            actorPrincipalId: 'member-1',
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
        },
    );
    syncPublisher.reset();
    const unchangedPresence = await service.connectPresenceSession(
        TEST_SCOPE,
        'group-1',
        'member-session',
        {
            principalId: 'member-1',
            actorPrincipalId: 'member-1',
            lastHeartbeatAtEpochMs: 2_000,
            expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
        },
    );

    assert.equal(unchangedMember.group.rosterVersion, joined.group.rosterVersion);
    assert.equal(unchangedPresence.group.presenceVersion, connected.group.presenceVersion);
    assert.equal(
        unchangedPresence.activeSessions[0].expiresAtEpochMs,
        REFRESHED_EXPIRES_AT_EPOCH_MS,
    );
    assert.equal(syncPublisher.groupSnapshots.length, 0);
    assert.equal(syncPublisher.groupEvents.length, 0);
});

function createTestGroupStateService(
    syncPublisher: StateSyncPublisher = NO_OP_SYNC_PUBLISHER,
) {
    return createGroupStateService({
        runtimeRepository: new FakeRuntimeStateRepository(),
        syncPublisher,
        now: () => 1_000,
        serviceId: 'test-service',
    });
}

function createRecordingStateSyncPublisher() {
    const groupSnapshots: GroupSnapshot[] = [];
    const groupEvents: GroupEvent[] = [];

    return {
        groupSnapshots,
        groupEvents,
        reset() {
            groupSnapshots.length = 0;
            groupEvents.length = 0;
        },
        publishClientSnapshot: async () => {
        },
        publishClientEvent: async () => {
        },
        publishGroupSnapshot: async (snapshot: GroupSnapshot) => {
            groupSnapshots.push(snapshot);
        },
        publishGroupEvent: async (event: GroupEvent) => {
            groupEvents.push(event);
        },
    } satisfies StateSyncPublisher & {
        groupSnapshots: GroupSnapshot[];
        groupEvents: GroupEvent[];
        reset(): void;
    };
}

async function readSnapshot(
    service: ReturnType<typeof createTestGroupStateService>,
): Promise<GroupSnapshot> {
    const snapshot = await service.readSnapshot({
        ...TEST_SCOPE,
        groupId: 'group-1',
    });
    if (!snapshot) {
        throw new Error('Expected group snapshot to exist');
    }

    return snapshot;
}

function assertMember(
    snapshot: GroupSnapshot,
    principalId: string,
    role: string,
    status: string,
): void {
    const member = snapshot.members.find((entry) => entry.principalId === principalId);
    if (!member) {
        throw new Error(`Expected member ${principalId} to exist`);
    }

    assert.equal(member.role, role);
    assert.equal(member.status, status);
}

class FakeRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();

    async begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        return await fn(this);
    }

    findEntry(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntry | undefined> {
        const entry = this.data.get(this.toKey(namespace, key));
        return Promise.resolve(entry ? { ...entry } : undefined);
    }

    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key)),
        );
    }

    findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(
                    ([compositeKey]) =>
                        this.toNamespace(compositeKey) === namespace &&
                        this.toStoreKey(compositeKey).startsWith(keyPrefix),
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key)),
        );
    }

    upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<void> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0,
        });
        return Promise.resolve();
    }

    deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
        return Promise.resolve();
    }

    deleteExpired(namespace: string): Promise<number> {
        let deleted = 0;

        for (const [compositeKey, entry] of this.data.entries()) {
            if (this.toNamespace(compositeKey) !== namespace) {
                continue;
            }

            if (entry.expireAtTimestamp > Date.now()) {
                continue;
            }

            this.data.delete(compositeKey);
            deleted += 1;
        }

        return Promise.resolve(deleted);
    }

    async lockKey(_namespace: string, _key: string): Promise<void> {
    }

    private toKey(namespace: string, key: string): string {
        return `${namespace}::${key}`;
    }

    private toNamespace(compositeKey: string): string {
        return compositeKey.split('::', 1)[0] ?? '';
    }

    private toStoreKey(compositeKey: string): string {
        return compositeKey.slice(this.toNamespace(compositeKey).length + 2);
    }
}
