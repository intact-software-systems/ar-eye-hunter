import assert from 'node:assert/strict';

import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    type RallarCrdtDocumentRef,
    type RallarCrdtOperationBatch,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

import { PSqlCrdtMutationRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts';

import { CrdtMutationConflictError, type CrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';

import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';

import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' }
};

interface ColumnNullabilityRow {
    readonly column_name: string;
    readonly is_nullable: string;
}

interface CrdtDocumentCounterRow {
    readonly update_count: string | number;
    readonly last_append_sequence: string | number;
}

interface CrdtUpdateReadRecorder {
    readonly sql: PGliteSql;
    readonly reads: RecordedSqlRead[];
}

interface RecordedSqlRead {
    readonly bindings: readonly unknown[];
    readonly rows: readonly unknown[];
}

Deno.test(
    'production CRDT mutation repository denies an explicit fail-closed authority decision',
    async () => {
        await withPGliteSql(async (sql) => {
            const read = await new PSqlCrdtMutationRepository(
                {
                    sql,
                    authorize: () => Promise.resolve({ allowed: false, code: 'current-authority-reader-missing' })
                },
                { policies: [] }
            ).readMutation(
                await command('deny-default', 'deny-default', 1_000)
            );
            assert.equal(read.authorized, false);
        });
    }
);

Deno.test(
    'CRDT append reads only its candidate update while administration reads complete history',
    async () => {
        await withPGliteSql(async (sql) => {
            const seedService = mutationService(sql);
            const seeded = await Promise.all([
                command('seed-command-1', 'seed-update-1', 1_000),
                command('seed-command-2', 'seed-update-2', 2_000),
                command('seed-command-3', 'seed-update-3', 3_000)
            ]);
            for (const input of seeded) {
                await apply(sql, seedService, input);
            }

            const recorder = createCrdtUpdateReadRecorder(sql);
            const service = mutationService(recorder.sql);
            const newAppend = await command('new-command', 'new-update', 4_000);
            const newRead = await service.read(newAppend);
            assert.deepEqual(rowCountsBoundTo(recorder.reads, 'new-update'), [0]);
            assert.equal(newRead.existingUpdate, null);
            assert.equal(newRead.existingAppend, null);
            assert.deepEqual(newRead.records, []);

            recorder.reads.length = 0;
            const duplicateRead = await service.read(seeded[1]);
            const duplicate = service.compute({ command: seeded[1], read: duplicateRead });
            assert.deepEqual(rowCountsBoundTo(recorder.reads, 'seed-update-2'), [1]);
            assert.equal(duplicateRead.existingUpdate?.updateId, 'seed-update-2');
            assert.deepEqual(duplicateRead.records, []);
            assert.equal(duplicate.outcome, 'replay');

            recorder.reads.length = 0;
            const mismatchedCommand = await command('mismatch-command', 'seed-update-2', 5_000);
            const mismatchedRead = await service.read(mismatchedCommand);
            const mismatched = service.compute({ command: mismatchedCommand, read: mismatchedRead });
            assert.deepEqual(rowCountsBoundTo(recorder.reads, 'seed-update-2'), [1]);
            assert.equal(mismatched.outcome, 'rejected');
            assert.equal('code' in mismatched ? mismatched.code : null, 'duplicate-hash-mismatch');

            recorder.reads.length = 0;
            const administration = await compactCommand('compact-read', 6_000);
            const administrationRead = await service.read(administration);
            assert.deepEqual(rowCountsContaining(recorder.reads, 'update_envelope'), [3]);
            assert.deepEqual(
                administrationRead.records.map((record) => record.update.updateId),
                ['seed-update-1', 'seed-update-2', 'seed-update-3']
            );
        });
    }
);

Deno.test('CRDT administration retains complete persisted-counter validation', async () => {
    await withPGliteSql(async (sql) => {
        const service = mutationService(sql);
        await apply(sql, service, await command('counter-base', 'counter-update', 1_000));
        await sql`
      update crdt_documents set update_count = 2, last_append_sequence = 2
      where document_id = 'document-1'
    `;
        await assert.rejects(
            service.read(await compactCommand('counter-compact', 2_000)),
            /read set differs from document counters/
        );
    });
});

Deno.test('CRDT CAS guards revision, lifecycle, and append sequence', async () => {
    await withPGliteSql(async (sql) => {
        const service = mutationService(sql);
        await apply(sql, service, await command('first', 'first', 1_000));
        const second = await command('second', 'second', 2_000);
        const observed = await service.read(second);
        const computed = service.compute({ command: second, read: observed });
        await sql`
      update crdt_documents
      set lifecycle = 'archived', last_append_sequence = 99
      where document_key = ${second.documentKey}
    `;
        await assert.rejects(
            sql.begin(async (transaction) => await service.write(transaction, computed)),
            CrdtMutationConflictError
        );
    });
});

Deno.test(
    'CRDT persisted row decoding fails closed on physical/logical identity corruption',
    async () => {
        await withPGliteSql(async (sql) => {
            const input = await command('corrupt-read', 'corrupt-read', 1_000);
            await sql`
      insert into crdt_documents (
        document_key, application_id, workspace_id, document_scope, document_type,
        document_id, document_ref, document_revision, lifecycle, created_at_ts,
        updated_at_ts, last_append_sequence, update_count, snapshot_count,
        stored_update_bytes, projection_ids
      ) values (
        ${input.documentKey}, 'wrong-app', 'workspace-1', 'room', 'checklist',
        'document-1', ${JSON.stringify({ ...DOCUMENT, applicationId: 'wrong-app' })},
        1, 'active', ${new Date(500)}, ${new Date(500)}, 0, 0, 0, 0, '[]'
      )
    `;
            await assert.rejects(
                new PSqlCrdtMutationRepository(
                    { sql, authorize: () => Promise.resolve(true) },
                    { policies: [] }
                ).readMutation(input),
                /document.*identity|corrupt/i
            );
        });
    }
);

Deno.test('CRDT persisted metadata decoding validates counters and nested policies', async () => {
    await withPGliteSql(async (sql) => {
        const service = mutationService(sql);
        const input = await command('metadata-base', 'metadata-update', 1_000);
        await apply(sql, service, input);
        await sql`
      update crdt_documents set update_count = -1, projection_ids = '{"not":"an-array"}'
      where document_key = ${input.documentKey}
    `;
        await assert.rejects(
            service.read(await command('metadata-read', 'metadata-next', 2_000)),
            /metadata|counter|projection|corrupt/i
        );
    });
});

Deno.test('CRDT update decoding binds physical update_id to the envelope updateId', async () => {
    await withPGliteSql(async (sql) => {
        const service = mutationService(sql);
        const original = await command('physical-update-command', 'logical-update-id', 1_000);
        await apply(sql, service, original);
        await sql`
      update crdt_updates set update_id = 'physical-update-id'
      where document_key = ${original.documentKey}
    `;
        const lookup = await command('lookup-physical-command', 'physical-update-id', 2_000);
        await assert.rejects(service.read(lookup), /update.*identity|corrupt/i);
    });
});

Deno.test('CRDT durable trusted identity columns are mandatory', async () => {
    await withPGliteSql(async (sql) => {
        const rows = await sql<ColumnNullabilityRow[]>`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'crdt_updates'
        and column_name in ('actor_id', 'principal_id', 'session_id', 'server_id')
      order by column_name
    `;
        assert.deepEqual(rows, [
            { column_name: 'actor_id', is_nullable: 'NO' },
            { column_name: 'principal_id', is_nullable: 'NO' },
            { column_name: 'server_id', is_nullable: 'NO' },
            { column_name: 'session_id', is_nullable: 'NO' }
        ]);
    });
});

Deno.test(
    'CRDT snapshot decoding binds physical identity, sequence, time, and reason',
    async () => {
        await withPGliteSql(async (sql) => {
            const service = mutationService(sql);
            const original = await command('snapshot-base', 'snapshot-update', 1_000);
            await apply(sql, service, original);
            const envelope = snapshot('logical-snapshot-id', 'snapshot-value');
            await sql`
      insert into crdt_snapshots (
        document_key, snapshot_id, append_sequence, snapshot_envelope, created_at_ts, reason
      ) values (
        ${original.documentKey}, 'physical-snapshot-id', 99, ${JSON.stringify(envelope)},
        ${new Date(9_999)}, 'physical-reason'
      )
    `;
            await sql`
      update crdt_documents set snapshot_count = 1
      where document_key = ${original.documentKey}
    `;
            const compact = await createCrdtMutationCommand({
                operation: 'compact',
                commandId: 'snapshot-read',
                actor: {
                    actorId: 'actor-1',
                    principalId: 'client-1',
                    sessionId: 'session-1',
                    serverId: 'server-1'
                },
                capturedAtEpochMs: 2_000,
                expireAtEpochMs: 62_000,
                document: DOCUMENT,
                responseAudience: {
                    kind: 'admin',
                    senderSessionId: 'session-1',
                    topicId: 'crdt.admin',
                    contextId: original.documentKey
                },
                snapshotId: 'snapshot-read',
                snapshot: null,
                reason: 'read-corrupt-snapshot'
            });
            await assert.rejects(service.read(compact), /snapshot.*identity|corrupt/i);
        });
    }
);

Deno.test('CRDT quota accounts for every retained snapshot byte', async () => {
    await withPGliteSql(async (sql) => {
        const service = mutationService(sql);
        const original = await command('all-snapshot-base', 'all-snapshot-update', 1_000);
        await apply(sql, service, original);
        for (const [id, value] of [['snapshot-a', 'a'.repeat(700)], ['snapshot-b', 'b'.repeat(700)]]) {
            await sql`
        insert into crdt_snapshots (
          document_key, snapshot_id, append_sequence, snapshot_envelope, created_at_ts, reason
        ) values (
          ${original.documentKey}, ${id}, 1, ${JSON.stringify(snapshot(id, value))},
          ${new Date(10_000)}, 'app-inbox-compaction'
        )
      `;
        }
        await sql`
      update crdt_documents set snapshot_count = 2
      where document_key = ${original.documentKey}
    `;
        const observed = await service.read(
            await command('all-snapshot-read', 'all-snapshot-next', 2_000)
        );
        assert.ok(observed.storedSnapshotBytes > 1_400);
    });
});

Deno.test('CRDT read includes current actor-rate and snapshot-byte policy facts', async () => {
    await withPGliteSql(async (sql) => {
        const service = mutationService(sql);
        const first = await command('rate-first', 'rate-first', 10_000);
        await apply(sql, service, first);
        await sql`
      update crdt_documents
      set quota_policy = ${
            JSON.stringify({
                maxUpdatesPerMinutePerActor: 1,
                maxDocumentBytes: 10_000
            })
        }
      where document_key = ${first.documentKey}
    `;
        await sql`
      insert into crdt_snapshots (
        document_key, snapshot_id, append_sequence, snapshot_envelope,
        created_at_ts, reason
      ) values (
        ${first.documentKey}, 'snapshot-policy', 1,
        ${JSON.stringify(snapshot('snapshot-policy', 'x'.repeat(2_000)))},
        ${new Date(10_000)}, 'app-inbox-compaction'
      )
    `;
        await sql`
      update crdt_documents set snapshot_count = 1
      where document_key = ${first.documentKey}
    `;
        const second = await command('rate-second', 'rate-second', 11_000);
        const observed = await service.read(second);
        const computed = service.compute({ command: second, read: observed });
        assert.equal(observed.actorUpdatesInWindow, 1);
        assert.ok(observed.storedSnapshotBytes > 1_000);
        assert.deepEqual(
            { outcome: computed.outcome, code: 'code' in computed ? computed.code : null },
            {
                outcome: 'rejected',
                code: 'rate-limited'
            }
        );
    });
});

Deno.test('overlapping CRDT transaction writers keep one winner and no lost counter', async () => {
    await withPGliteSql(async (sql) => {
        const service = mutationService(sql);
        await apply(sql, service, await command('base', 'base', 1_000));
        const commands = await Promise.all([
            command('overlap-a', 'overlap-a', 2_000),
            command('overlap-b', 'overlap-b', 2_001)
        ]);
        const computed = await Promise.all(commands.map(async (entry) => {
            const read = await service.read(entry);
            return service.compute({ command: entry, read });
        }));
        const writes = await Promise.allSettled(
            computed.map(async (entry) => await sql.begin(async (transaction) => await service.write(transaction, entry)))
        );
        assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
        assert.equal(writes.filter((result) => result.status === 'rejected').length, 1);
        const [metadata] = await sql<CrdtDocumentCounterRow[]>`
      select update_count, last_append_sequence from crdt_documents
    `;
        assert.equal(Number(metadata?.update_count), 2);
        assert.equal(Number(metadata?.last_append_sequence), 2);
    });
});

function mutationService(sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]) {
    return createCrdtMutationService({
        repository: new PSqlCrdtMutationRepository(
            { sql, authorize: () => Promise.resolve(true) },
            { policies: [{ documentType: 'checklist', rollout: 'production' }] }
        ),
        createWriter: (transaction) =>
            new PSqlCrdtMutationRepository(
                { sql: transaction, authorize: () => Promise.resolve(true) },
                { policies: [{ documentType: 'checklist', rollout: 'production' }] }
            ),
        serviceId: 'server-1'
    });
}

