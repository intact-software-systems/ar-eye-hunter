import assert from 'node:assert/strict';
import { newALEventRoute, newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import { createApiV1RoomWsAuthorizer } from '../../src/services/ws-topic-room-authorizer.ts';

Deno.test('API room authorization reads the current scoped group snapshot', async () => {
  const snapshot = createSnapshot();
  let requestedRef: unknown;
  const authorizer = createApiV1RoomWsAuthorizer({
    readCurrentSnapshot: (ref) => {
      requestedRef = ref;
      return Promise.resolve(snapshot);
    },
  });
  const message = newALMulticastMessage(
    'session-1',
    newALEventRoute('room.chat', 'group-1', 'message-1'),
    snapshot.group,
    'chat.message.v1',
    { text: 'hello' },
  );

  const decision = await authorizer({
    message,
    roomId: 'group-1',
    roomRef: snapshot.group,
    senderId: 'session-1',
    topicId: 'room.chat',
    typeId: 'chat.message.v1',
  });

  assert.equal(decision, true);
  assert.deepEqual(requestedRef, snapshot.group);
});

Deno.test('API room authorization fails closed without a scoped group reference', async () => {
  const authorizer = createApiV1RoomWsAuthorizer({
    readCurrentSnapshot: () => Promise.resolve(createSnapshot()),
  });
  const message = {
    ...newALMulticastMessage(
      'session-1',
      newALEventRoute('room.chat', 'group-1', 'message-1'),
      createSnapshot().group,
      'chat.message.v1',
      { text: 'hello' },
    ),
    targets: undefined,
  };

  const decision = await authorizer({
    message,
    roomId: 'group-1',
    senderId: 'session-1',
    topicId: 'room.chat',
    typeId: 'chat.message.v1',
  });

  assert.equal(decision, false);
});

Deno.test('API room authorization observes remote bans and deletion across warm server caches', async () => {
  let current: GroupSnapshot | undefined = createSnapshot();
  let revisionProbes = 0;
  let stableReads = 0;
  const durable = {
    readCausalRevision: () => {
      revisionProbes += 1;
      return Promise.resolve(current?.causalRevision);
    },
    readSnapshot: () => {
      stableReads += 1;
      return Promise.resolve(current);
    },
  } as unknown as GroupStateService;
  const serverA = createCachedGroupStateService({
    durable,
    cache: createIndependentCache(() => {
      stableReads += 1;
      return Promise.resolve(current);
    }),
  });
  const serverB = createCachedGroupStateService({
    durable,
    cache: createIndependentCache(() => {
      stableReads += 1;
      return Promise.resolve(current);
    }),
  });
  const authorizer = createApiV1RoomWsAuthorizer(serverB);
  const message = newALMulticastMessage(
    'session-1',
    newALEventRoute('room.chat', 'group-1', 'message-1'),
    createSnapshot().group,
    'chat.message.v1',
    { text: 'hello' },
  );
  const input = {
    message,
    roomId: 'group-1',
    roomRef: createSnapshot().group,
    senderId: 'session-1',
    topicId: 'room.chat',
    typeId: 'chat.message.v1',
  };

  assert.equal(await authorizer(input), true);
  current = {
    ...createSnapshot(),
    stateRevision: 4,
    causalRevision: { groupRevision: 3, presenceRevision: 1 },
    members: createSnapshot().members.map((member) => ({
      ...member,
      status: 'banned' as const,
    })),
  };
  await serverA.observeSnapshot(current);

  assert.notEqual(await authorizer(input), true);
  current = undefined;
  assert.equal(await authorizer(input), false);
  assert.equal(revisionProbes, 0);
  assert.equal(stableReads, 3);
});

function createIndependentCache(
  readDurable: () => Promise<GroupSnapshot | undefined>,
) {
  let cached: GroupSnapshot | undefined;
  return {
    findOrLoadByRef: async (
      _ref: unknown,
      options: {
        minCausalRevision?: Readonly<{
          groupRevision: number;
          presenceRevision: number;
        }>;
      } = {},
    ) => {
      if (
        cached &&
        (options.minCausalRevision === undefined ||
          (cached.causalRevision.groupRevision >=
              options.minCausalRevision.groupRevision &&
            cached.causalRevision.presenceRevision >=
              options.minCausalRevision.presenceRevision))
      ) {
        return cached;
      }
      cached = await readDurable();
      return cached;
    },
    observe: (snapshot: GroupSnapshot) => {
      const observation = cached === undefined
        ? 'inserted' as const
        : snapshot.stateRevision > cached.stateRevision
        ? 'advanced' as const
        : 'duplicate' as const;
      if (observation !== 'duplicate') {
        cached = snapshot;
      }
      return observation;
    },
  };
}

function createSnapshot(): GroupSnapshot {
  return {
    stateRevision: 3,
    causalRevision: { groupRevision: 2, presenceRevision: 1 },
    group: {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'group-1',
      displayName: 'Group 1',
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      metadata: {},
      snapshotVersion: 2,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 1,
      activeMemberCount: 1,
      ownerPrincipalId: 'alice',
      created: { atEpochMs: 1 },
      updated: { atEpochMs: 2 },
    },
    members: [{
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'group-1',
      principalId: 'alice',
      role: 'owner',
      status: 'active',
      joined: { atEpochMs: 1 },
      updated: { atEpochMs: 2 },
    }],
    activeSessions: [{
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'group-1',
      principalId: 'alice',
      sessionId: 'session-1',
      generationId: 'generation-1',
      generationVersion: 1,
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 2,
      expiresAtEpochMs: Date.now() + 60_000,
    }],
    memberCount: 1,
    onlineMemberCount: 1,
  };
}
