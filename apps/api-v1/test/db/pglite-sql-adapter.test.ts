import assert from 'node:assert/strict';
import { Temporal } from '@js-temporal/polyfill';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import { PSqlCrdtLogRepository } from '@shared-server/postgres/crdt/PSqlCrdtLogRepository.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import {
  groupStateGroupStorageKey,
  groupStateMemberStorageKey,
  groupStatePresenceSessionStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { CoalescedAppOutboxWorkService } from '@shared-server/rallar-system/services/CoalescedAppOutboxWorkService.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import {
  PSqlClientStateEventRepository,
  PSqlGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
import { groupEventWorkspaceKey } from '@shared-server/postgres/rallar-system/group-event-workspace-key.ts';
import { createGroupStateEventRepository } from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { Group, GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtOperationBatch,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { createApiV1SqlClient } from '../../src/db/db.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const PAST_MS = Date.parse('2000-01-01T00:00:00.000Z');
const FUTURE_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999Z');
const PAST_INSTANT = Temporal.Instant.from('2000-01-01T00:00:00.000Z');
const CREATED_TS = Temporal.PlainDateTime.from('2026-06-01T12:00:00');

function groupFixture(ref: GroupRef, displayName: string): Group {
  const audit = { atEpochMs: 1, byServiceId: 'pglite-hierarchy-test' } as const;
  return {
    ...ref,
    displayName,
    kind: 'room',
    status: 'active',
    joinMode: 'open',
    metadata: {},
    activeMemberCount: 1,
    ownerPrincipalId: 'alice',
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    created: audit,
    updated: audit,
  };
}

Deno.test('group event workspace keys preserve ordinary values and isolate sentinels and lookalikes', () => {
  const workspaces = [undefined, '_', '%5F', 'main', 'a:b', 'a%3Ab', '＿'];
  const keys = workspaces.map(groupEventWorkspaceKey);
  assert.equal(groupEventWorkspaceKey(undefined), '_');
  assert.equal(groupEventWorkspaceKey('_'), '%5F');
  assert.equal(groupEventWorkspaceKey('main'), 'main');
  assert.equal(new Set(keys).size, workspaces.length);
});

Deno.test('PGlite SQL adapter supports tagged templates, array interpolation, and transactions', async () => {
  await withPGliteSql(async (sql) => {
    const scalarRows = await sql<{ value: number }[]>`
            select ${1}::int as value
        `;

    assert.deepEqual(scalarRows, [{ value: 1 }]);

    const arrayRows = await sql<{ value: string }[]>`
            select value
            from (values ('a'), ('b'), ('c')) as t(value)
            where value in ${sql(['a', 'c'])}
            order by value
        `;

    assert.deepEqual(arrayRows, [{ value: 'a' }, { value: 'c' }]);

    await assert.rejects(
      async () => {
        await sql.begin(async (tx) => {
          await tx`
                        insert into runtime_state_store (store_namespace,
                                                         store_key,
                                                         store_value,
                                                         expire_at_ts)
                        values (${'tx'}, ${'rollback'}, ${'value'}, ${new Date(FUTURE_MS)})
                    `;
          throw new Error('rollback smoke');
        });
      },
      /rollback smoke/,
    );

    const rowsAfterRollback = await sql<{ count: string }[]>`
            select count(*)
            from runtime_state_store
            where store_namespace = ${'tx'}
        `;

    assert.equal(Number(rowsAfterRollback[0].count), 0);
  });
});

Deno.test('PSqlRuntimeStateRepository runs against PGlite SQL adapter', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlRuntimeStateRepository(sql);

    await repository.upsert('runtime-smoke', 'b', '{"value":2}', FUTURE_MS);
    await repository.upsert('runtime-smoke', 'a', '{"value":1}', FUTURE_MS);
    await repository.upsert('runtime-smoke', 'a', '{"value":3}', FUTURE_MS);

    const entry = await repository.findEntry('runtime-smoke', 'a');
    assert.equal(entry?.value, '{"value":3}');
    assert.equal(entry?.revision, 1);
    assert.match(entry?.updatedTimestamp ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

    const allEntries = await repository.findAllEntries('runtime-smoke');
    assert.deepEqual(allEntries.map((row) => row.key), ['a', 'b']);

    const prefixedEntries = await repository.findEntriesByPrefix('runtime-smoke', 'a');
    assert.deepEqual(prefixedEntries.map((row) => row.key), ['a']);
    const keyedEntries = await repository.findEntriesByKeys(
      'runtime-smoke',
      ['b', 'missing', 'a', 'b'],
    );
    assert.deepEqual(keyedEntries.map((row) => row.key), ['a', 'b']);

    await assert.rejects(
      async () => {
        await repository.begin(async (txRepository) => {
          await txRepository.lockKey('runtime-smoke', 'rollback');
          await txRepository.upsert('runtime-smoke', 'rollback', 'value', FUTURE_MS);
          throw new Error('rollback runtime state');
        });
      },
      /rollback runtime state/,
    );
    assert.equal(await repository.findEntry('runtime-smoke', 'rollback'), undefined);

    await repository.upsert('runtime-smoke', 'expired', 'expired', PAST_MS);
    assert.equal(await repository.deleteExpired('runtime-smoke'), 1);
    assert.equal(await repository.findEntry('runtime-smoke', 'expired'), undefined);
  });
});