function createCrdtUpdateReadRecorder(sql: PGliteSql): CrdtUpdateReadRecorder {
    const reads: RecordedSqlRead[] = [];
    const recordingSql = new Proxy(sql, {
        apply(target, thisArgument, argumentList) {
            const result = Reflect.apply(target, thisArgument, argumentList);
            return Promise.resolve(result).then((rows) => {
                if (Array.isArray(rows)) {
                    reads.push({ bindings: argumentList.slice(1), rows });
                }
                return rows;
            });
        }
    });
    return { sql: recordingSql, reads };
}

function rowCountsBoundTo(reads: readonly RecordedSqlRead[], value: unknown): number[] {
    return reads.filter((read) => read.bindings.includes(value)).map((read) => read.rows.length);
}

function rowCountsContaining(reads: readonly RecordedSqlRead[], field: string): number[] {
    return reads
        .filter((read) => read.rows.some((row) => hasOwnField(row, field)))
        .map((read) => read.rows.length);
}

function hasOwnField(value: unknown, field: string): boolean {
    return typeof value === 'object' && value !== null && Object.hasOwn(value, field);
}

async function apply(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
    service: ReturnType<typeof mutationService>,
    input: CrdtMutationCommand
) {
    const read = await service.read(input);
    const computed = service.compute({ command: input, read });
    assert.deepEqual(service.validate({ command: input, read, computed }), []);
    await sql.begin(async (transaction) => await service.write(transaction, computed));
}

