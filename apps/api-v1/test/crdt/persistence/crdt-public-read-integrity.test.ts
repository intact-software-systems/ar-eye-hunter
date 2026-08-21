import assert from 'node:assert/strict';

import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    type RallarCrdtDocumentRef,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/\
psql-crdt-log-repository.ts';

import { PSqlCrdtMutationRepository } from '@shared-server/rallar-system/crdt/persistence/\
psql-crdt-mutation-repository.ts';

import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/\
create-crdt-mutation-service.ts';

import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/\
crdt-mutation-command-codec.ts';

import { withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1'
    }
};

interface PersistedSnapshotReasonRow {
    readonly snapshot_envelope: string;
    readonly reason: string;
}

interface DocumentKeyRow {
    readonly document_key: string;
}

Deno.test('public CRDT catch-up and debug export decode exact persisted rows', async () => {
    await withPGliteSql(async (sql) => {
        await append(sql);
        await insertSnapshot(sql);
        const repository = new PSqlCrdtLogRepository(sql, {
            policies: [{ documentType: 'checklist', rollout: 'production' }]
        });

        const page = await repository.listAfter({ document: DOCUMENT });
        const snapshot = await repository.readSnapshot(DOCUMENT);
        const bundle = await repository.exportDebugBundle(DOCUMENT);

        assert.deepEqual(page.records.map((record) => record.update.updateId), ['update-1']);
        assert.equal(snapshot?.snapshotId, 'snapshot-1');
        assert.deepEqual(bundle.records.map((record) => record.update.updateId), ['update-1']);
    });
});

Deno.test(
    'public CRDT metadata and admin listing fail closed on physical identity corruption',
    async () => {
        await withPGliteSql(async (sql) => {
            await append(sql);
            await sql`
            update crdt_documents set application_id = 'foreign-app'
        `;
            const repository = new PSqlCrdtLogRepository(sql);

            await assert.rejects(
                repository.readDocumentMetadata(DOCUMENT),
                /document|identity|corrupt/i
            );
            await assert.rejects(
                repository.listDocuments(),
                /document|identity|corrupt/i
            );
        });
    }
);

Deno.test('public CRDT catch-up fails closed on physical update identity corruption', async () => {
    await withPGliteSql(async (sql) => {
        await append(sql);
        await sql`update crdt_updates set update_id = 'physical-update-id'`;

        await assert.rejects(
            new PSqlCrdtLogRepository(sql).listAfter({ document: DOCUMENT }),
            /update|identity|corrupt/i
        );
    });
});

Deno.test(
    'public CRDT snapshot read fails closed on physical snapshot identity corruption',
    async () => {
        await withPGliteSql(async (sql) => {
            await append(sql);
            await insertSnapshot(sql);
            await sql`update crdt_snapshots set snapshot_id = 'physical-snapshot-id'`;

            await assert.rejects(
                new PSqlCrdtLogRepository(sql).readSnapshot(DOCUMENT),
                /snapshot|identity|corrupt/i
            );
        });
    }
);

Deno.test('public and mutation CRDT reads reject reason-only snapshot corruption', async () => {
    await withPGliteSql(async (sql) => {
        const { command, service } = await append(sql);
        await insertSnapshot(sql);
        await sql`update crdt_snapshots set reason = 'forged-reason'`;

        await assert.rejects(
            new PSqlCrdtLogRepository(sql).readSnapshot(DOCUMENT),
            /snapshot|identity|corrupt/i
        );
        await assert.rejects(service.read(command), /snapshot|identity|corrupt/i);
    });
});

Deno.test('public and mutation CRDT reads reject an omitted snapshot reason', async () => {
    await withPGliteSql(async (sql) => {
        const { command, service } = await append(sql);
        await insertSnapshot(sql);
        await sql`
      update crdt_snapshots
      set snapshot_envelope = ${JSON.stringify(snapshotEnvelope(undefined))},
          reason = 'legacy-import'
    `;
        const repository = new PSqlCrdtLogRepository(sql);

        await assert.rejects(repository.readSnapshot(DOCUMENT), /snapshot|identity|corrupt/i);
        await assert.rejects(service.read(command), /snapshot|identity|corrupt/i);
    });
});

