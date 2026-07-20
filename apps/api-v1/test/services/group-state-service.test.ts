import assert from 'node:assert/strict';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { readRallarGroupDirectorFromSnapshot } from '@shared/api/group-director.ts';
import { createTestGroupStateRuntime } from '../../../../packages/tests/shared-server/group-state-test-runtime.ts';
import type { StateSyncPublisher } from '../../src/services/state-sync-service.ts';
import type { GroupStateWritten } from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import type {
  RuntimeStateConditionalWriteResult,
  RuntimeStateEntry,
  RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

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
        generationId: 'test-generation',
        principalId: 'missing-member',
        actorPrincipalId: 'missing-member',
        actorSessionId: 'missing-session',
      }),
    /Forbidden: active group member required for presence: missing-member/,
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
            generationId: 'test-generation',
            principalId: 'member-2',
            actorPrincipalId: 'member-2',
            actorSessionId: `session-${status}`,
          },
        ),
      /Forbidden: active group member required for presence: member-2/,
    );
  }
});

Deno.test('upsertMember preserves existing admin roles across leave and rejoin', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    joinMode: 'open',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'admin-1', {
    status: 'active',
    role: 'admin',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  await service.upsertMember(TEST_SCOPE, 'group-1', 'admin-1', {
    status: 'left',
    actorPrincipalId: 'admin-1',
    actorSessionId: 'admin-session',
  });
  assertMember(await readSnapshot(service), 'admin-1', 'admin', 'left');

  await service.upsertMember(TEST_SCOPE, 'group-1', 'admin-1', {
    status: 'active',
    actorPrincipalId: 'admin-1',
    actorSessionId: 'admin-session',
  });
  assertMember(await readSnapshot(service), 'admin-1', 'admin', 'active');
});

Deno.test('semantic group mutations advance snapshotVersion', async () => {
  const service = createTestGroupStateService();

  const createdWritten = await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  const created = snapshotFromGroupStateWritten(createdWritten);
  assertSnapshotVersion(created, 1);
  assertEventSnapshotVersion(createdWritten, 1);

  const unchanged = snapshotFromGroupStateWritten(
    await service.updateGroup(TEST_SCOPE, 'group-1', {
      displayName: 'Room 1',
      kind: 'room',
      actorPrincipalId: 'owner-1',
    }),
  );
  assertSnapshotVersion(unchanged, 1);

  const updatedWritten = await service.updateGroup(TEST_SCOPE, 'group-1', {
    displayName: 'Room 1 updated',
    actorPrincipalId: 'owner-1',
  });
  const updated = snapshotFromGroupStateWritten(updatedWritten);
  assertSnapshotVersion(updated, 2);
  assertEventSnapshotVersion(updatedWritten, 2);

  const joinedWritten = await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
    status: 'active',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  const joined = snapshotFromGroupStateWritten(joinedWritten);
  assertSnapshotVersion(joined, 3);
  assertEventSnapshotVersion(joinedWritten, 3);

  const connectedWritten = await service.connectPresenceSession(
    TEST_SCOPE,
    'group-1',
    'member-session',
    {
      generationId: 'test-generation',
      principalId: 'member-1',
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      lastHeartbeatAtEpochMs: 1_000,
      expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
    },
  );
  const connected = snapshotFromGroupStateWritten(connectedWritten);
  assertSnapshotVersion(connected, 3);
  assertEventSnapshotVersion(connectedWritten, 3);

  const heartbeat = snapshotFromGroupStateWritten(
    await service.heartbeatPresenceSession(
      TEST_SCOPE,
      'group-1',
      'member-session',
      {
        generationId: 'test-generation',
        principalId: 'member-1',
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
        lastHeartbeatAtEpochMs: 2_000,
        expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
      },
    ),
  );
  assertSnapshotVersion(heartbeat, 3);

  const disconnectedWritten = await service.disconnectPresenceSession(
    TEST_SCOPE,
    'group-1',
    'member-session',
    {
      generationId: 'test-generation',
      principalId: 'member-1',
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      disconnectedAtEpochMs: 3_000,
      reason: 'left',
    },
  );
  const disconnected = snapshotFromGroupStateWritten(disconnectedWritten);
  assertSnapshotVersion(disconnected, 3);
  assertEventSnapshotVersion(disconnectedWritten, 3);
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
    generationId: 'test-generation',
    principalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    lastHeartbeatAtEpochMs: 1_000,
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });
  syncPublisher.reset();

  const before = await readSnapshot(service);
  const refreshed = snapshotFromGroupStateWritten(
    await service.heartbeatPresenceSession(
      TEST_SCOPE,
      'group-1',
      'owner-session',
      {
        generationId: 'test-generation',
        principalId: 'owner-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        lastHeartbeatAtEpochMs: 2_000,
        expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
      },
    ),
  );

  assert.equal(refreshed.group.presenceVersion, before.group.presenceVersion);
  assert.deepEqual(refreshed.activeSessions, []);
  assert.equal(syncPublisher.groupSnapshots.length, 0);
  assert.equal(syncPublisher.groupEvents.length, 0);
});