Deno.test('PGlite runtime-state transactions isolate nested savepoint rollback', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlRuntimeStateRepository(sql);

    await repository.begin(async (outer) => {
      await outer.upsert('nested-tx', 'outer', 'outer', FUTURE_MS);
      await assert.rejects(
        async () => {
          await outer.begin(async (inner) => {
            await inner.upsert('nested-tx', 'rolled-back', 'rolled-back', FUTURE_MS);
            throw new Error('rollback nested savepoint');
          });
        },
        /rollback nested savepoint/,
      );
      assert.equal(await outer.findEntry('nested-tx', 'rolled-back'), undefined);

      await outer.begin(async (inner) => {
        await inner.upsert('nested-tx', 'committed', 'committed', FUTURE_MS);
      });
    });

    assert.equal((await repository.findEntry('nested-tx', 'outer'))?.value, 'outer');
    assert.equal((await repository.findEntry('nested-tx', 'committed'))?.value, 'committed');
    assert.equal(await repository.findEntry('nested-tx', 'rolled-back'), undefined);
  });
});

Deno.test('PSqlRuntimeStateRepository treats encoded prefix characters literally', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlRuntimeStateRepository(sql);
    const literalPrefix = 'app=ops%2Fapp:ws=workspace%3Ablue';
    const wildcardCollisionPrefix = 'app=opsZZ2Fapp:ws=workspaceZZ3Ablue';

    await repository.upsert(
      'runtime-prefix',
      `${literalPrefix}:group=room-a`,
      '{"room":"a"}',
      FUTURE_MS,
    );
    await repository.upsert(
      'runtime-prefix',
      `${literalPrefix}:group=room-b`,
      '{"room":"b"}',
      FUTURE_MS,
    );
    await repository.upsert(
      'runtime-prefix',
      `${wildcardCollisionPrefix}:group=room-b`,
      '{"room":"b"}',
      FUTURE_MS,
    );

    const entries = await repository.findEntriesByPrefix(
      'runtime-prefix',
      `${literalPrefix}:`,
    );
    const firstPage = await repository.findEntriesByPrefixPage(
      'runtime-prefix',
      `${literalPrefix}:`,
      { limit: 1 },
    );
    const secondPage = await repository.findEntriesByPrefixPage(
      'runtime-prefix',
      `${literalPrefix}:`,
      {
        afterKey: `${literalPrefix}:group=room-a`,
        limit: 1,
      },
    );

    assert.deepEqual(entries.map((entry) => entry.key), [
      `${literalPrefix}:group=room-a`,
      `${literalPrefix}:group=room-b`,
    ]);
    assert.deepEqual(firstPage.map((entry) => entry.key), [
      `${literalPrefix}:group=room-a`,
    ]);
    assert.deepEqual(secondPage.map((entry) => entry.key), [
      `${literalPrefix}:group=room-b`,
    ]);
  });
});

Deno.test('PGlite runtime-state hierarchy isolates sibling key segments', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const clients = new ClientStateRepository(runtime);
    const groups = new GroupStateRepository(runtime);

    assert.equal((await clients.insertPrincipal({
      applicationId: 'app',
      workspaceId: 'foo',
      principalId: 'alice',
      presenceVersion: 1,
    } as never)).status, 'applied');
    assert.equal((await clients.insertPrincipal({
      applicationId: 'app',
      workspaceId: 'foobar',
      principalId: 'bob',
      presenceVersion: 1,
    } as never)).status, 'applied');
    await groups.putGroup(groupFixture({
      applicationId: 'app',
      workspaceId: 'foo',
      groupId: 'room',
    }, 'Foo room'));
    await groups.putGroup(groupFixture({
      applicationId: 'app',
      workspaceId: 'foobar',
      groupId: 'room',
    }, 'Foobar room'));

    assert.deepEqual(
      (await clients.listPrincipals({ applicationId: 'app', workspaceId: 'foo' }))
        .map((value) => value.workspaceId),
      ['foo'],
    );
    assert.deepEqual(
      (await groups.listGroups({ applicationId: 'app', workspaceId: 'foo' }))
        .map((value) => value.workspaceId),
      ['foo'],
    );
  });
});

