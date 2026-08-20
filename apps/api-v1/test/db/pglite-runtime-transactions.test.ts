import assert from 'node:assert/strict';

import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/\
PSqlRuntimeStateRepository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/\
ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/\
GroupStateRepository.ts';
import {
  createGroupStateService,
  mutationDescriptor,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import {
  groupStateGroupStorageKey,
  groupStateMemberStorageKey,
  groupStatePresenceSessionStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { createGroupStateEventRepository } from '@shared-server/postgres/rallar-system/\
createStateRepositories.ts';
import { toPersistedAuthSessionFixture, withPGliteSql } from './pglite-auth-test-harness.ts';
import {
  applyPGliteGroupMutation,
  canonicalAuditStamp,
  groupFixture,
} from './pglite-state-mutation-test-runtime.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

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
    const audit = canonicalAuditStamp(1);

    assert.equal(
      (await clients.insertPrincipal({
        applicationId: 'app',
        workspaceId: 'foo',
        principalId: 'alice',
        username: 'alice',
        displayName: null,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        roles: [],
        metadata: {},
        status: 'active',
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit,
        updated: audit,
        lastSeenAtEpochMs: null,
        disabled: null,
        deleted: null,
      })).status,
      'applied',
    );
    assert.equal(
      (await clients.insertPrincipal({
        applicationId: 'app',
        workspaceId: 'foobar',
        principalId: 'bob',
        username: 'bob',
        displayName: null,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        roles: [],
        metadata: {},
        status: 'active',
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit,
        updated: audit,
        lastSeenAtEpochMs: null,
        disabled: null,
        deleted: null,
      })).status,
      'applied',
    );
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

Deno.test(
  'PGlite group-state reads fail closed on a directly seeded legacy wrong-scope row',
  async () => {
    await withPGliteSql(async (sql) => {
      const ref = {
        applicationId: 'pglite-legacy-scope-app',
        workspaceId: 'main',
        groupId: 'pglite-legacy-scope-group',
      };
      // Deliberately degenerate: a legacy row carrying the sentinel workspace and
      // partial audit stamps. It must stay a hand-built payload, because the point
      // of the test is the exact stored shape a current writer would never produce.
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
        'app=pglite-legacy-scope-app:ws=main:group=pglite-legacy-scope-group',
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
          () =>
            repository.listGroups({
              applicationId: ref.applicationId,
              workspaceId: ref.workspaceId,
            }),
          () =>
            repository.listSnapshots({
              applicationId: ref.applicationId,
              workspaceId: ref.workspaceId,
            }),
          () =>
            repository.listSnapshotsPage(
              {
                applicationId: ref.applicationId,
                workspaceId: ref.workspaceId,
              },
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
  },
);

Deno.test(
  'PGlite group-state reads reject complete-contract corruption across public boundaries',
  async () => {
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
        const persistedAuthority = await toPersistedAuthSessionFixture(authority);
        let eventSequence = 0;
        const runtime = new PSqlRuntimeStateRepository(sql);
        const service = createGroupStateService({
          runtimeRepository: runtime,
          formationDamping: 'damped',
          createGroupStateEventStore: createGroupStateEventRepository,
          authSessionRepository: {
            findBySessionId: (sessionId) =>
              Promise.resolve(
                sessionId === authority.sessionId ? persistedAuthority : undefined,
              ),
          },
          now: () => 10_000,
          randomId: () => `event-${testCase.kind}-${eventSequence++}`,
          serviceId: `pglite-complete-${testCase.kind}`,
        });
        await applyPGliteGroupMutation({
          sql,
          service,
          descriptor: mutationDescriptor('createGroup', scope, ref.groupId, {
            groupId: ref.groupId,
            displayName: `Complete ${testCase.kind}`,
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: `create-${testCase.kind}`,
          }),
          authority,
        });
        if (testCase.kind === 'session') {
          await applyPGliteGroupMutation({
            sql,
            service,
            descriptor: mutationDescriptor(
              'connectPresence',
              scope,
              ref.groupId,
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
              'alice',
              authority.sessionId,
            ),
            authority,
          });
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
          await assert.rejects(
            read,
            (error) =>
              error instanceof Error &&
              'code' in error &&
              error.code === 'group-state-repository-invariant-corruption',
            `${testCase.kind} public read ${readIndex} accepted a corrupt persisted record`,
          );
        }
      }
    });
  },
);