Deno.test('updateGroup ignores unchanged metadata state', async () => {
  const syncPublisher = createRecordingStateSyncPublisher();
  const service = createTestGroupStateService(syncPublisher);

  const created = snapshotFromGroupStateWritten(
    await service.createGroup(TEST_SCOPE, {
      groupId: 'group-1',
      displayName: 'Room 1',
      kind: 'room',
      createdByPrincipalId: 'owner-1',
      actorPrincipalId: 'owner-1',
    }),
  );
  syncPublisher.reset();

  const unchanged = snapshotFromGroupStateWritten(
    await service.updateGroup(TEST_SCOPE, 'group-1', {
      displayName: 'Room 1',
      kind: 'room',
      actorPrincipalId: 'owner-1',
    }),
  );

  assert.equal(unchanged.group.metadataVersion, created.group.metadataVersion);
  assert.equal(syncPublisher.groupSnapshots.length, 0);
  assert.equal(syncPublisher.groupEvents.length, 0);
});

Deno.test('archived and deleted groups reject member activation and presence mutations', async () => {
  for (const status of ['archived', 'deleted'] as const) {
    const service = createTestGroupStateService();
    const code = status === 'archived' ? 'group-archived' : 'group-deleted';
    await service.createGroup(TEST_SCOPE, {
      groupId: 'group-1',
      displayName: 'Room 1',
      kind: 'room',
      createdByPrincipalId: 'owner-1',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
    });
    await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
      status: 'active',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
    });
    await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'member-session', {
      generationId: 'test-generation',
      principalId: 'member-1',
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      lastHeartbeatAtEpochMs: 1_000,
      expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
    });
    await service.updateGroup(TEST_SCOPE, 'group-1', {
      status,
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
    });

    await assertPolicyRejects(
      () =>
        service.upsertMember(TEST_SCOPE, 'group-1', 'member-2', {
          status: 'active',
          actorPrincipalId: 'owner-1',
          actorSessionId: 'owner-session',
        }),
      code,
    );
    await assertPolicyRejects(
      () =>
        service.connectPresenceSession(TEST_SCOPE, 'group-1', 'late-session', {
          generationId: 'test-generation',
          principalId: 'member-1',
          actorPrincipalId: 'member-1',
          actorSessionId: 'late-session',
          expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
        }),
      code,
    );
    await assertPolicyRejects(
      () =>
        service.heartbeatPresenceSession(TEST_SCOPE, 'group-1', 'member-session', {
          generationId: 'test-generation',
          principalId: 'member-1',
          actorPrincipalId: 'member-1',
          actorSessionId: 'member-session',
          lastHeartbeatAtEpochMs: 2_000,
          expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
        }),
      code,
    );
    await assertPolicyRejects(
      () =>
        service.appointDirector(TEST_SCOPE, 'group-1', {
          actorPrincipalId: 'member-1',
          actorSessionId: 'member-session',
          requestId: `appoint-${status}`,
        }),
      code,
    );
  }
});

Deno.test('archived and deleted groups reject non-lifecycle metadata updates', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.updateGroup(TEST_SCOPE, 'group-1', {
    status: 'archived',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  await assertPolicyRejects(
    () =>
      service.updateGroup(TEST_SCOPE, 'group-1', {
        displayName: 'Renamed while archived',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
      }),
    'group-archived',
  );

  const deleted = snapshotFromGroupStateWritten(
    await service.updateGroup(TEST_SCOPE, 'group-1', {
      status: 'deleted',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
    }),
  );
  assert.equal(deleted.group.status, 'deleted');

  await assertPolicyRejects(
    () =>
      service.updateGroup(TEST_SCOPE, 'group-1', {
        metadata: { blocked: true },
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
      }),
    'group-deleted',
  );
});

Deno.test('expired groups reject member activation and presence connect', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    expiresAtEpochMs: 999,
  });

  await assertPolicyRejects(
    () =>
      service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
        status: 'active',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
      }),
    'group-not-active',
  );
  await assertPolicyRejects(
    () =>
      service.connectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session', {
        generationId: 'test-generation',
        principalId: 'owner-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
      }),
    'group-not-active',
  );
});

Deno.test('presence transitions maintain emptySinceEpochMs deterministically', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
    status: 'active',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session', {
    generationId: 'test-generation',
    principalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'member-session', {
    generationId: 'test-generation',
    principalId: 'member-1',
    actorPrincipalId: 'member-1',
    actorSessionId: 'member-session',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });

  const ownerDisconnected = snapshotFromGroupStateWritten(
    await service.disconnectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session', {
      generationId: 'test-generation',
      principalId: 'owner-1',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      reason: 'left',
    }),
  );
  assert.equal(ownerDisconnected.group.emptySinceEpochMs, null);

  const empty = snapshotFromGroupStateWritten(
    await service.disconnectPresenceSession(TEST_SCOPE, 'group-1', 'member-session', {
      generationId: 'test-generation',
      principalId: 'member-1',
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      reason: 'left',
    }),
  );
  assert.equal(empty.group.emptySinceEpochMs, null);

  const reconnected = snapshotFromGroupStateWritten(
    await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session', {
      generationId: 'test-generation',
      principalId: 'owner-1',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
    }),
  );
  assert.equal(reconnected.group.emptySinceEpochMs, null);
});