Deno.test('PGlite group-state reads fail closed on a directly seeded legacy wrong-scope row', async () => {
  await withPGliteSql(async (sql) => {
    const ref = {
      applicationId: 'pglite-legacy-scope-app',
      groupId: 'pglite-legacy-scope-group',
    };
    const storedGroup = {
      ...ref,
      workspaceId: '_',
      displayName: 'Legacy explicit sentinel',
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      metadata: {},
      activeMemberCount: 0,
      ownerPrincipalId: 'owner',
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 0,
      created: { atEpochMs: 1_000 },
      updated: { atEpochMs: 1_000 },
    };
    await sql`
      insert into runtime_state_store (
        store_namespace, store_key, store_value, expire_at_ts
      ) values (
        'group-state:groups',
        'app=pglite-legacy-scope-app:ws=_:group=pglite-legacy-scope-group',
        ${JSON.stringify(storedGroup)},
        ${new Date(FUTURE_MS)}
      )
    `;
    const repository = new GroupStateRepository(
      new PSqlRuntimeStateRepository(sql),
    );

    for (
      const read of [
        () => repository.findGroup(ref),
        () => repository.readSnapshot(ref),
        () => repository.listGroups({ applicationId: ref.applicationId }),
        () => repository.listSnapshots({ applicationId: ref.applicationId }),
        () =>
          repository.listSnapshotsPage(
            { applicationId: ref.applicationId },
            { limit: 10 },
          ),
      ]
    ) {
      await assert.rejects(read, (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-repository-invariant-corruption');
    }
  });
});

Deno.test('PGlite group-state reads reject complete-contract corruption across public boundaries', async () => {
  await withPGliteSql(async (sql) => {
    const cases = [
      { kind: 'group', namespace: 'group-state:groups', field: 'joinMode' },
      { kind: 'member', namespace: 'group-state:members', field: 'status' },
      { kind: 'session', namespace: 'group-state:sessions', field: 'generationId' },
      {
        kind: 'summary',
        namespace: 'group-state:presence-summaries',
        field: 'causalRevision',
      },
    ] as const;

    for (const testCase of cases) {
      const scope = {
        applicationId: `pglite-complete-${testCase.kind}`,
        workspaceId: 'main',
      };
      const ref = { ...scope, groupId: `group-${testCase.kind}` };
      const authority = {
        clientId: 'alice',
        sessionId: `alice-session-${testCase.kind}`,
        accessToken: `alice-token-${testCase.kind}`,
        username: 'alice',
        issuedAtEpochMs: 1,
        expiresAtEpochMs: 100_000,
      };
      let eventSequence = 0;
      const runtime = new PSqlRuntimeStateRepository(sql);
      const service = createGroupStateService({
        runtimeRepository: runtime,
        createGroupStateEventStore: createGroupStateEventRepository,
        authSessionRepository: {
          findBySessionId: (sessionId) =>
            Promise.resolve(sessionId === authority.sessionId ? authority : undefined),
        },
        now: () => 10_000,
        randomId: () => `event-${testCase.kind}-${eventSequence++}`,
        sleep: () => Promise.resolve(),
        serviceId: `pglite-complete-${testCase.kind}`,
      });
      await service.createGroup(scope, {
        groupId: ref.groupId,
        displayName: `Complete ${testCase.kind}`,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `create-${testCase.kind}`,
      }, authority);
      if (testCase.kind === 'session') {
        await service.connectPresenceSession(
          scope,
          ref.groupId,
          authority.sessionId,
          {
            principalId: 'alice',
            generationId: `generation-${testCase.kind}`,
            connectedAtEpochMs: 10_000,
            lastHeartbeatAtEpochMs: 10_000,
            expiresAtEpochMs: 4_102_444_800_000,
            actorPrincipalId: 'alice',
            actorSessionId: authority.sessionId,
            requestId: `connect-${testCase.kind}`,
          },
          authority,
        );
      }

      const storageKey = testCase.kind === 'member'
        ? groupStateMemberStorageKey({ ...ref, principalId: 'alice' })
        : testCase.kind === 'session'
        ? groupStatePresenceSessionStorageKey({ ...ref, sessionId: authority.sessionId })
        : groupStateGroupStorageKey(ref);
      await sql`
        update runtime_state_store
        set store_value = (store_value::jsonb - ${testCase.field})::text
        where store_namespace = ${testCase.namespace}
          and store_key = ${storageKey}
      `;

      const repository = new GroupStateRepository(runtime);
      const reads = testCase.kind === 'group'
        ? [
          () => repository.findGroup(ref),
          () => repository.listGroups(scope),
          () => repository.readSnapshot(ref),
          () => repository.listSnapshots(scope),
          () => repository.listSnapshotsPage(scope, { limit: 10 }),
        ]
        : testCase.kind === 'member'
        ? [
          () => repository.findMember({ ...ref, principalId: 'alice' }),
          () => repository.listMembers(ref),
          () => repository.readSnapshot(ref),
          () => repository.listSnapshots(scope),
          () => repository.listSnapshotsPage(scope, { limit: 10 }),
        ]
        : testCase.kind === 'session'
        ? [
          () => repository.findPresenceSession({ ...ref, sessionId: authority.sessionId }),
          () => repository.listPresenceSessions(ref),
          () => repository.listAllPresenceSessions(),
          () => repository.readSnapshot(ref),
          () => repository.listSnapshots(scope),
          () => repository.listSnapshotsPage(scope, { limit: 10 }),
        ]
        : [
          () => repository.findPresenceSummaryEntry(ref),
          () => repository.readSnapshot(ref),
          () => repository.listSnapshots(scope),
          () => repository.listSnapshotsPage(scope, { limit: 10 }),
        ];
      for (const [readIndex, read] of reads.entries()) {
        await assert.rejects(read, (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'group-state-repository-invariant-corruption',
          `${testCase.kind} public read ${readIndex} accepted a corrupt persisted record`);
      }
    }
  });
});

Deno.test('PSql state event repositories page by snapshot cursor order', async () => {
  await withPGliteSql(async (sql) => {
    const clientEvents = new PSqlClientStateEventRepository(sql);
    const groupEvents = new PSqlGroupStateEventRepository(sql);
    const clientRef = {
      applicationId: 'rallar-test',
      workspaceId: 'main',
      principalId: 'principal-1',
    };
    const groupRef = {
      applicationId: 'rallar-test',
      workspaceId: 'main',
      groupId: 'room-1',
    };

    await clientEvents.appendClientEvent(
      createClientStateEvent('client-late-snapshot', 1_000, 30),
    );
    await clientEvents.appendClientEvent(
      createClientStateEvent('client-early-snapshot', 2_000, 10),
    );
    await clientEvents.appendClientEvent(
      createClientStateEvent('client-middle-snapshot', 3_000, 20),
    );
    await clientEvents.appendClientEvent(
      createClientStateEvent('client-filtered', 4_000, 40, 'session-disconnected'),
    );
    await clientEvents.appendClientEvent(
      createClientStateEvent('client-filtered', 5_000, 50, 'session-disconnected', {
        reason: 'updated',
      }),
    );

    const firstClientPage = await clientEvents.listClientEventPage(
      clientRef,
      { limit: 2 },
    );
    const secondClientPage = await clientEvents.listClientEventPage(
      clientRef,
      {
        limit: 2,
        after: firstClientPage.nextCursor,
      },
    );
    const filteredClientPage = await clientEvents.listClientEventPage(
      clientRef,
      {
        eventTypes: ['session-disconnected'],
        limit: 1,
      },
    );
    const recentClientEvents = await clientEvents.listRecentClientEvents(
      clientRef,
      { limit: 2 },
    );
    const recentFilteredClientEvents = await clientEvents.listRecentClientEvents(
      clientRef,
      {
        eventTypes: ['session-disconnected'],
        limit: 1,
        after: firstClientPage.nextCursor,
      },
    );

    assert.deepEqual(
      firstClientPage.events.map((event) => event.eventId),
      ['client-early-snapshot', 'client-middle-snapshot'],
    );
    assert.equal(firstClientPage.hasMore, true);
    assert.deepEqual(
      secondClientPage.events.map((event) => event.eventId),
      ['client-late-snapshot', 'client-filtered'],
    );
    assert.equal(secondClientPage.hasMore, false);
    assert.equal(filteredClientPage.events[0].reason, undefined);
    assert.deepEqual(filteredClientPage.nextCursor, {
      snapshotVersion: 40,
      occurredAtEpochMs: 4_000,
      eventId: 'client-filtered',
    });
    assert.deepEqual(
      (await clientEvents.listClientEvents(clientRef)).map((event) => event.eventId),
      [
        'client-early-snapshot',
        'client-middle-snapshot',
        'client-late-snapshot',
        'client-filtered',
      ],
    );
    assert.deepEqual(
      recentClientEvents.map((event) => event.eventId),
      ['client-late-snapshot', 'client-filtered'],
    );
    assert.deepEqual(
      recentFilteredClientEvents.map((event) => event.eventId),
      ['client-filtered'],
    );

    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-late-snapshot', 1_000, 30),
    );
    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-early-snapshot', 2_000, 10),
    );
    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-middle-snapshot', 3_000, 20),
    );
    const firstDuplicate = createGroupStateEvent(
      'group-duplicate',
      4_000,
      40,
      'member-left',
    );
    await groupEvents.appendGroupEvent(firstDuplicate);
    for (
      const duplicate of [
        structuredClone(firstDuplicate),
        createGroupStateEvent('group-duplicate', 5_000, 50, 'member-left', {
          reason: 'updated',
        }),
      ]
    ) {
      await assert.rejects(
        () => groupEvents.appendGroupEvent(duplicate),
        (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'group-state-event-collision',
      );
    }

    const firstGroupPage = await groupEvents.listGroupEventPage(groupRef, {
      limit: 2,
    });
    const secondGroupPage = await groupEvents.listGroupEventPage(groupRef, {
      limit: 2,
      after: firstGroupPage.nextCursor,
    });
    const recentGroupEvents = await groupEvents.listRecentGroupEvents(
      groupRef,
      { limit: 2 },
    );

    assert.deepEqual(
      firstGroupPage.events.map((event) => event.eventId),
      ['group-early-snapshot', 'group-middle-snapshot'],
    );
    assert.equal(firstGroupPage.hasMore, true);
    assert.deepEqual(
      secondGroupPage.events.map((event) => event.eventId),
      ['group-late-snapshot', 'group-duplicate'],
    );
    assert.equal(secondGroupPage.hasMore, false);
    assert.equal(secondGroupPage.events[1]?.reason, undefined);
    assert.deepEqual(secondGroupPage.nextCursor, {
      snapshotVersion: 40,
      occurredAtEpochMs: 4_000,
      eventId: 'group-duplicate',
    });
    assert.deepEqual(
      recentGroupEvents.map((event) => event.eventId),
      ['group-late-snapshot', 'group-duplicate'],
    );
  });
});

Deno.test('PSql group events isolate absent and explicit sentinel workspaces without event-id loss', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const absentRef = {
      applicationId: 'group-event-scope-app',
      groupId: 'shared-group',
    };
    const explicitSentinelRef = { ...absentRef, workspaceId: '_' };
    const absentEvent = createGroupStateEvent('shared-event', 1_000, 1, 'group-updated', {
      ...absentRef,
      workspaceId: undefined,
      reason: 'absent',
    });
    const explicitSentinelEvent = createGroupStateEvent(
      'shared-event',
      2_000,
      2,
      'group-updated',
      {
        ...explicitSentinelRef,
        reason: 'explicit-sentinel',
      },
    );

    await repository.appendGroupEvent(absentEvent);
    await repository.appendGroupEvent(explicitSentinelEvent);

    for (
      const [ref, expected] of [
        [absentRef, JSON.parse(JSON.stringify(absentEvent)) as GroupEvent],
        [explicitSentinelRef, explicitSentinelEvent],
      ] as const
    ) {
      assert.deepEqual(await repository.listGroupEvents(ref), [expected]);
      assert.deepEqual(await repository.listRecentGroupEvents(ref), [expected]);
      assert.deepEqual(
        (await repository.listGroupEventPage(ref, { limit: 1 })).events,
        [expected],
      );
    }

    const rows = await sql<{ workspace_key: string }[]>`
      select workspace_key
      from group_state_events
      where application_id = ${absentRef.applicationId}
        and group_id = ${absentRef.groupId}
        and event_id = ${absentEvent.eventId}
      order by workspace_key
    `;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.workspace_key, rows[1]?.workspace_key);
  });
});

