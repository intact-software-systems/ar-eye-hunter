import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import {
  ResourceInboxInvariantCorruptionError,
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import {
  PSqlGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
import { groupEventWorkspaceKey } from '@shared-server/postgres/rallar-system/\
group-event-workspace-key.ts';
import {
  type TopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { withPGliteSql } from './pglite-auth-test-harness.ts';
import { createGroupStateEvent, createResourceEntry } from './pglite-sql-adapter-test-runtime.ts';

interface ResourceInboxStatusRow {
  readonly ri_type_id: string;
  readonly ri_status: string;
}

interface NumericCountRow {
  readonly count: string | number;
}

interface StringCountRow {
  readonly count: string;
}

interface ResourceInboxLifecycleRow {
  readonly ri_resource_id: string;
  readonly ri_topic_id: string;
  readonly ri_type_id: string;
  readonly ri_status: string;
  readonly ri_resource: string;
}

interface ResourceInboxForeignKeyRow {
  readonly ri_topic_id: string;
  readonly ri_resource_id: string;
  readonly fk_ext_bank_id: string;
}

interface ResourceInboxTopicTypeRow {
  readonly ri_topic_id: string;
  readonly ri_type_id: string;
}

interface NumericValueRow {
  readonly value: number;
}

interface StringValueRow {
  readonly value: string;
}

interface RuntimeStateExpiryRow {
  readonly store_key: string;
  readonly expire_at_ts: string;
}

interface ResourceInboxAttemptStatusRow {
  readonly ri_attempts: string | number;
  readonly ri_status: string;
}

interface ResourceInboxPayloadRow {
  readonly ri_resource: string;
}

interface EpochMillisecondsRow {
  readonly epoch_ms: string | number;
}

interface GroupEventWorkspaceRow {
  readonly workspace_key: string;
}

interface CreatedTimestampRow {
  readonly created_ts: string;
}

interface ExpireTimestampRow {
  readonly expire_ts: string;
}

interface StartTimestampRow {
  readonly start_ts: string;
}

interface EndTimestampRow {
  readonly end_ts: string;
}

interface TopologyCommandPayload {
  readonly data: TopologyAppInboxCommand;
}

interface DurableTopologyAuthorityProof {
  readonly principalId: string;
  readonly sessionId: string;
  readonly sessionIssuedAtEpochMs: number;
}

interface DurableTopologyAuthorityValue {
  readonly proof: DurableTopologyAuthorityProof;
}

interface DurableTopologyAuthority {
  readonly authority: DurableTopologyAuthorityValue;
}

interface ResourceInboxKeyFields {
  readonly topicId: string;
  readonly resourceId: string;
  readonly contextId: string;
}

interface RtcTopologyDeliveryState {
  readonly headSequence: number;
  readonly sequences: readonly number[];
}

interface RtcTopologyDeliveryStreamRow {
  readonly head_sequence: number;
}

interface RtcTopologyDeliveryEntryRow {
  readonly sequence: number;
}

Deno.test('PSql group event reads fail closed on a legacy wrong-scope payload', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const expectedRef = {
      applicationId: 'legacy-group-event-app',
      workspaceId: 'main',
      groupId: 'legacy-group-event-group',
    };
    const corruptEvent = createGroupStateEvent({
      eventId: 'legacy-event',
      occurredAtEpochMs: 1_000,
      snapshotVersion: 1,
      eventType: 'group-updated',
      overrides: { ...expectedRef, workspaceId: '_' },
    });
    await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      ) values (
        ${expectedRef.applicationId}, ${groupEventWorkspaceKey(expectedRef.workspaceId)},
        ${expectedRef.groupId},
        ${corruptEvent.eventId}, ${corruptEvent.eventType},
        ${corruptEvent.snapshotVersion}, ${corruptEvent.occurredAtEpochMs},
        ${JSON.stringify(corruptEvent)}
      )
    `;

    for (
      const read of [
        () => repository.listGroupEvents(expectedRef),
        () => repository.listRecentGroupEvents(expectedRef),
        () => repository.listGroupEventPage(expectedRef, { limit: 10 }),
      ]
    ) {
      await assert.rejects(read, (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-repository-invariant-corruption');
    }
  });
});

Deno.test(
  'PSql group event reads normalize the f135 legacy contract at the storage boundary',
  async () => {
    await withPGliteSql(async (sql) => {
      const repository = new PSqlGroupStateEventRepository(sql);
      const ref = {
        applicationId: 'legacy-group-event-normalization-app',
        workspaceId: 'main',
        groupId: 'legacy-group-event-normalization-group',
      };
      const eventType: GroupEvent['eventType'] = 'group-updated';
      const legacyEvent = {
        applicationId: ref.applicationId,
        groupId: ref.groupId,
        eventId: 'legacy-normalized-event',
        eventType,
        snapshotVersion: 7,
        occurredAtEpochMs: 1_000,
        actor: { principalId: 'alice' },
      };
      await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      ) values (
        ${ref.applicationId}, ${groupEventWorkspaceKey(ref.workspaceId)},
        ${ref.groupId}, ${legacyEvent.eventId}, ${legacyEvent.eventType},
        ${legacyEvent.snapshotVersion}, ${legacyEvent.occurredAtEpochMs},
        ${JSON.stringify(legacyEvent)}
      )
    `;

      const expected: GroupEvent = {
        ...legacyEvent,
        workspaceId: ref.workspaceId,
        causalRevision: { groupRevision: 7, presenceRevision: 0 },
        actor: { kind: 'principal', principalId: 'alice' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
      };
      assert.deepEqual(await repository.listGroupEvents(ref), [expected]);
      assert.deepEqual(await repository.listRecentGroupEvents(ref), [expected]);
      assert.deepEqual(
        (await repository.listGroupEventPage(ref, { limit: 1 })).events,
        [expected],
      );
    });
  },
);