Deno.test('expired presence sessions mark groups empty without purging durable state', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    purgeAfterEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session', {
    generationId: 'test-generation',
    principalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });

  const [written] = await service.expireExpiredPresenceSessions(
    REFRESHED_EXPIRES_AT_EPOCH_MS,
  );
  if (!written) {
    throw new Error('Expected expired presence session to be disconnected');
  }
  const expired = snapshotFromGroupStateWritten(written);
  assert.equal(expired.group.emptySinceEpochMs, null);
  assert.equal(expired.group.purgeAfterEpochMs, INITIAL_EXPIRES_AT_EPOCH_MS);

  const durableSnapshot = await readSnapshot(service);
  assert.equal(durableSnapshot.group.groupId, 'group-1');
  assert.equal(durableSnapshot.group.purgeAfterEpochMs, INITIAL_EXPIRES_AT_EPOCH_MS);
});

Deno.test('joinGroup enforces admission policy and activates allowed members', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'open-group',
    displayName: 'Open Room',
    kind: 'room',
    joinMode: 'open',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  const joined = snapshotFromGroupStateWritten(
    await service.joinGroup(TEST_SCOPE, 'open-group', {
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      requestId: 'join-open-member',
    }),
  );
  assertMember(joined, 'member-1', 'member', 'active');

  await service.upsertMember(TEST_SCOPE, 'open-group', 'member-1', {
    status: 'left',
    actorPrincipalId: 'member-1',
    actorSessionId: 'member-session',
  });
  const rejoined = snapshotFromGroupStateWritten(
    await service.joinGroup(TEST_SCOPE, 'open-group', {
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      requestId: 'rejoin-open-member',
    }),
  );
  assertMember(rejoined, 'member-1', 'member', 'active');
});

Deno.test('joinGroup rejects invite-only, code, removed, and banned join attempts when policy denies them', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'invite-group',
    displayName: 'Invite Room',
    kind: 'room',
    joinMode: 'invite-only',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.createGroup(TEST_SCOPE, {
    groupId: 'code-group',
    displayName: 'Code Room',
    kind: 'room',
    joinMode: 'code',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.createGroup(TEST_SCOPE, {
    groupId: 'open-group',
    displayName: 'Open Room',
    kind: 'room',
    joinMode: 'open',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.upsertMember(TEST_SCOPE, 'open-group', 'removed-member', {
    status: 'removed',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.upsertMember(TEST_SCOPE, 'open-group', 'banned-member', {
    status: 'banned',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  await assertPolicyRejects(
    () =>
      service.joinGroup(TEST_SCOPE, 'invite-group', {
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
        requestId: 'join-invite-without-invite',
      }),
    'group-invite-required',
  );
  await assertPolicyRejects(
    () =>
      service.joinGroup(TEST_SCOPE, 'invite-group', {
        actorPrincipalId: 'member-2',
        actorSessionId: 'member-2-session',
        inviteToken: 'unissued-token',
        requestId: 'join-invite-with-unissued-token',
      }),
    'group-invite-required',
  );
  await assertPolicyRejects(
    () =>
      service.joinGroup(TEST_SCOPE, 'code-group', {
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
        requestId: 'join-code-without-code',
      }),
    'group-code-required',
  );
  await assertPolicyRejects(
    () =>
      service.joinGroup(TEST_SCOPE, 'open-group', {
        actorPrincipalId: 'removed-member',
        actorSessionId: 'removed-session',
        requestId: 'join-removed',
      }),
    'member-removed',
  );
  await assertPolicyRejects(
    () =>
      service.joinGroup(TEST_SCOPE, 'open-group', {
        actorPrincipalId: 'banned-member',
        actorSessionId: 'banned-session',
        requestId: 'join-banned',
      }),
    'member-banned',
  );
});

Deno.test('self-service active-member upsert is admission policy gated', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'invite-group',
    displayName: 'Invite Room',
    kind: 'room',
    joinMode: 'invite-only',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  await assertPolicyRejects(
    () =>
      service.upsertMember(TEST_SCOPE, 'invite-group', 'member-1', {
        status: 'active',
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
      }),
    'group-invite-required',
  );
});

Deno.test('maxMembers blocks new active members without mutating roster state', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Small Room',
    kind: 'room',
    joinMode: 'open',
    maxMembers: 1,
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  const before = await readSnapshot(service);

  await assertPolicyRejects(
    () =>
      service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
        status: 'active',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'activate-over-cap',
      }),
    'group-full',
  );

  const after = await readSnapshot(service);
  assert.equal(after.group.snapshotVersion, before.group.snapshotVersion);
  assert.equal(after.group.rosterVersion, before.group.rosterVersion);
  assert.equal(after.members.some((member) => member.principalId === 'member-1'), false);
});

Deno.test('invited members do not reserve maxMembers slots by default', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Invited Room',
    kind: 'room',
    joinMode: 'open',
    maxMembers: 2,
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'invited-member', {
    status: 'invited',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  const joined = snapshotFromGroupStateWritten(
    await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
      status: 'active',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'activate-with-invited-slot',
    }),
  );

  assertMember(joined, 'invited-member', 'member', 'invited');
  assertMember(joined, 'member-1', 'member', 'active');
  assert.equal(joined.memberCount, 2);
});

Deno.test('maxSessionsPerMember blocks additional live sessions without mutating presence state', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Single Session Room',
    kind: 'room',
    maxSessionsPerMember: 1,
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session-1', {
    generationId: 'test-generation',
    principalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session-1',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
    requestId: 'connect-owner-session-1',
  });
  const before = await readSnapshot(service);

  await assertPolicyRejects(
    () =>
      service.connectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session-2', {
        generationId: 'test-generation',
        principalId: 'owner-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session-2',
        expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
        requestId: 'connect-owner-session-2',
      }),
    'member-session-limit-reached',
  );

  const after = await readSnapshot(service);
  assert.equal(after.group.snapshotVersion, before.group.snapshotVersion);
  assert.equal(after.group.presenceVersion, before.group.presenceVersion);
  assert.deepEqual(after.activeSessions, []);
});