Deno.test('PGlite group event collision rolls back the authoritative mutation transaction', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const eventIds = ['seed-event', 'colliding-event'];
    const authority = {
      clientId: 'alice',
      sessionId: 'alice-session',
      accessToken: 'test-token',
      username: 'alice',
      issuedAtEpochMs: 1,
      expiresAtEpochMs: 100_000,
    };
    const service = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: createGroupStateEventRepository,
      authSessionRepository: {
        findBySessionId: (sessionId) =>
          Promise.resolve(sessionId === authority.sessionId ? authority : undefined),
      },
      now: () => 10_000,
      randomId: () => eventIds.shift() ?? 'unexpected-event-id',
      sleep: () => Promise.resolve(),
      serviceId: 'pglite-group-service',
    });
    const scope = { applicationId: 'collision-app', workspaceId: 'main' };
    const ref = { ...scope, groupId: 'collision-group' };
    await service.createGroup(scope, {
      groupId: ref.groupId,
      displayName: 'Before collision',
      kind: 'room',
      joinMode: 'open',
      createdByPrincipalId: 'alice',
      requestId: 'seed-collision-group',
    }, authority);
    await new PSqlGroupStateEventRepository(sql).appendGroupEvent(
      createGroupStateEvent('colliding-event', 9_000, 99, 'group-updated', {
        ...ref,
        requestId: 'preexisting-event',
      }),
    );

    await assert.rejects(
      () =>
        service.updateGroup(scope, ref.groupId, {
          displayName: 'Must roll back',
          actorPrincipalId: 'alice',
          requestId: 'collision-request',
        }, authority),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-collision',
    );

    const repository = new GroupStateRepository(runtime);
    assert.equal((await repository.findGroup(ref))?.displayName, 'Before collision');
    assert.equal(
      await repository.findIdempotentGroupMutationReceipt(ref, 'collision-request'),
      undefined,
    );
    const collisionOutbox = (await runtime.findAllEntries('state-mutation:outbox'))
      .map((entry) => JSON.parse(entry.value) as { commandId?: string })
      .filter((record) => record.commandId === 'collision-request');
    assert.deepEqual(collisionOutbox, []);
    const collisionRows = await sql<{ count: string }[]>`
      select count(*) as count
      from group_state_events
      where application_id = ${ref.applicationId}
        and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
        and group_id = ${ref.groupId}
        and event_id = 'colliding-event'
    `;
    assert.equal(Number(collisionRows[0]?.count), 1);
  });
});