Deno.test('mutation write persists one canonical snapshot reason in row and envelope', async () => {
    await withPGliteSql(async (sql) => {
        const { service } = await append(sql);
        const compact = await createCrdtMutationCommand({
            operation: 'compact',
            commandId: 'compact-with-default-reason',
            actor: {
                actorId: 'client-42',
                principalId: 'alice',
                sessionId: 'session-99',
                serverId: 'server-1'
            },
            capturedAtEpochMs: 3_000,
            expireAtEpochMs: 500_000,
            document: DOCUMENT,
            responseAudience: {
                kind: 'admin',
                senderSessionId: 'session-99',
                topicId: 'crdt.admin',
                contextId: 'group-1'
            },
            snapshotId: 'snapshot-1',
            snapshot: snapshotEnvelope(undefined),
            reason: 'app-inbox-compaction'
        });
        const read = await service.read(compact);
        const computed = service.compute({ command: compact, read });
        assert.deepEqual(service.validate({ command: compact, read, computed }), []);
        await sql.begin(async (transaction) => await service.write(transaction, computed));
        const [stored] = await sql<PersistedSnapshotReasonRow[]>`
      select snapshot_envelope, reason from crdt_snapshots
    `;

        assert.equal(stored?.reason, 'app-inbox-compaction');
        assert.equal(
            (JSON.parse(stored!.snapshot_envelope) as RallarCrdtSnapshotEnvelope).metadata.reason,
            stored?.reason
        );
    });
});

Deno.test(
    'public CRDT integrity and export fail closed instead of reporting corrupt rows',
    async () => {
        await withPGliteSql(async (sql) => {
            await append(sql);
            await sql`update crdt_updates set accepted_update_hash = 'forged-hash'`;
            const repository = new PSqlCrdtLogRepository(sql);

            await assert.rejects(
                repository.exportDebugBundle(DOCUMENT),
                /update|hash|identity|corrupt/i
            );
            await assert.rejects(
                repository.verifyIntegrity(DOCUMENT),
                /update|hash|identity|corrupt/i
            );
        });
    }
);

async function append(sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]) {
    const repository = new PSqlCrdtMutationRepository(
        { sql, authorize: () => Promise.resolve(true) },
        { policies: [{ documentType: 'checklist', rollout: 'production' }] }
    );
    const service = createCrdtMutationService({
        repository,
        createWriter: (transaction) =>
            new PSqlCrdtMutationRepository(
                { sql: transaction, authorize: () => Promise.resolve(true) },
                { policies: [{ documentType: 'checklist', rollout: 'production' }] }
            ),
        serviceId: 'server-1'
    });
    const command = await createCrdtMutationCommand({
        operation: 'append',
        commandId: 'command-1',
        actor: {
            actorId: 'client-42',
            principalId: 'alice',
            sessionId: 'session-99',
            serverId: 'server-1'
        },
        capturedAtEpochMs: 2_000,
        expireAtEpochMs: 500_000,
        document: DOCUMENT,
        responseAudience: {
            kind: 'room',
            senderSessionId: 'session-99',
            topicId: 'crdt.room',
            contextId: 'group-1'
        },
        authorizationScope: 'room',
        update: update()
    });
    const read = await service.read(command);
    const computed = service.compute({ command, read });
    assert.deepEqual(service.validate({ command, read, computed }), []);
    await sql.begin(async (transaction) => await service.write(transaction, computed));
    return { command, service };
}

async function insertSnapshot(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]
): Promise<void> {
    const snapshot = snapshotEnvelope('test-snapshot');
    const [{ document_key: documentKey }] = await sql<DocumentKeyRow[]>`
        select document_key from crdt_documents
    `;
    await sql`
        insert into crdt_snapshots (
            document_key, snapshot_id, append_sequence, snapshot_envelope,
            created_at_ts, reason
        ) values (
            ${documentKey}, ${snapshot.snapshotId}, 1, ${JSON.stringify(snapshot)},
            ${new Date(snapshot.createdAtEpochMs)}, 'test-snapshot'
        )
    `;
    await sql`update crdt_documents set snapshot_count = 1`;
}

function snapshotEnvelope(reason: string | undefined): RallarCrdtSnapshotEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: DOCUMENT,
        snapshotId: 'snapshot-1',
        schemaVersion: 1,
        createdAtEpochMs: 3_000,
        maxLamport: 1,
        includedUpdateIds: ['update-1'],
        value: { title: 'one' },
        metadata: { updateCount: 1, ...(reason === undefined ? {} : { reason }) }
    };
}

function update(): RallarCrdtUpdateEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: DOCUMENT,
        updateId: 'update-1',
        replicaId: 'replica-1',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 1_000,
        payload: {
            kind: 'batch',
            operations: [{
                kind: 'register.set',
                path: ['title'],
                policy: 'lww',
                value: 'one'
            }]
        }
    };
}