Deno.test('idempotent accepted capacity mutations do not double-count existing slots', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Idempotent Capacity Room',
    kind: 'room',
    joinMode: 'open',
    maxMembers: 2,
    maxSessionsPerMember: 1,
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  const joined = snapshotFromGroupStateWritten(
    await service.joinGroup(TEST_SCOPE, 'group-1', {
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      requestId: 'join-member-1',
    }),
  );
  const joinedAgain = snapshotFromGroupStateWritten(
    await service.joinGroup(TEST_SCOPE, 'group-1', {
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      requestId: 'join-member-1',
    }),
  );
  assert.equal(joinedAgain.group.snapshotVersion, joined.group.snapshotVersion);
  assert.equal(
    joinedAgain.members.filter((member) => member.status === 'active').length,
    2,
  );

  const connected = snapshotFromGroupStateWritten(
    await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'member-session', {
      generationId: 'test-generation',
      principalId: 'member-1',
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
      requestId: 'connect-member-session',
    }),
  );
  const connectedAgain = snapshotFromGroupStateWritten(
    await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'member-session', {
      generationId: 'test-generation',
      principalId: 'member-1',
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
      requestId: 'connect-member-session',
    }),
  );
  assert.equal(connectedAgain.group.snapshotVersion, connected.group.snapshotVersion);
  assert.equal(connectedAgain.activeSessions.length, 0);
});

Deno.test('createGroupInvite lets owners and admins invite members', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Invite Room',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  const ownerInvite = snapshotFromGroupStateWritten(
    await service.createGroupInvite(TEST_SCOPE, 'group-1', 'member-1', {
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'invite-member-1',
    }),
  );
  assertMember(ownerInvite, 'member-1', 'member', 'invited');

  await service.upsertMember(TEST_SCOPE, 'group-1', 'admin-1', {
    status: 'active',
    role: 'admin',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  const adminInviteWritten = await service.createGroupInvite(
    TEST_SCOPE,
    'group-1',
    'member-2',
    {
      actorPrincipalId: 'admin-1',
      actorSessionId: 'admin-session',
      requestId: 'invite-member-2',
    },
  );
  const adminInvite = snapshotFromGroupStateWritten(adminInviteWritten);

  assertMember(adminInvite, 'member-2', 'member', 'invited');
  assert.equal(adminInviteWritten.result.right?.event?.eventType, 'member-invited');
  const invited = adminInvite.members.find((member) => member.principalId === 'member-2');
  assert.equal(invited?.invitedByPrincipalId, 'admin-1');
  assert.equal(invited?.invitationExpiresAtEpochMs, 1_000 + 7 * 24 * 60 * 60 * 1000);
});

Deno.test('createGroupInvite rejects regular members', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Invite Room',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
    status: 'active',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  await assertPolicyRejects(
    () =>
      service.createGroupInvite(TEST_SCOPE, 'group-1', 'member-2', {
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
        requestId: 'invite-by-member',
      }),
    'forbidden-role',
  );
});

Deno.test('acceptGroupInvite enforces invite expiry and activates valid invites', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Invite Room',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.createGroupInvite(TEST_SCOPE, 'group-1', 'expired-member', {
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    invitationExpiresAtEpochMs: 999,
    requestId: 'invite-expired-member',
  });
  await assertPolicyRejects(
    () =>
      service.acceptGroupInvite(TEST_SCOPE, 'group-1', {
        actorPrincipalId: 'expired-member',
        actorSessionId: 'expired-session',
        requestId: 'accept-expired-member',
      }),
    'group-invite-expired',
  );

  await service.createGroupInvite(TEST_SCOPE, 'group-1', 'member-1', {
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    invitationExpiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
    requestId: 'invite-member-1-valid',
  });
  const acceptedWritten = await service.acceptGroupInvite(TEST_SCOPE, 'group-1', {
    actorPrincipalId: 'member-1',
    actorSessionId: 'member-session',
    requestId: 'accept-member-1',
  });
  const accepted = snapshotFromGroupStateWritten(acceptedWritten);

  assertMember(accepted, 'member-1', 'member', 'active');
  assert.equal(acceptedWritten.result.right?.event?.eventType, 'member-joined');
});

