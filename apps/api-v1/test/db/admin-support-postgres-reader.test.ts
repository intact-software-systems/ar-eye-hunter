import assert from 'node:assert/strict';
import { PSqlAdminSupportReader } from '@shared-server/postgres/admin-support/PSqlAdminSupportReader.ts';
import { createApiV1SqlClient } from '../../src/db/db.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

Deno.test('PSqlAdminSupportReader reads active queue and result rows by explicit QueueBox key', async () => {
  await withPGliteSql(async (sql) => {
    await seedQueueRows(sql);
    const reader = new PSqlAdminSupportReader(sql);
    const key = {
      topicId: 'group-state.event',
      resourceId: 'request-1',
      contextId: 'room-1',
    };

    const inbox = await reader.readQueueEntry(key, false);
    const result = await reader.readQueueResult(key, false);

    assert.deepEqual({
      ...inbox,
      createdAtEpochMs: typeof inbox?.createdAtEpochMs,
      startedAtEpochMs: typeof inbox?.startedAtEpochMs,
      nextRetryAtEpochMs: typeof inbox?.nextRetryAtEpochMs,
      expiresAtEpochMs: typeof inbox?.expiresAtEpochMs,
    }, {
      source: 'resource_inbox',
      key,
      typeId: 'WS_OUTBOX',
      status: 'RETRY',
      attempts: 2,
      createdAtEpochMs: 'number',
      endedAtEpochMs: undefined,
      startedAtEpochMs: 'number',
      nextRetryAtEpochMs: 'number',
      expiresAtEpochMs: 'number',
      payload: '{"secret":"inbox"}',
    });
    assert.ok(inbox!.startedAtEpochMs! > inbox!.createdAtEpochMs!);
    assert.ok(inbox!.nextRetryAtEpochMs! > inbox!.startedAtEpochMs!);

    assert.deepEqual({
      ...result,
      createdAtEpochMs: typeof result?.createdAtEpochMs,
      expiresAtEpochMs: typeof result?.expiresAtEpochMs,
    }, {
      source: 'resource_inbox_results',
      key,
      typeId: 'APP_INBOX',
      status: 'FAILED',
      attempts: 0,
      createdAtEpochMs: 'number',
      expiresAtEpochMs: 'number',
      payload: '{"secret":"result"}',
    });
  });
});

Deno.test('PSqlAdminSupportReader only returns expired queue rows when includeExpired is true', async () => {
  await withPGliteSql(async (sql) => {
    await seedQueueRows(sql);
    const reader = new PSqlAdminSupportReader(sql);
    const expiredKey = {
      topicId: 'group-state.event',
      resourceId: 'expired-request',
      contextId: 'room-1',
    };

    assert.equal(await reader.readQueueEntry(expiredKey, false), undefined);
    assert.equal(await reader.readQueueResult(expiredKey, false), undefined);
    assert.equal((await reader.readQueueEntry(expiredKey, true))?.status, 'FAILED');
    assert.equal((await reader.readQueueResult(expiredKey, true))?.status, 'FAILED');
  });
});

async function seedQueueRows(sql: PGliteSql): Promise<void> {
  await sql`
    insert into resource_inbox (
      ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts,
      start_ts, next_ts, ri_attempts
    )
    values
      (
        ${'request-1'}, ${'group-state.event'}, ${'{"secret":"inbox"}'},
        ${'WS_OUTBOX'}, ${'RETRY'}, ${'room-1'}, ${'2026-07-08'},
        ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
        ${new Date('9999-12-31T23:59:59Z')},
        ${new Date('2026-07-08T10:01:00Z')},
        ${new Date('2026-07-08T10:02:00Z')},
        ${2}
      ),
      (
        ${'expired-request'}, ${'group-state.event'}, ${'{"secret":"expired-inbox"}'},
        ${'WS_OUTBOX'}, ${'FAILED'}, ${'room-1'}, ${'2026-07-08'},
        ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
        ${new Date('2000-01-01T00:00:00Z')},
        ${null}, ${null}, ${1}
      )
  `;

  await sql`
    insert into resource_inbox_results (
      ris_resource_id, ris_topic_id, ris_resource, ris_type_id, ris_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts
    )
    values
      (
        ${'request-1'}, ${'group-state.event'}, ${'{"secret":"result"}'},
        ${'APP_INBOX'}, ${'FAILED'}, ${'room-1'}, ${'2026-07-08'},
        ${'test'}, ${new Date('2026-07-08T10:03:00Z')},
        ${new Date('9999-12-31T23:59:59Z')}
      ),
      (
        ${'expired-request'}, ${'group-state.event'}, ${'{"secret":"expired-result"}'},
        ${'APP_INBOX'}, ${'FAILED'}, ${'room-1'}, ${'2026-07-08'},
        ${'test'}, ${new Date('2026-07-08T10:03:00Z')},
        ${new Date('2000-01-01T00:00:00Z')}
      )
  `;
}

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