Deno.test('PSql group event reads fail closed on a legacy wrong-scope payload', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const absentRef = {
      applicationId: 'legacy-group-event-app',
      groupId: 'legacy-group-event-group',
    };
    const corruptEvent = createGroupStateEvent('legacy-event', 1_000, 1, 'group-updated', {
      ...absentRef,
      workspaceId: '_',
    });
    await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      ) values (
        ${absentRef.applicationId}, '_', ${absentRef.groupId},
        ${corruptEvent.eventId}, ${corruptEvent.eventType},
        ${corruptEvent.snapshotVersion}, ${corruptEvent.occurredAtEpochMs},
        ${JSON.stringify(corruptEvent)}
      )
    `;

    for (
      const read of [
        () => repository.listGroupEvents(absentRef),
        () => repository.listRecentGroupEvents(absentRef),
        () => repository.listGroupEventPage(absentRef, { limit: 10 }),
      ]
    ) {
      await assert.rejects(read, (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-repository-invariant-corruption');
    }
  });
});

Deno.test('PSql group event reads validate the decoded event-id slot', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const ref = {
      applicationId: 'group-event-slot-app',
      workspaceId: 'main',
      groupId: 'group-event-slot-group',
    };
    const event = createGroupStateEvent('payload-event-id', 1_000, 1, 'group-updated', ref);
    await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      ) values (
        ${ref.applicationId}, ${ref.workspaceId}, ${ref.groupId},
        'physical-event-id', ${event.eventType}, ${event.snapshotVersion},
        ${event.occurredAtEpochMs}, ${JSON.stringify(event)}
      )
    `;

    await assert.rejects(
      () => repository.listGroupEvents(ref),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-repository-invariant-corruption',
    );
  });
});

Deno.test('PSql group events enforce the complete event contract and physical columns', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const baseRef = {
      applicationId: 'group-event-complete-contract-app',
      workspaceId: 'main',
      groupId: 'group-event-complete-contract-group',
    };
    const baseEvent = createGroupStateEvent(
      'complete-contract-event',
      1_000,
      1,
      'group-updated',
      baseRef,
    );
    const missingActor = structuredClone(baseEvent) as Record<string, unknown>;
    delete missingActor.actor;

    await assert.rejects(
      () => repository.appendGroupEvent(missingActor as unknown as GroupEvent),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-repository-invariant-corruption',
    );

    const cases = [
      { suffix: 'missing-actor', payload: missingActor },
      {
        suffix: 'event-type',
        payload: { ...baseEvent, eventType: 'group-archived' },
      },
      {
        suffix: 'snapshot-version',
        payload: { ...baseEvent, snapshotVersion: 2 },
      },
      {
        suffix: 'occurred-at',
        payload: { ...baseEvent, occurredAtEpochMs: 2_000 },
      },
    ];

    for (const testCase of cases) {
      const ref = { ...baseRef, groupId: `${baseRef.groupId}-${testCase.suffix}` };
      const payload = {
        ...testCase.payload,
        groupId: ref.groupId,
        eventId: `${baseEvent.eventId}-${testCase.suffix}`,
      };
      await sql`
        insert into group_state_events (
          application_id, workspace_key, group_id, event_id, event_type,
          snapshot_version, occurred_at_epoch_ms, event_json
        ) values (
          ${ref.applicationId}, ${groupEventWorkspaceKey(ref.workspaceId)},
          ${ref.groupId}, ${payload.eventId}, ${baseEvent.eventType},
          ${baseEvent.snapshotVersion}, ${baseEvent.occurredAtEpochMs},
          ${JSON.stringify(payload)}
        )
      `;

      for (const read of [
        () => repository.listGroupEvents(ref),
        () => repository.listRecentGroupEvents(ref),
        () => repository.listGroupEventPage(ref, { limit: 10 }),
      ]) {
        await assert.rejects(read, (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'group-state-event-repository-invariant-corruption');
      }
    }
  });
});