Deno.test('revoked invites and banned members cannot be accepted', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Invite Room',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.createGroupInvite(TEST_SCOPE, 'group-1', 'revoked-member', {
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    requestId: 'invite-revoked-member',
  });
  const revokedWritten = await service.revokeGroupInvite(
    TEST_SCOPE,
    'group-1',
    'revoked-member',
    {
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'revoke-member',
    },
  );
  assert.equal(revokedWritten.result.right?.event?.eventType, 'member-left');
  await assertPolicyRejects(
    () =>
      service.acceptGroupInvite(TEST_SCOPE, 'group-1', {
        actorPrincipalId: 'revoked-member',
        actorSessionId: 'revoked-session',
        requestId: 'accept-revoked-member',
      }),
    'group-invite-required',
  );

  await service.createGroupInvite(TEST_SCOPE, 'group-1', 'banned-member', {
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    requestId: 'invite-banned-member',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'banned-member', {
    status: 'banned',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await assertPolicyRejects(
    () =>
      service.acceptGroupInvite(TEST_SCOPE, 'group-1', {
        actorPrincipalId: 'banned-member',
        actorSessionId: 'banned-session',
        requestId: 'accept-banned-member',
      }),
    'member-banned',
  );
});

Deno.test('rotateGroupJoinCode stores only a verifier and validates code joins', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'code-group',
    displayName: 'Code Room',
    kind: 'room',
    joinMode: 'code',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  const rotated = joinCodeResponseFromGroupJoinCodeWritten(
    await service.rotateGroupJoinCode(TEST_SCOPE, 'code-group', {
      joinCode: 'old-code',
      expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'rotate-old-code',
    }),
  );
  assert.equal(rotated.joinCode, 'OLDCODE');
  assert.equal(rotated.expiresAtEpochMs, REFRESHED_EXPIRES_AT_EPOCH_MS);
  assert.equal(JSON.stringify(rotated.snapshot.group.metadata).includes('old-code'), false);

  await assertPolicyRejects(
    () =>
      service.joinGroup(TEST_SCOPE, 'code-group', {
        actorPrincipalId: 'wrong-member',
        actorSessionId: 'wrong-session',
        joinCode: 'wrong-code',
        requestId: 'join-wrong-code',
      }),
    'group-code-invalid',
  );

  const joined = snapshotFromGroupStateWritten(
    await service.joinGroup(TEST_SCOPE, 'code-group', {
      actorPrincipalId: 'member-1',
      actorSessionId: 'member-session',
      joinCode: 'old-code',
      requestId: 'join-old-code',
    }),
  );
  assertMember(joined, 'member-1', 'member', 'active');

  await service.rotateGroupJoinCode(TEST_SCOPE, 'code-group', {
    joinCode: 'new-code',
    expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    requestId: 'rotate-new-code',
  });
  await assertPolicyRejects(
    () =>
      service.joinGroup(TEST_SCOPE, 'code-group', {
        actorPrincipalId: 'member-2',
        actorSessionId: 'member-2-session',
        joinCode: 'old-code',
        requestId: 'join-old-code-after-rotation',
      }),
    'group-code-invalid',
  );
  const joinedAfterRotation = snapshotFromGroupStateWritten(
    await service.joinGroup(TEST_SCOPE, 'code-group', {
      actorPrincipalId: 'member-2',
      actorSessionId: 'member-2-session',
      joinCode: 'new-code',
      requestId: 'join-new-code',
    }),
  );
  assertMember(joinedAfterRotation, 'member-2', 'member', 'active');
});

Deno.test('rotateGroupJoinCode replays direct service retries for the same request id', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'code-group',
    displayName: 'Code Room',
    kind: 'room',
    joinMode: 'code',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  const first = joinCodeResponseFromGroupJoinCodeWritten(
    await service.rotateGroupJoinCode(TEST_SCOPE, 'code-group', {
      joinCode: 'first-code',
      expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'rotate-code-idempotent',
    }),
  );
  await assert.rejects(
    () =>
      service.rotateGroupJoinCode(TEST_SCOPE, 'code-group', {
        joinCode: 'second-code',
        expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS + 1,
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'rotate-code-idempotent',
      }),
    /Group mutation command differs/,
  );
  assert.equal(first.joinCode, 'FIRSTCODE');
  await assertPolicyRejects(
    () =>
      service.joinGroup(TEST_SCOPE, 'code-group', {
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
        joinCode: 'second-code',
        requestId: 'join-second-code-after-retry',
      }),
    'group-code-invalid',
  );
});

Deno.test('expired join codes reject code joins', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'code-group',
    displayName: 'Expired Code Room',
    kind: 'room',
    joinMode: 'code',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.rotateGroupJoinCode(TEST_SCOPE, 'code-group', {
    joinCode: 'expired-code',
    expiresAtEpochMs: 999,
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    requestId: 'rotate-expired-code',
  });

  await assertPolicyRejects(
    () =>
      service.joinGroup(TEST_SCOPE, 'code-group', {
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
        joinCode: 'expired-code',
        requestId: 'join-expired-code',
      }),
    'group-code-invalid',
  );
});