Deno.test(
  'PSql group event reads reject explicit null legacy identities and payloads',
  async () => {
    await withPGliteSql(async (sql) => {
      const repository = new PSqlGroupStateEventRepository(sql);
      for (
        const [suffix, defect] of [
          ['workspace', { workspaceId: null }],
          ['payload', { payload: null }],
        ] as const
      ) {
        const ref = {
          applicationId: 'legacy-group-event-null-app',
          workspaceId: 'main',
          groupId: `legacy-group-event-null-${suffix}`,
        };
        const event = {
          applicationId: ref.applicationId,
          workspaceId: ref.workspaceId,
          groupId: ref.groupId,
          eventId: `legacy-null-${suffix}`,
          eventType: 'group-updated',
          snapshotVersion: 1,
          occurredAtEpochMs: 1_000,
          actor: { principalId: 'alice' },
          ...defect,
        };
        await sql`
        insert into group_state_events (
          application_id, workspace_key, group_id, event_id, event_type,
          snapshot_version, occurred_at_epoch_ms, event_json
        ) values (
          ${ref.applicationId}, ${groupEventWorkspaceKey(ref.workspaceId)},
          ${ref.groupId}, ${event.eventId}, ${event.eventType},
          ${event.snapshotVersion}, ${event.occurredAtEpochMs},
          ${JSON.stringify(event)}
        )
      `;

        await assert.rejects(
          () => repository.listGroupEvents(ref),
          (error) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'group-state-event-repository-invariant-corruption',
        );
      }
    });
  },
);