Deno.test('ResourceInboxRepository and ResourceInboxResultsRepository run against PGlite SQL adapter', async () => {
  await withPGliteSql(async (sql) => {
    const inbox = new ResourceInboxRepository(sql);
    const results = new ResourceInboxResultsRepository(sql);
    const active = createResourceEntry('active-1', {
      payload: { text: 'active' },
      typeId: 'TYPE_A',
    });
    const expired = createResourceEntry('expired-1', {
      payload: { text: 'expired' },
      typeId: 'TYPE_A',
      expiryTs: PAST_INSTANT,
    });

    const stored = await inbox.write(active);
    assert.ok(stored.db?.id);
    await inbox.write(expired);

    assert.equal((await inbox.findByKey(active.key))?.key.resourceId, 'active-1');
    assert.equal(await inbox.findByKey(expired.key), null);
    assert.equal(
      await inbox.isEntriesToLock(
        new Set(['TYPE_A']),
        new Set([EntityStatus.NEW]),
      ),
      true,
    );

    const locked = await inbox.begin((txInbox) =>
      txInbox.findEntriesSkipLocked(
        new Set(['TYPE_A']),
        new Set([EntityStatus.NEW]),
        10,
      )
    );
    assert.equal(locked.size, 1);
    assert.equal([...locked.values()][0].key.resourceId, 'active-1');

    const reserved = await inbox.startProcessingEntity(active);
    assert.equal(reserved.right?.status, EntityStatus.RESERVED);
    assert.equal(reserved.right?.dequeueAudit.attempts, 1);

    assert.equal(await inbox.updateResourceEntry(active.key, EntityStatus.COMPLETED), 1);
    assert.equal((await inbox.findByKey(active.key))?.status, EntityStatus.COMPLETED);
    assert.equal(await inbox.deleteExpired(), 1);

    const resultEntry = createResourceEntry('result-1', {
      topicId: 'result-topic',
      typeId: 'RESULT',
      status: EntityStatus.COMPLETED,
      payload: { text: 'result' },
    });
    const activeResult = await results.writeIfAbsentOrReplaceExpired(resultEntry);
    assert.equal(activeResult.key.resourceId, 'result-1');

    const replacedResult = await results.replace(
      createResourceEntry('result-1', {
        topicId: 'result-topic',
        typeId: 'RESULT',
        status: EntityStatus.FAILED,
        payload: { text: 'result-updated' },
      }),
    );
    assert.equal(replacedResult.status, EntityStatus.FAILED);
    assert.deepEqual(JSON.parse(replacedResult.resource), { text: 'result-updated' });

    await results.replace(
      createResourceEntry('result-expired', {
        topicId: 'result-topic',
        typeId: 'RESULT',
        status: EntityStatus.COMPLETED,
        expiryTs: PAST_INSTANT,
      }),
    );
    assert.equal(await results.deleteExpired(), 1);
    assert.equal(await inbox.deleteByKey(active.key), true);
  });
});

Deno.test('Coalesced APP_OUTBOX RTC topology work fits the durable resource inbox key columns', async () => {
  await withPGliteSql(async (sql) => {
    const queue = new PSqlQueueBox(new ResourceInboxRepository(sql));
    const service = new CoalescedAppOutboxWorkService(
      new OutboxQueueReader(queue),
      'rallar-server-instance-with-a-long-identity',
      () => 500,
    );
    const groupId = 'rallar-bb-group-chromium-w0-configured-live-distributed-run-1234567890';
    const overlayId = JSON.stringify(['rallar-server', 'default', groupId]);
    const contextId = `rallar-server:default:${groupId}`;

    const result = await service.enqueue({
      type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
      topicId: 'app-outbox.rtc-topology',
      resourceId: overlayId,
      contextId,
      data: { overlayId },
    });
    const updated = await service.enqueue({
      type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
      topicId: 'app-outbox.rtc-topology',
      resourceId: overlayId,
      contextId,
      data: { overlayId, revision: 2 },
      reason: 'rtt',
    });
    const stored = await queue.getItem(updated.entry.key);
    const rowCount = await sql<{ count: string }[]>`
      select count(*) as count
      from resource_inbox
      where fk_ext_bank_id = ${updated.entry.key.contextId}
        and ri_resource_id = ${updated.entry.key.resourceId}
        and ri_topic_id = ${updated.entry.key.topicId}
    `;

    assert.ok(stored);
    assert.equal(stored.typeId, 'APP_OUTBOX');
    assert.equal(result.action, 'inserted');
    assert.equal(updated.action, 'updated');
    assert.equal(Number(rowCount[0].count), 1);
    assert.ok(stored.key.topicId.length <= 36);
    assert.ok(stored.key.resourceId.length <= 36);
    assert.ok(stored.key.contextId.length <= 35);
    assert.ok(stored.audit.createdBy.length <= 16);
    assert.deepEqual(service.readEnvelope(stored), updated.envelope);
    assert.equal(updated.envelope.resourceId, overlayId);
    assert.equal(updated.envelope.contextId, contextId);
    assert.equal(updated.envelope.data.revision, 2);
  });
});