Deno.test('membership governance operations enforce hierarchy and emit member events', async () => {
  const service = createTestGroupStateService();
  await createGovernanceGroup(service);

  const removedWritten = await service.removeGroupMember(
    TEST_SCOPE,
    'group-1',
    'member-1',
    {
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'remove-member-1',
    },
  );
  const removed = snapshotFromGroupStateWritten(removedWritten);
  assert.equal(removedWritten.result.right?.event?.eventType, 'member-removed');
  assertMember(removed, 'member-1', 'member', 'removed');

  const bannedWritten = await service.banGroupMember(
    TEST_SCOPE,
    'group-1',
    'member-2',
    {
      actorPrincipalId: 'admin-1',
      actorSessionId: 'admin-session',
      requestId: 'ban-member-2',
    },
  );
  const banned = snapshotFromGroupStateWritten(bannedWritten);
  assert.equal(bannedWritten.result.right?.event?.eventType, 'member-banned');
  assertMember(banned, 'member-2', 'member', 'banned');

  await assertPolicyRejects(
    () =>
      service.banGroupMember(TEST_SCOPE, 'group-1', 'admin-1', {
        actorPrincipalId: 'admin-1',
        actorSessionId: 'admin-session',
        requestId: 'admin-ban-admin',
      }),
    'forbidden-role',
  );
  await assertPolicyRejects(
    () =>
      service.removeGroupMember(TEST_SCOPE, 'group-1', 'member-3', {
        actorPrincipalId: 'member-3',
        actorSessionId: 'member-3-session',
        requestId: 'member-remove-member',
      }),
    'forbidden-role',
  );

  const unbannedWritten = await service.unbanGroupMember(
    TEST_SCOPE,
    'group-1',
    'member-2',
    {
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'unban-member-2',
    },
  );
  const unbanned = snapshotFromGroupStateWritten(unbannedWritten);
  assert.equal(unbannedWritten.result.right?.event?.eventType, 'member-unbanned');
  assertMember(unbanned, 'member-2', 'member', 'left');

  const promotedWritten = await service.setGroupMemberRole(
    TEST_SCOPE,
    'group-1',
    'member-3',
    {
      role: 'admin',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'promote-member-3',
    },
  );
  const promoted = snapshotFromGroupStateWritten(promotedWritten);
  assert.equal(promotedWritten.result.right?.event?.eventType, 'member-role-changed');
  assertMember(promoted, 'member-3', 'admin', 'active');

  const transferredWritten = await service.transferGroupOwnership(
    TEST_SCOPE,
    'group-1',
    {
      newOwnerPrincipalId: 'admin-1',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'transfer-owner-to-admin',
    },
  );
  const transferred = snapshotFromGroupStateWritten(transferredWritten);
  assert.equal(
    transferredWritten.result.right?.event?.eventType,
    'ownership-transferred',
  );
  assertMember(transferred, 'owner-1', 'admin', 'active');
  assertMember(transferred, 'admin-1', 'owner', 'active');
});

Deno.test('last-owner protection applies to leave remove ban and demote operations', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Owner Room',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });

  await assertPolicyRejects(
    () =>
      service.upsertMember(TEST_SCOPE, 'group-1', 'owner-1', {
        status: 'left',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'last-owner-leave',
      }),
    'last-owner',
  );
  await assertPolicyRejects(
    () =>
      service.removeGroupMember(TEST_SCOPE, 'group-1', 'owner-1', {
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'last-owner-remove',
      }),
    'last-owner',
  );
  await assertPolicyRejects(
    () =>
      service.banGroupMember(TEST_SCOPE, 'group-1', 'owner-1', {
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'last-owner-ban',
      }),
    'last-owner',
  );
  await assertPolicyRejects(
    () =>
      service.setGroupMemberRole(TEST_SCOPE, 'group-1', 'owner-1', {
        role: 'admin',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'last-owner-demote',
      }),
    'last-owner',
  );
});

Deno.test('appointDirector lets an active member become director when owner is offline', async () => {
  const syncPublisher = createRecordingStateSyncPublisher();
  const service = createTestGroupStateService(syncPublisher);
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    metadata: { keep: true },
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
    status: 'active',
    role: 'member',
    actorPrincipalId: 'owner-1',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'member-2', {
    status: 'active',
    role: 'member',
    actorPrincipalId: 'owner-1',
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'member-session', {
    generationId: 'test-generation',
    principalId: 'member-1',
    actorPrincipalId: 'member-1',
    actorSessionId: 'member-session',
    lastHeartbeatAtEpochMs: 1_000,
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });
  syncPublisher.reset();

  const written = await service.appointDirector(TEST_SCOPE, 'group-1', {
    actorPrincipalId: 'member-1',
    actorSessionId: 'member-session',
    heartbeatTtlMs: 9_000,
    requestId: 'appoint-member-1',
  });
  const appointed = snapshotFromGroupStateWritten(written);

  const appointment = readRallarGroupDirectorFromSnapshot(appointed);
  assert.equal(appointment?.principalId, 'member-1');
  assert.equal(appointment?.sessionId, 'member-session');
  assert.equal(appointment?.epoch, 1);
  assert.equal(appointment?.heartbeatTtlMs, 9_000);
  assert.equal(appointed.group.metadata.keep, true);
  assert.equal(written.result.right?.event?.eventType, 'group-updated');
  assert.equal(syncPublisher.groupSnapshots.length, 0);
  assert.equal(syncPublisher.groupEvents.length, 0);
});