async function command(commandId: string, updateId: string, capturedAtEpochMs: number) {
    return await createCrdtMutationCommand({
        operation: 'append',
        commandId,
        actor: {
            actorId: 'actor-1',
            principalId: 'client-1',
            sessionId: 'session-1',
            serverId: 'server-1'
        },
        capturedAtEpochMs,
        expireAtEpochMs: capturedAtEpochMs + 60_000,
        document: DOCUMENT,
        update: update(updateId, capturedAtEpochMs),
        authorizationScope: 'room',
        responseAudience: {
            kind: 'room',
            senderSessionId: 'session-1',
            topicId: 'room.crdt',
            contextId: 'group-1'
        }
    });
}

async function compactCommand(commandId: string, capturedAtEpochMs: number) {
    return await createCrdtMutationCommand({
        operation: 'compact',
        commandId,
        actor: {
            actorId: 'actor-1',
            principalId: 'client-1',
            sessionId: 'session-1',
            serverId: 'server-1'
        },
        capturedAtEpochMs,
        expireAtEpochMs: capturedAtEpochMs + 60_000,
        document: DOCUMENT,
        snapshotId: `${commandId}-snapshot`,
        snapshot: null,
        reason: 'append-history-read-test',
        responseAudience: {
            kind: 'admin',
            senderSessionId: 'session-1',
            topicId: 'crdt.admin',
            contextId: 'group-1'
        }
    });
}

function update(updateId: string, createdAtEpochMs: number): RallarCrdtUpdateEnvelope {
    const payload: RallarCrdtOperationBatch = {
        kind: 'batch',
        operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: updateId }]
    };
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: DOCUMENT,
        updateId,
        replicaId: 'replica-1',
        lamport: createdAtEpochMs,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs,
        payload
    };
}

function snapshot(snapshotId: string, value: unknown) {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: DOCUMENT,
        snapshotId,
        schemaVersion: 1,
        createdAtEpochMs: 10_000,
        maxLamport: 0,
        includedUpdateIds: [],
        value,
        metadata: { updateCount: 0, reason: 'app-inbox-compaction' }
    };
}