Deno.test('PSqlAppDataRepository runs against PGlite SQL adapter', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlAppDataRepository(sql);

    await repository.upsert({
      namespace: 'app-smoke',
      storeName: 'store',
      key: 'alpha',
      value: { count: 1 },
      schemaVersion: 1,
      expireAtTimestamp: FUTURE_MS,
    });
    await repository.upsert({
      namespace: 'app-smoke',
      storeName: 'store',
      key: 'alpha',
      value: { count: 2 },
      schemaVersion: 2,
      expireAtTimestamp: FUTURE_MS,
    });
    await repository.upsert({
      namespace: 'app-smoke',
      storeName: 'store',
      key: 'beta',
      value: { count: 3 },
      schemaVersion: 1,
      expireAtTimestamp: FUTURE_MS,
    });
    await repository.upsert({
      namespace: 'app-smoke',
      storeName: 'store',
      key: 'expired',
      value: { count: 4 },
      schemaVersion: 1,
      expireAtTimestamp: PAST_MS,
    });

    const alpha = await repository.findEntry('app-smoke', 'store', 'alpha');
    assert.deepEqual(alpha?.value, { count: 2 });
    assert.equal(alpha?.schemaVersion, 2);
    assert.equal(alpha?.revision, 1);

    const prefixed = await repository.findEntries('app-smoke', 'store', 'a');
    assert.deepEqual(prefixed.map((entry) => entry.key), ['alpha']);
    const firstPage = await repository.findEntriesPage('app-smoke', 'store', {
      limit: 1,
    });
    const secondPage = await repository.findEntriesPage('app-smoke', 'store', {
      afterKey: firstPage.at(-1)?.key,
      limit: 10,
    });
    const prefixedPage = await repository.findEntriesPage('app-smoke', 'store', {
      keyPrefix: 'a',
      limit: 10,
    });

    assert.deepEqual(firstPage.map((entry) => entry.key), ['alpha']);
    assert.deepEqual(secondPage.map((entry) => entry.key), ['beta', 'expired']);
    assert.deepEqual(prefixedPage.map((entry) => entry.key), ['alpha']);

    assert.equal(await repository.deleteExpired('app-smoke', 'store'), 1);
    assert.equal(await repository.deleteByKey('app-smoke', 'store', 'beta'), true);
    assert.equal(await repository.findEntry('app-smoke', 'store', 'beta'), undefined);
  });
});

Deno.test('PSqlCrdtLogRepository runs against PGlite SQL adapter', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtLogRepository(sql, {
      now: () => 2_000,
      serverId: 'server-a',
    });
    const first = createCrdtUpdate('update-1');
    const second = createCrdtUpdate('update-2');

    await assert.rejects(
      repository.updateDocumentLifecycle({
        document: CRDT_DOCUMENT_REF,
        lifecycle: 'destroy',
      } as never),
      { message: 'Unsupported CRDT lifecycle: destroy' },
    );
    assert.equal(await repository.readDocumentMetadata(CRDT_DOCUMENT_REF), undefined);

    const accepted = await repository.append(toCrdtAppendInput(first));
    const duplicate = await repository.append(toCrdtAppendInput(first));
    await repository.append(toCrdtAppendInput(second));
    const storedBytes = await readCrdtStoredUpdateBytes(sql, CRDT_DOCUMENT_REF);

    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.status === 'accepted' && accepted.append.appendSequence, 1);
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(
      duplicate.status === 'duplicate' && duplicate.append.appendSequence,
      1,
    );
    assert.equal(
      storedBytes,
      byteLengthOfSerializedJson(JSON.stringify(first)) +
        byteLengthOfSerializedJson(JSON.stringify(second)),
    );

    const page = await repository.listAfter({
      document: CRDT_DOCUMENT_REF,
      limit: 1,
    });
    const nextPage = await repository.listAfter({
      document: CRDT_DOCUMENT_REF,
      afterCursor: page.nextCursor,
      limit: 10,
    });

    assert.deepEqual(page.records.map((record) => record.update.updateId), [
      'update-1',
    ]);
    assert.equal(page.nextCursor, 'seq:1');
    assert.equal(page.hasMore, true);
    assert.deepEqual(nextPage.records.map((record) => record.update.updateId), [
      'update-2',
    ]);

    const snapshot: RallarCrdtSnapshotEnvelope = {
      protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
      document: CRDT_DOCUMENT_REF,
      snapshotId: 'snapshot-1',
      schemaVersion: 1,
      createdAtEpochMs: 2_500,
      maxLamport: 2,
      includedUpdateIds: ['update-1', 'update-2'],
      value: {
        title: 'Title update-2',
      },
      metadata: {
        updateCount: 2,
      },
    };
    await repository.writeSnapshot({
      snapshot,
      appendSequence: 2,
    });
    assert.deepEqual(await repository.readSnapshot(CRDT_DOCUMENT_REF), snapshot);

    const list = await repository.listDocuments({
      documentType: 'checklist',
    });
    const debugBundle = await repository.exportDebugBundle(CRDT_DOCUMENT_REF, {
      reason: 'pglite-test',
    });
    const backup = await repository.exportBackupBundle(CRDT_DOCUMENT_REF);
    const integrity = await repository.verifyIntegrity(CRDT_DOCUMENT_REF);

    assert.equal(list.documents.length, 1);
    assert.equal(debugBundle.integrity.updateCount, 2);
    assert.equal(backup?.integrity.updateCount, 2);
    assert.equal(integrity.valid, true);

    await withPGliteSql(async (restoreSql) => {
      const restoreRepository = new PSqlCrdtLogRepository(restoreSql, {
        now: () => 4_000,
        serverId: 'restore-server',
      });
      const restored = await restoreRepository.restoreBackupBundle(backup!);

      assert.equal(restored.restoredUpdateCount, 2);
      assert.equal(restored.firstAppendSequence, 1);
      assert.equal(restored.lastAppendSequence, 2);
      assert.equal(
        (await restoreRepository.verifyIntegrity(CRDT_DOCUMENT_REF)).valid,
        true,
      );
    });

    await repository.rebuildProjection(CRDT_DOCUMENT_REF, 'checklist-summary');
    assert.deepEqual(
      (await repository.readDocumentMetadata(CRDT_DOCUMENT_REF))?.projectionIds,
      ['checklist-summary'],
    );

    await repository.updateDocumentLifecycle({
      document: CRDT_DOCUMENT_REF,
      lifecycle: 'archived',
      changedAtEpochMs: 3_000,
    });
    const rejected = await repository.append(
      toCrdtAppendInput(createCrdtUpdate('update-3')),
    );

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.status === 'rejected' && rejected.code, 'document-archived');
  });

  await withPGliteSql(async (sql) => {
    const disabledRepository = new PSqlCrdtLogRepository(sql, {
      now: () => 5_000,
      policies: [
        {
          documentType: 'checklist',
          rollout: 'disabled',
          flags: {
            killSwitchReason: 'maintenance',
          },
        },
      ],
    });
    const disabled = await disabledRepository.append(
      toCrdtAppendInput(createCrdtUpdate('disabled-1')),
    );

    assert.equal(disabled.status, 'rejected');
    assert.equal(disabled.status === 'rejected' && disabled.code, 'feature-disabled');
  });

  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtLogRepository(sql, {
      now: () => 6_000,
    });
    await repository.updateDocumentLifecycle({
      document: CRDT_DOCUMENT_REF,
      lifecycle: 'active',
      quota: {
        maxUpdatesPerMinutePerActor: 1,
      },
    });

    assert.equal(
      (await repository.append(toCrdtAppendInput(createCrdtUpdate('rate-1'))))
        .status,
      'accepted',
    );
    const rateLimited = await repository.append(
      toCrdtAppendInput(createCrdtUpdate('rate-2')),
    );
    assert.equal(rateLimited.status, 'rejected');
    assert.equal(rateLimited.status === 'rejected' && rateLimited.code, 'rate-limited');

    await repository.updateDocumentLifecycle({
      document: CRDT_DOCUMENT_REF,
      lifecycle: 'quarantined',
    });
    const quarantined = await repository.append(
      toCrdtAppendInput(createCrdtUpdate('rate-3')),
    );
    assert.equal(quarantined.status, 'rejected');
    assert.equal(
      quarantined.status === 'rejected' && quarantined.code,
      'document-quarantined',
    );
  });
});