Deno.test('appointDirector does not replay cached appointments to a different actor', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
    status: 'active',
    role: 'member',
    actorPrincipalId: 'owner-1',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'member-2', {
    status: 'active',
    role: 'member',
    actorPrincipalId: 'owner-1',
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'member-1-session', {
    generationId: 'test-generation',
    principalId: 'member-1',
    actorPrincipalId: 'member-1',
    actorSessionId: 'member-1-session',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'member-2-session', {
    generationId: 'test-generation',
    principalId: 'member-2',
    actorPrincipalId: 'member-2',
    actorSessionId: 'member-2-session',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });

  await service.appointDirector(TEST_SCOPE, 'group-1', {
    actorPrincipalId: 'member-1',
    actorSessionId: 'member-1-session',
    requestId: 'shared-request',
  });

  await assert.rejects(
    () =>
      service.appointDirector(TEST_SCOPE, 'group-1', {
        actorPrincipalId: 'member-2',
        actorSessionId: 'member-2-session',
        requestId: 'shared-request',
      }),
    /Group mutation command differs/,
  );
});

Deno.test('appointDirector rejects invalid heartbeat TTL values', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
    status: 'active',
    role: 'member',
    actorPrincipalId: 'owner-1',
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'member-session', {
    generationId: 'test-generation',
    principalId: 'member-1',
    actorPrincipalId: 'member-1',
    actorSessionId: 'member-session',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });

  await assert.rejects(
    () =>
      service.appointDirector(TEST_SCOPE, 'group-1', {
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
        heartbeatTtlMs: Number.NaN,
        requestId: 'invalid-ttl',
      }),
    /Invalid director heartbeat TTL/,
  );
});