Deno.test('PSql group event reads validate the decoded event-id slot', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const ref = {
      applicationId: 'group-event-slot-app',
      workspaceId: 'main',
      groupId: 'group-event-slot-group',
    };
    const event = createGroupStateEvent({
      eventId: 'payload-event-id',
      occurredAtEpochMs: 1_000,
      snapshotVersion: 1,
      eventType: 'group-updated',
      overrides: ref,
    });
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

Deno.test(
  'PSql group events enforce the complete event contract and physical columns',
  async () => {
    await withPGliteSql(async (sql) => {
      const repository = new PSqlGroupStateEventRepository(sql);
      const baseRef = {
        applicationId: 'group-event-complete-contract-app',
        workspaceId: 'main',
        groupId: 'group-event-complete-contract-group',
      };
      const baseEvent = createGroupStateEvent({
        eventId: 'complete-contract-event',
        occurredAtEpochMs: 1_000,
        snapshotVersion: 1,
        eventType: 'group-updated',
        overrides: baseRef,
      });
      const missingActor = structuredClone(baseEvent);
      Reflect.deleteProperty(missingActor, 'actor');

      await assert.rejects(
        () => repository.appendGroupEvent(missingActor),
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

        for (
          const read of [
            () => repository.listGroupEvents(ref),
            () => repository.listRecentGroupEvents(ref),
            () => repository.listGroupEventPage(ref, { limit: 10 }),
          ]
        ) {
          await assert.rejects(read, (error) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'group-state-event-repository-invariant-corruption');
        }
      }
    });
  },
);

Deno.test('ResourceInboxRepository rejects a persisted null attempt count', async () => {
  await withPGliteSql(async (sql) => {
    const inbox = new ResourceInboxRepository(sql);
    const nullAttempts = createResourceEntry('null-attempts', {
      payload: { text: 'mandatory attempts' },
      typeId: 'APP_OUTBOX',
      expiryTs: Temporal.Instant.from('9999-12-31T23:59:59Z'),
    });
    assert.equal(await inbox.writeIfAbsentOrMatch(nullAttempts), 'inserted');
    await sql`
      update resource_inbox
      set ri_attempts = null
      where ri_topic_id = ${nullAttempts.key.topicId}
        and ri_resource_id = ${nullAttempts.key.resourceId}
        and fk_ext_bank_id = ${nullAttempts.key.contextId}
    `;

    await assert.rejects(
      () => inbox.writeIfAbsentOrMatch(nullAttempts),
      ResourceInboxInvariantCorruptionError,
    );
  });
});

Deno.test('ResourceInboxRepository replay is independent of PostgreSQL DateStyle', async () => {
  await withPGliteSql(async (sql) => {
    await sql`set datestyle to 'SQL, DMY'`;

    const inbox = new ResourceInboxRepository(sql);
    const base = createResourceEntry('datestyle-replay', {
      payload: { text: 'datestyle independent' },
      typeId: 'APP_OUTBOX',
      expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000001Z'),
    });
    const entry = {
      ...base,
      audit: {
        ...base.audit,
        createdTs: Temporal.PlainDateTime.from('2026-06-01T12:00:00.000001'),
      },
    };

    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'inserted');
    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'matched');
    await assert.rejects(
      () =>
        inbox.writeIfAbsentOrMatch({
          ...entry,
          audit: {
            ...entry.audit,
            createdTs: Temporal.PlainDateTime.from('2026-06-01T12:00:00.000002'),
          },
        }),
      ResourceInboxInvariantCorruptionError,
    );
    await assert.rejects(
      () =>
        inbox.writeIfAbsentOrMatch({
          ...entry,
          audit: {
            ...entry.audit,
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000002Z'),
          },
        }),
      ResourceInboxInvariantCorruptionError,
    );

    await sql`
      update resource_inbox
      set ri_status = ${EntityStatus.RETRY},
          ri_attempts = 1,
          start_ts = timestamp '2026-06-01 12:01:00.000001',
          end_ts = timestamp '2026-06-01 12:01:01.000001',
          next_ts = timestamp '2026-06-01 12:01:02.000001'
      where ri_topic_id = ${entry.key.topicId}
        and ri_resource_id = ${entry.key.resourceId}
        and fk_ext_bank_id = ${entry.key.contextId}
    `;
    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'matched');
  });
});

Deno.test('ResourceInboxRepository preserves supported expanded-year rollover', async () => {
  await withPGliteSql(async (sql) => {
    await sql`set datestyle to 'SQL, DMY'`;

    const inbox = new ResourceInboxRepository(sql);
    const base = createResourceEntry('expanded-year-replay', {
      payload: { text: 'expanded year' },
      typeId: 'APP_OUTBOX',
      expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.9999995Z'),
    });
    const entry = {
      ...base,
      audit: {
        ...base.audit,
        createdTs: Temporal.PlainDateTime.from('9999-01-01T00:00:00'),
      },
    };

    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'inserted');
    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'matched');
    await assert.rejects(
      () =>
        inbox.writeIfAbsentOrMatch({
          ...entry,
          audit: {
            ...entry.audit,
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.9999994Z'),
          },
        }),
      ResourceInboxInvariantCorruptionError,
    );
  });
});

Deno.test(
  'PGlite reclaims stale AppInbox exhaustion as an exact finalization generation',
  async () => {
    await withPGliteSql(async (sql) => {
      const inbox = new ResourceInboxRepository(sql);
      const queue = new PSqlQueueBox(inbox);
      const exhausted = {
        ...createResourceEntry('pglite-finalization-recovery', {
          payload: { text: 'recover finalization' },
          typeId: 'APP_INBOX',
        }),
        status: EntityStatus.RESERVED,
        dequeueAudit: {
          attempts: 20,
          startTs: Temporal.Instant.from('2020-01-01T00:00:00Z'),
        },
      };
      await inbox.write(exhausted);

      const recovered = await queue.reserveRetryExhaustionFinalizations(
        new Set(['APP_INBOX', 'APP_OUTBOX']),
        {
          processingAttempts: 20,
          maxToReserve: 1,
          staleAfterMs: 300_000,
        },
      );

      assert.equal(recovered.size, 1);
      assert.equal([...recovered.values()][0]?.entry.dequeueAudit.attempts, 21);
      assert.equal([...recovered.values()][0]?.entry.status, EntityStatus.RESERVED);
      assert.equal(
        [...recovered.values()][0]?.selectedDueTs.toString(),
        exhausted.dequeueAudit.startTs.toString(),
      );
      assert.equal(
        (await queue.reserveRetryExhaustionFinalizations(
          new Set(['APP_INBOX']),
          {
            processingAttempts: 20,
            maxToReserve: 1,
            staleAfterMs: 300_000,
          },
        )).size,
        0,
      );
    });
  },
);