async function withPGliteSql(
  fn: (sql: PGliteSql) => Promise<void>,
): Promise<void> {
  const sql = createApiV1SqlClient({ sqlBackend: 'pglite-memory' }) as PGliteSql;
  try {
    await fn(sql);
  } finally {
    await sql.close();
  }
}

async function readCrdtStoredUpdateBytes(
  sql: PGliteSql,
  document: RallarCrdtDocumentRef,
): Promise<number> {
  const rows = await sql<{ stored_update_bytes: string | number }[]>`
        select stored_update_bytes
        from crdt_documents
        where document_key = ${toRallarCrdtDocumentKey(document)}
    `;
  return Number(rows[0]?.stored_update_bytes ?? 0);
}

function byteLengthOfSerializedJson(serialized: string): number {
  return new TextEncoder().encode(serialized).byteLength;
}

function createClientStateEvent(
  eventId: string,
  occurredAtEpochMs: number,
  snapshotVersion: number,
  eventType: ClientEvent['eventType'] = 'session-connected',
  overrides: Partial<ClientEvent> = {},
): ClientEvent {
  return {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    principalId: 'principal-1',
    eventId,
    eventType,
    snapshotVersion,
    occurredAtEpochMs,
    clientInstanceId: 'instance-1',
    sessionId: 'session-1',
    actor: {
      serviceId: 'pglite-test',
    },
    ...overrides,
  };
}

function createGroupStateEvent(
  eventId: string,
  occurredAtEpochMs: number,
  snapshotVersion: number,
  eventType: GroupEvent['eventType'] = 'session-connected',
  overrides: Partial<GroupEvent> = {},
): GroupEvent {
  return {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1',
    eventId,
    eventType,
    snapshotVersion,
    occurredAtEpochMs,
    actor: {
      serviceId: 'pglite-test',
    },
    ...overrides,
  };
}

const CRDT_ROOM_REF = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  groupId: 'room-1',
};

const CRDT_DOCUMENT_REF: RallarCrdtDocumentRef = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'room-1',
  roomRef: CRDT_ROOM_REF,
};

function toCrdtAppendInput(update: RallarCrdtUpdateEnvelope) {
  return {
    update,
    trusted: {
      authorizationScope: 'room' as const,
      principalId: 'principal-a',
      sessionId: 'session-a',
    },
  };
}

function createCrdtUpdate(updateId: string): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: CRDT_DOCUMENT_REF,
    updateId,
    replicaId: 'replica-a',
    lamport: Number(updateId.split('-').at(-1) ?? 1),
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs: 1_000,
    payload: createCrdtBatch(`Title ${updateId}`),
  };
}

function createCrdtBatch(title: string): RallarCrdtOperationBatch {
  return {
    kind: 'batch',
    operations: [
      {
        kind: 'register.set',
        path: ['title'],
        policy: 'lww',
        value: title,
      },
    ],
  };
}

function createResourceEntry(
  resourceId: string,
  options: Readonly<{
    topicId?: string;
    contextId?: string;
    typeId?: string;
    status?: EntityStatus;
    payload?: unknown;
    expiryTs?: Temporal.Instant;
  }> = {},
): ResourceEntry {
  return {
    key: {
      topicId: options.topicId ?? 'topic-smoke',
      resourceId,
      contextId: options.contextId ?? 'ctx-smoke',
    },
    resource: JSON.stringify(options.payload ?? { resourceId }),
    typeId: options.typeId ?? 'TYPE_A',
    status: options.status ?? EntityStatus.NEW,
    audit: {
      date: CREATED_TS.toPlainTime(),
      createdBy: 'tester',
      createdTs: CREATED_TS,
      expiryTs: options.expiryTs ?? FUTURE_INSTANT,
    },
    dequeueAudit: {
      attempts: 0,
    },
  };
}