Deno.test('appointDirector denies member fallback while owner is online or director is active', async () => {
  const service = createTestGroupStateService();
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Room 1',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
    status: 'active',
    role: 'member',
    actorPrincipalId: 'owner-1',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'member-2', {
    status: 'active',
    role: 'member',
    actorPrincipalId: 'owner-1',
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session', {
    generationId: 'test-generation',
    principalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'member-session', {
    generationId: 'test-generation',
    principalId: 'member-1',
    actorPrincipalId: 'member-1',
    actorSessionId: 'member-session',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });
  await service.connectPresenceSession(TEST_SCOPE, 'group-1', 'director-session', {
    generationId: 'test-generation',
    principalId: 'member-2',
    actorPrincipalId: 'member-2',
    actorSessionId: 'director-session',
    expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
  });

  await assert.rejects(
    () =>
      service.appointDirector(TEST_SCOPE, 'group-1', {
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
        requestId: 'appoint-member-owner-online',
      }),
    /Only owners\/admins can appoint while an owner\/admin is online/,
  );

  await service.disconnectPresenceSession(TEST_SCOPE, 'group-1', 'owner-session', {
    generationId: 'test-generation',
    principalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.appointDirector(TEST_SCOPE, 'group-1', {
    actorPrincipalId: 'member-2',
    actorSessionId: 'director-session',
    requestId: 'appoint-member-2',
  });

  await assert.rejects(
    () =>
      service.appointDirector(TEST_SCOPE, 'group-1', {
        actorPrincipalId: 'member-1',
        actorSessionId: 'member-session',
        requestId: 'appoint-member-director-active',
      }),
    /Cannot appoint a fallback director while another director is active/,
  );
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

  const joined = snapshotFromGroupStateWritten(
    await service.upsertMember(TEST_SCOPE, 'group-1', 'member-1', {
      status: 'active',
      role: 'member',
      actorPrincipalId: 'owner-1',
    }),
  );
  syncPublisher.reset();

  const unchangedMember = snapshotFromGroupStateWritten(
    await service.upsertMember(
      TEST_SCOPE,
      'group-1',
      'member-1',
      {
        status: 'active',
        role: 'member',
        actorPrincipalId: 'owner-1',
      },
    ),
  );
  const connected = snapshotFromGroupStateWritten(
    await service.connectPresenceSession(
      TEST_SCOPE,
      'group-1',
      'member-session',
      {
        generationId: 'test-generation',
        principalId: 'member-1',
        actorPrincipalId: 'member-1',
        lastHeartbeatAtEpochMs: 1_000,
        expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
      },
    ),
  );
  syncPublisher.reset();
  const unchangedPresence = snapshotFromGroupStateWritten(
    await service.connectPresenceSession(
      TEST_SCOPE,
      'group-1',
      'member-session',
      {
        generationId: 'test-generation',
        principalId: 'member-1',
        actorPrincipalId: 'member-1',
        lastHeartbeatAtEpochMs: 2_000,
        expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
      },
    ),
  );

  assert.equal(unchangedMember.group.rosterVersion, joined.group.rosterVersion);
  assert.equal(unchangedPresence.group.presenceVersion, connected.group.presenceVersion);
  assert.deepEqual(unchangedPresence.activeSessions, []);
  assert.equal(syncPublisher.groupSnapshots.length, 0);
  assert.equal(syncPublisher.groupEvents.length, 0);
});

function createTestGroupStateService(
  syncPublisher: StateSyncPublisher = NO_OP_SYNC_PUBLISHER,
) {
  const runtime = createTestGroupStateRuntime({
    runtimeRepository: new FakeRuntimeStateRepository(),
    syncPublisher,
    now: () => 1_000,
    serviceId: 'test-service',
  });
  return {
    ...runtime.service,
    expireExpiredPresenceSessions: runtime.maintenance.expireExpiredPresenceSessions,
  };
}

async function createGovernanceGroup(
  service: ReturnType<typeof createTestGroupStateService>,
): Promise<void> {
  await service.createGroup(TEST_SCOPE, {
    groupId: 'group-1',
    displayName: 'Governance Room',
    kind: 'room',
    createdByPrincipalId: 'owner-1',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
  });
  await service.upsertMember(TEST_SCOPE, 'group-1', 'admin-1', {
    status: 'active',
    role: 'admin',
    actorPrincipalId: 'owner-1',
    actorSessionId: 'owner-session',
    requestId: 'seed-admin-1',
  });
  for (const principalId of ['member-1', 'member-2', 'member-3']) {
    await service.upsertMember(TEST_SCOPE, 'group-1', principalId, {
      status: 'active',
      role: 'member',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: `seed-${principalId}`,
    });
  }
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
    publishGroupSnapshot: (snapshot: GroupSnapshot) => {
      groupSnapshots.push(snapshot);
      return Promise.resolve();
    },
    publishGroupEvent: (event: GroupEvent) => {
      groupEvents.push(event);
      return Promise.resolve();
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

function assertSnapshotVersion(snapshot: GroupSnapshot, expected: number): void {
  assert.equal(snapshot.group.snapshotVersion, expected);
}

function assertEventSnapshotVersion(written: GroupStateWritten, expected: number): void {
  const event = written.result.right?.event;
  if (!event) {
    throw new Error('Expected group mutation to return an event');
  }

  assert.equal(event.snapshotVersion, expected);
}

async function assertPolicyRejects(
  action: () => Promise<unknown>,
  code: GroupPolicyReasonCode,
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => {
      assert.ok(error instanceof GroupPolicyDeniedError);
      assert.equal(error.denial.code, code);
      return true;
    },
  );
}

function snapshotFromGroupStateWritten(written: GroupStateWritten): GroupSnapshot {
  const snapshot = written.result.right?.snapshot;
  if (!snapshot) {
    throw new Error(written.result.left ?? 'Expected createGroup to return a snapshot');
  }

  return snapshot;
}

function joinCodeResponseFromGroupJoinCodeWritten(
  written: Awaited<
    ReturnType<ReturnType<typeof createTestGroupStateService>['rotateGroupJoinCode']>
  >,
) {
  const response = written.result.right;
  if (!response) {
    throw new Error(written.result.left ?? 'Expected rotateGroupJoinCode to return a response');
  }

  return response;
}

class FakeRuntimeStateRepository implements RuntimeStateOptimisticTransactionalRepositoryLike {
  readonly data = new Map<string, RuntimeStateEntry>();

  async begin<T>(
    fn: (
      repository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => Promise<T>,
  ): Promise<T> {
    const before = new Map(this.data);
    try {
      return await fn(this);
    } catch (error) {
      this.data.clear();
      for (const [key, value] of before) this.data.set(key, value);
      throw error;
    }
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

  findEntriesByKeys(
    namespace: string,
    keys: readonly string[],
  ): Promise<readonly RuntimeStateEntry[]> {
    const keySet = new Set(keys);
    return Promise.resolve(
      [...this.data.entries()]
        .filter(([compositeKey]) =>
          this.toNamespace(compositeKey) === namespace &&
          keySet.has(this.toStoreKey(compositeKey))
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

  insertIfAbsent(
    namespace: string,
    key: string,
    value: string,
    expireAtTimestamp: number,
  ): Promise<RuntimeStateConditionalWriteResult> {
    const compositeKey = this.toKey(namespace, key);
    if (this.data.has(compositeKey)) {
      return Promise.resolve({ status: 'conflict' });
    }
    this.data.set(compositeKey, {
      key,
      value,
      expireAtTimestamp,
      updatedTimestamp: new Date().toISOString(),
      revision: 0,
    });
    return Promise.resolve({ status: 'applied', revision: 0 });
  }

  upsertIfRevision(
    namespace: string,
    key: string,
    value: string,
    expireAtTimestamp: number,
    expectedRevision: number,
  ): Promise<RuntimeStateConditionalWriteResult> {
    const compositeKey = this.toKey(namespace, key);
    const current = this.data.get(compositeKey);
    if (!current || current.revision !== expectedRevision) {
      return Promise.resolve({ status: 'conflict' });
    }
    this.data.set(compositeKey, {
      key,
      value,
      expireAtTimestamp,
      updatedTimestamp: new Date().toISOString(),
      revision: current.revision + 1,
    });
    return Promise.resolve({
      status: 'applied',
      revision: current.revision + 1,
    });
  }

  deleteIfRevision(
    namespace: string,
    key: string,
    expectedRevision: number,
  ): Promise<RuntimeStateConditionalWriteResult> {
    const compositeKey = this.toKey(namespace, key);
    const current = this.data.get(compositeKey);
    if (!current || current.revision !== expectedRevision) {
      return Promise.resolve({ status: 'conflict' });
    }
    this.data.delete(compositeKey);
    return Promise.resolve({
      status: 'applied',
      revision: current.revision + 1,
    });
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
