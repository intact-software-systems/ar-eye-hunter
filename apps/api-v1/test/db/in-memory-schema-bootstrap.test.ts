import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  applyApiV1InMemorySchema,
  bootstrapApiV1InMemorySchemaIfNeeded,
  readApiV1InMemorySchemaSql,
} from '../../src/db/in-memory-schema-bootstrap.ts';

Deno.test('in-memory schema applies idempotently and creates expected tables/indexes', async () => {
  const db = new PGlite();
  try {
    const schemaSql = await readApiV1InMemorySchemaSql();

    await applyApiV1InMemorySchema(db, schemaSql);
    await applyApiV1InMemorySchema(db, schemaSql);

    const tables = await db.query<{ table_name: string }>(
      `select table_name
             from information_schema.tables
             where table_schema = 'public'
             order by table_name`,
    );

    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [
        'app_data_store',
        'client_state_events',
        'crdt_documents',
        'crdt_snapshots',
        'crdt_updates',
        'group_state_events',
        'resource_inbox',
        'resource_inbox_results',
        'runtime_state_store',
      ],
    );

    const indexes = await db.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef
             from pg_indexes
             where schemaname = 'public'
             order by indexname`,
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));

    for (
      const indexName of [
        'app_data_store_expire_at_ix',
        'app_data_store_namespace_expire_at_ix',
        'app_data_store_pk',
        'app_data_store_store_ix',
        'client_state_events_page_ix',
        'client_state_events_pk',
        'client_state_events_type_page_ix',
        'crdt_documents_lifecycle_ix',
        'crdt_documents_lookup_ix',
        'crdt_documents_pk',
        'crdt_snapshots_document_append_ix',
        'crdt_snapshots_pk',
        'crdt_updates_document_sequence_ix',
        'crdt_updates_pk',
        'crdt_updates_update_id_ix',
        'crdt_updates_update_id_uq',
        'group_state_events_page_ix',
        'group_state_events_pk',
        'group_state_events_type_page_ix',
        'resource_inbox_expire_ts_ix',
        'resource_inbox_ix',
        'resource_inbox_reserved_timeout_ix',
        'resource_inbox_runnable_ix',
        'resource_inbox_results_expire_ts_ix',
        'resource_inbox_results_ix',
        'resource_inbox_results_unique_k',
        'resource_inbox_unique_k',
        'ri_pk',
        'ris_pk',
        'runtime_state_store_expire_at_ix',
        'runtime_state_store_namespace_key_c_ix',
        'runtime_state_store_namespace_expire_at_ix',
        'runtime_state_store_namespace_ix',
        'runtime_state_store_pk',
      ]
    ) {
      assert.ok(indexNames.has(indexName), `missing index ${indexName}`);
    }
    assert.match(
      indexes.rows.find((row) => row.indexname === 'runtime_state_store_namespace_key_c_ix')
        ?.indexdef ?? '',
      /\(store_namespace, store_key COLLATE "C"\)/,
    );
  } finally {
    await db.close();
  }
});

Deno.test('schema bootstrap only runs for PGlite backends', async () => {
  let calls = 0;
  const client = {
    exec(_sql: string): Promise<void> {
      calls += 1;
      return Promise.resolve();
    },
  };

  assert.equal(
    await bootstrapApiV1InMemorySchemaIfNeeded(client, { sqlBackend: 'postgres' }),
    false,
  );
  assert.equal(calls, 0);

  assert.equal(
    await bootstrapApiV1InMemorySchemaIfNeeded(client, { sqlBackend: 'pglite-memory' }),
    true,
  );
  assert.equal(calls, 1);

  assert.equal(
    await bootstrapApiV1InMemorySchemaIfNeeded(client, { sqlBackend: 'pglite-file' }),
    true,
  );
  assert.equal(calls, 2);

  assert.equal(
    await bootstrapApiV1InMemorySchemaIfNeeded(client, {
      sqlBackend: 'pglite-memory',
      pgliteSchemaInit: 'disabled',
    }),
    false,
  );
  assert.equal(calls, 2);
});

Deno.test('in-memory schema supports repository-shaped SQL smoke operations', async () => {
  const db = new PGlite();
  try {
    await applyApiV1InMemorySchema(db);

    await smokeResourceInbox(db);
    await smokeResourceInboxResults(db);
    await smokeRuntimeStateStore(db);
    await smokeAppDataStore(db);
    await smokeCrdtLog(db);
  } finally {
    await db.close();
  }
});

async function smokeResourceInbox(db: PGlite): Promise<void> {
  const inserted = await db.query<{ ri_row_id: number }>(
    `insert into resource_inbox (ri_resource_id,
                                     ri_topic_id,
                                     ri_resource,
                                     ri_type_id,
                                     ri_status,
                                     fk_ext_bank_id,
                                     system_date,
                                     created_by,
                                     created_ts,
                                     expire_ts)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning ri_row_id`,
    [
      'resource-1',
      'topic-1',
      'payload',
      'WS_INBOX',
      'PENDING',
      'bank-1',
      '2026-06-01',
      'test',
      '2026-06-01 12:00:00',
      '9999-12-31 23:59:59.999999',
    ],
  );

  assert.equal(inserted.rows.length, 1);
  assert.ok(Number(inserted.rows[0].ri_row_id) >= 1000);

  const upserted = await db.query<{ ri_resource: string; ri_status: string }>(
    `insert into resource_inbox (ri_resource_id,
                                     ri_topic_id,
                                     ri_resource,
                                     ri_type_id,
                                     ri_status,
                                     fk_ext_bank_id,
                                     system_date,
                                     created_by,
                                     created_ts,
                                     expire_ts)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)
             do update set ri_resource = excluded.ri_resource,
                           ri_status   = excluded.ri_status,
                           expire_ts   = excluded.expire_ts
         returning ri_resource, ri_status`,
    [
      'resource-1',
      'topic-1',
      'payload-updated',
      'WS_INBOX',
      'COMPLETED',
      'bank-1',
      '2026-06-01',
      'test',
      '2026-06-01 12:00:01',
      '2000-01-01 00:00:00',
    ],
  );

  assert.deepEqual(upserted.rows[0], {
    ri_resource: 'payload-updated',
    ri_status: 'COMPLETED',
  });

  const selected = await db.query<{ ri_resource: string; ri_status: string }>(
    `select ri_resource, ri_status
         from resource_inbox
         where fk_ext_bank_id = $1
           and ri_resource_id = $2
           and ri_topic_id = $3`,
    ['bank-1', 'resource-1', 'topic-1'],
  );

  assert.deepEqual(selected.rows, [
    { ri_resource: 'payload-updated', ri_status: 'COMPLETED' },
  ]);

  const expired = await db.query<{ ri_row_id: number }>(
    `delete
         from resource_inbox
         where expire_ts <= now()
         returning ri_row_id`,
  );

  assert.equal(expired.rows.length, 1);
  assert.deepEqual(await countRows(db, 'resource_inbox'), 0);
}

async function smokeResourceInboxResults(db: PGlite): Promise<void> {
  const inserted = await db.query<{ ris_row_id: number }>(
    `insert into resource_inbox_results (ris_resource_id,
                                             ris_topic_id,
                                             ris_resource,
                                             ris_type_id,
                                             ris_status,
                                             fk_ext_bank_id,
                                             system_date,
                                             created_by,
                                             created_ts,
                                             expire_ts)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning ris_row_id`,
    [
      'result-resource-1',
      'result-topic-1',
      'result-payload',
      'WS_INBOX_RESULT',
      'COMPLETED',
      'bank-1',
      '2026-06-01',
      'test',
      '2026-06-01 12:00:00',
      '9999-12-31 23:59:59.999999',
    ],
  );

  assert.equal(inserted.rows.length, 1);
  assert.ok(Number(inserted.rows[0].ris_row_id) >= 1000);

  const upserted = await db.query<{ ris_resource: string; ris_status: string }>(
    `insert into resource_inbox_results (ris_resource_id,
                                             ris_topic_id,
                                             ris_resource,
                                             ris_type_id,
                                             ris_status,
                                             fk_ext_bank_id,
                                             system_date,
                                             created_by,
                                             created_ts,
                                             expire_ts)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (fk_ext_bank_id, ris_resource_id, ris_topic_id)
             do update set ris_resource = excluded.ris_resource,
                           ris_status   = excluded.ris_status,
                           expire_ts    = excluded.expire_ts
         returning ris_resource, ris_status`,
    [
      'result-resource-1',
      'result-topic-1',
      'result-payload-updated',
      'WS_INBOX_RESULT',
      'FAILED',
      'bank-1',
      '2026-06-01',
      'test',
      '2026-06-01 12:00:01',
      '2000-01-01 00:00:00',
    ],
  );

  assert.deepEqual(upserted.rows[0], {
    ris_resource: 'result-payload-updated',
    ris_status: 'FAILED',
  });

  const selected = await db.query<{ ris_resource: string; ris_status: string }>(
    `select ris_resource, ris_status
         from resource_inbox_results
         where fk_ext_bank_id = $1
           and ris_resource_id = $2
           and ris_topic_id = $3`,
    ['bank-1', 'result-resource-1', 'result-topic-1'],
  );

  assert.deepEqual(selected.rows, [
    { ris_resource: 'result-payload-updated', ris_status: 'FAILED' },
  ]);

  const expired = await db.query<{ ris_row_id: number }>(
    `delete
         from resource_inbox_results
         where expire_ts <= now()
         returning ris_row_id`,
  );

  assert.equal(expired.rows.length, 1);
  assert.deepEqual(await countRows(db, 'resource_inbox_results'), 0);
}

async function smokeRuntimeStateStore(db: PGlite): Promise<void> {
  const inserted = await db.query<{ revision: number; store_value: string }>(
    `insert into runtime_state_store (store_namespace,
                                          store_key,
                                          store_value,
                                          expire_at_ts)
         values ($1, $2, $3, $4)
         on conflict (store_namespace, store_key)
             do update set store_value  = excluded.store_value,
                           expire_at_ts = excluded.expire_at_ts,
                           updated_ts   = now(),
                           revision     = runtime_state_store.revision + 1
         returning revision, store_value`,
    ['runtime-test', 'key-1', '{"value":1}', '9999-12-31T23:59:59.999Z'],
  );

  assert.deepEqual(inserted.rows[0], {
    revision: 0,
    store_value: '{"value":1}',
  });

  const updated = await db.query<{ revision: number; store_value: string }>(
    `insert into runtime_state_store (store_namespace,
                                          store_key,
                                          store_value,
                                          expire_at_ts)
         values ($1, $2, $3, $4)
         on conflict (store_namespace, store_key)
             do update set store_value  = excluded.store_value,
                           expire_at_ts = excluded.expire_at_ts,
                           updated_ts   = now(),
                           revision     = runtime_state_store.revision + 1
         returning revision, store_value`,
    ['runtime-test', 'key-1', '{"value":2}', '2000-01-01T00:00:00.000Z'],
  );

  assert.deepEqual(updated.rows[0], {
    revision: 1,
    store_value: '{"value":2}',
  });

  const selected = await db.query<{ store_value: string; revision: number }>(
    `select store_value, revision
         from runtime_state_store
         where store_namespace = $1
           and store_key = $2`,
    ['runtime-test', 'key-1'],
  );

  assert.deepEqual(selected.rows, [{ store_value: '{"value":2}', revision: 1 }]);

  const expired = await db.query<{ store_key: string }>(
    `delete
         from runtime_state_store
         where expire_at_ts <= now()
         returning store_key`,
  );

  assert.deepEqual(expired.rows, [{ store_key: 'key-1' }]);
  assert.deepEqual(await countRows(db, 'runtime_state_store'), 0);
}

async function smokeAppDataStore(db: PGlite): Promise<void> {
  const inserted = await db.query<{ revision: number; data_value: string }>(
    `insert into app_data_store (app_namespace,
                                     store_name,
                                     data_key,
                                     data_value,
                                     schema_version,
                                     expire_at_ts)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (app_namespace, store_name, data_key)
             do update set data_value     = excluded.data_value,
                           schema_version = excluded.schema_version,
                           expire_at_ts   = excluded.expire_at_ts,
                           updated_ts     = now(),
                           revision       = app_data_store.revision + 1
         returning revision, data_value`,
    ['app-test', 'store-1', 'key-1', '{"count":1}', 1, '9999-12-31T23:59:59.999Z'],
  );

  assert.deepEqual(inserted.rows[0], {
    revision: 0,
    data_value: '{"count":1}',
  });

  const updated = await db.query<{ revision: number; data_value: string }>(
    `insert into app_data_store (app_namespace,
                                     store_name,
                                     data_key,
                                     data_value,
                                     schema_version,
                                     expire_at_ts)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (app_namespace, store_name, data_key)
             do update set data_value     = excluded.data_value,
                           schema_version = excluded.schema_version,
                           expire_at_ts   = excluded.expire_at_ts,
                           updated_ts     = now(),
                           revision       = app_data_store.revision + 1
         returning revision, data_value`,
    ['app-test', 'store-1', 'key-1', '{"count":2}', 1, '2000-01-01T00:00:00.000Z'],
  );

  assert.deepEqual(updated.rows[0], {
    revision: 1,
    data_value: '{"count":2}',
  });

  const selected = await db.query<{ data_value: string; revision: number }>(
    `select data_value, revision
         from app_data_store
         where app_namespace = $1
           and store_name = $2
           and data_key = $3`,
    ['app-test', 'store-1', 'key-1'],
  );

  assert.deepEqual(selected.rows, [{ data_value: '{"count":2}', revision: 1 }]);

  const expired = await db.query<{ data_key: string }>(
    `delete
         from app_data_store
         where expire_at_ts <= now()
         returning data_key`,
  );

  assert.deepEqual(expired.rows, [{ data_key: 'key-1' }]);
  assert.deepEqual(await countRows(db, 'app_data_store'), 0);
}

async function smokeCrdtLog(db: PGlite): Promise<void> {
  const documentRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'room-1',
    roomRef: {
      applicationId: 'rallar-test',
      workspaceId: 'main',
      groupId: 'room-1',
    },
  };
  const documentKey = 'crdt:room:checklist:room-1';
  const update = {
    protocolVersion: 1,
    document: documentRef,
    updateId: 'update-1',
    replicaId: 'replica-a',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: 1,
    createdAtEpochMs: 1_000,
    payload: {
      kind: 'batch',
      operations: [],
    },
  };
  const snapshot = {
    protocolVersion: 1,
    document: documentRef,
    snapshotId: 'snapshot-1',
    schemaVersion: 1,
    createdAtEpochMs: 2_000,
    maxLamport: 1,
    includedUpdateIds: ['update-1'],
    value: {},
    metadata: {
      updateCount: 1,
    },
  };

  await db.query(
    `insert into crdt_documents (document_key,
                                     application_id,
                                     workspace_id,
                                     document_scope,
                                     document_type,
                                     document_id,
                                     document_ref)
         values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      documentKey,
      documentRef.applicationId,
      documentRef.workspaceId,
      documentRef.scope,
      documentRef.documentType,
      documentRef.documentId,
      JSON.stringify(documentRef),
    ],
  );
  await db.query(
    `insert into crdt_updates (document_key,
                                   append_sequence,
                                   update_id,
                                   update_envelope,
                                   accepted_update_hash,
                                   authorization_scope)
         values ($1, $2, $3, $4, $5, $6)`,
    [
      documentKey,
      1,
      update.updateId,
      JSON.stringify(update),
      'crdt-test-hash',
      'room',
    ],
  );
  await db.query(
    `update crdt_documents
         set stored_update_bytes = octet_length($2)
         where document_key = $1`,
    [
      documentKey,
      JSON.stringify(update),
    ],
  );
  await db.query(
    `insert into crdt_snapshots (document_key,
                                     snapshot_id,
                                     append_sequence,
                                     snapshot_envelope)
         values ($1, $2, $3, $4)`,
    [
      documentKey,
      snapshot.snapshotId,
      1,
      JSON.stringify(snapshot),
    ],
  );

  assert.deepEqual(await countRows(db, 'crdt_documents'), 1);
  assert.deepEqual(await countRows(db, 'crdt_updates'), 1);
  assert.deepEqual(await countRows(db, 'crdt_snapshots'), 1);
  assert.deepEqual(
    await readStoredUpdateBytes(db, documentKey),
    new TextEncoder().encode(JSON.stringify(update)).byteLength,
  );

  await db.query('delete from crdt_documents where document_key = $1', [documentKey]);
  assert.deepEqual(await countRows(db, 'crdt_documents'), 0);
  assert.deepEqual(await countRows(db, 'crdt_updates'), 0);
  assert.deepEqual(await countRows(db, 'crdt_snapshots'), 0);
}

async function countRows(db: PGlite, tableName: string): Promise<number> {
  const allowedTableNames = new Set([
    'app_data_store',
    'client_state_events',
    'crdt_documents',
    'crdt_snapshots',
    'crdt_updates',
    'group_state_events',
    'resource_inbox',
    'resource_inbox_results',
    'runtime_state_store',
  ]);

  if (!allowedTableNames.has(tableName)) {
    throw new Error(`Unsupported test table: ${tableName}`);
  }

  const result = await db.query<{ count: string }>(`select count(*)
                                                      from ${tableName}`);
  return Number(result.rows[0].count);
}

async function readStoredUpdateBytes(
  db: PGlite,
  documentKey: string,
): Promise<number> {
  const result = await db.query<{ stored_update_bytes: string | number }>(
    `select stored_update_bytes
         from crdt_documents
         where document_key = $1`,
    [documentKey],
  );
  return Number(result.rows[0]?.stored_update_bytes ?? 0);
}
