import {
    type RallarCrdtDocumentLifecycleState,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtDurableUpdateRecord,
    type RallarCrdtQuotaPolicy,
    type RallarCrdtRetentionPolicy,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtTrustedAppendMetadata,
    type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../resource-inbox/ResourceInboxRepository.ts';
import {
    CrdtMutationConflictError,
    type CrdtMutationCommand,
    type CrdtMutationComputedWrite,
    type CrdtMutationRead,
    type CrdtMutationRepository,
} from '../../rallar-system/services/crdt-mutation-contracts.ts';

type DocumentRow = Readonly<{
    document_key: string;
    document_ref: string;
    document_revision: number | string;
    lifecycle: string;
    created_at_ts: Date | string;
    updated_at_ts: Date | string;
    archived_at_ts: Date | string | null;
    destroyed_at_ts: Date | string | null;
    last_append_sequence: number | string;
    update_count: number | string;
    snapshot_count: number | string;
    stored_update_bytes: number | string;
    retention_policy: string | null;
    quota_policy: string | null;
    projection_ids: string | null;
}>;

type UpdateRow = Readonly<{
    document_key: string;
    append_sequence: number | string;
    update_envelope: string;
    accepted_update_hash: string;
    actor_id: string | null;
    principal_id: string | null;
    session_id: string | null;
    server_id: string | null;
    authorization_scope: string;
    accepted_at_ts: Date | string;
}>;

type SnapshotRow = Readonly<{ snapshot_envelope: string }>;

export class PSqlCrdtMutationRepository implements CrdtMutationRepository {
    constructor(
        private readonly sql: PSqlSql,
        private readonly authorize: (command: CrdtMutationCommand) => Promise<boolean> =
            () => Promise.resolve(true),
    ) {}

    async readMutation(command: CrdtMutationCommand): Promise<CrdtMutationRead> {
        const [documents, updates, records, snapshots, authorized] = await Promise.all([
            readDocument(this.sql, command.documentKey),
            command.operation === 'append'
                ? readUpdate(this.sql, command.documentKey, command.update.updateId)
                : Promise.resolve([]),
            command.operation === 'compact' || command.operation === 'rebuild-projection'
                ? readUpdates(this.sql, command.documentKey)
                : Promise.resolve([]),
            readSnapshot(this.sql, command.documentKey),
            this.authorize(command),
        ]);
        return {
            document: documents[0] ? toMetadata(documents[0]) : null,
            existingUpdate: updates[0]
                ? JSON.parse(updates[0].update_envelope) as RallarCrdtUpdateEnvelope
                : null,
            records: records.map((row) => toRecord(row, command.document)),
            snapshot: snapshots[0]
                ? JSON.parse(snapshots[0].snapshot_envelope) as RallarCrdtSnapshotEnvelope
                : null,
            authorized,
        };
    }

    async writeMutation(computed: CrdtMutationComputedWrite): Promise<void> {
        const guarded = computed.expectedDocumentRevision === 'absent'
            ? await insertDocument(this.sql, computed.document)
            : await updateDocument(
                this.sql,
                computed.document,
                computed.expectedDocumentRevision,
            );
        if (!guarded) throw new CrdtMutationConflictError(computed.documentKey);
        if (computed.update && computed.append) {
            await insertUpdate(this.sql, computed.documentKey, computed.update, computed.append);
        }
        if (computed.snapshot) {
            await insertSnapshot(
                this.sql,
                computed.documentKey,
                computed.snapshot,
                computed.document.lastAppendSequence,
            );
        }
    }

    async writeOutbox(entries: readonly ResourceEntry[]): Promise<void> {
        const outbox = new ResourceInboxRepository(this.sql);
        for (const entry of entries) await outbox.writeIfAbsentOrMatch(entry);
    }
}

async function readDocument(sql: PSqlSql, documentKey: string): Promise<DocumentRow[]> {
    return await sql<DocumentRow[]>`
        select document_key, document_ref, document_revision, lifecycle,
               created_at_ts, updated_at_ts, archived_at_ts, destroyed_at_ts,
               last_append_sequence, update_count, snapshot_count, stored_update_bytes,
               retention_policy, quota_policy, projection_ids
        from crdt_documents
        where document_key = ${documentKey}
        limit 1
    `;
}

async function readUpdate(
    sql: PSqlSql,
    documentKey: string,
    updateId: string,
): Promise<(UpdateRow & { update_envelope: string })[]> {
    return await sql<(UpdateRow & { update_envelope: string })[]>`
        select document_key, append_sequence, update_envelope, accepted_update_hash,
               actor_id, principal_id, session_id, server_id, authorization_scope,
               accepted_at_ts
        from crdt_updates
        where document_key = ${documentKey} and update_id = ${updateId}
        limit 1
    `;
}

async function readUpdates(sql: PSqlSql, documentKey: string): Promise<UpdateRow[]> {
    return await sql<UpdateRow[]>`
        select document_key, append_sequence, update_envelope, accepted_update_hash,
               actor_id, principal_id, session_id, server_id, authorization_scope,
               accepted_at_ts
        from crdt_updates
        where document_key = ${documentKey}
        order by append_sequence
    `;
}

async function readSnapshot(sql: PSqlSql, documentKey: string): Promise<SnapshotRow[]> {
    return await sql<SnapshotRow[]>`
        select snapshot_envelope
        from crdt_snapshots
        where document_key = ${documentKey}
        order by append_sequence desc, created_at_ts desc
        limit 1
    `;
}

async function insertDocument(sql: PSqlSql, metadata: RallarCrdtDocumentMetadata): Promise<boolean> {
    const rows = await sql<{ document_key: string }[]>`
        insert into crdt_documents (
            document_key, application_id, workspace_id, document_scope, document_type,
            document_id, document_ref, document_revision, lifecycle, created_at_ts,
            updated_at_ts, archived_at_ts, destroyed_at_ts, last_append_sequence,
            update_count, snapshot_count, stored_update_bytes, retention_policy,
            quota_policy, projection_ids
        ) values (
            ${metadata.documentKey}, ${metadata.document.applicationId},
            ${metadata.document.workspaceId}, ${metadata.document.scope},
            ${metadata.document.documentType}, ${metadata.document.documentId},
            ${JSON.stringify(metadata.document)}, ${metadata.documentRevision},
            ${metadata.lifecycle}, ${new Date(metadata.createdAtEpochMs)},
            ${new Date(metadata.updatedAtEpochMs)}, ${toDate(metadata.archivedAtEpochMs)},
            ${toDate(metadata.destroyedAtEpochMs)}, ${metadata.lastAppendSequence},
            ${metadata.updateCount}, ${metadata.snapshotCount}, ${metadata.storedUpdateBytes},
            ${toJson(metadata.retention)}, ${toJson(metadata.quota)},
            ${JSON.stringify(metadata.projectionIds)}
        ) on conflict (document_key) do nothing
        returning document_key
    `;
    return rows.length === 1;
}

async function updateDocument(
    sql: PSqlSql,
    metadata: RallarCrdtDocumentMetadata,
    expectedRevision: number,
): Promise<boolean> {
    const rows = await sql<{ document_key: string }[]>`
        update crdt_documents
        set document_revision = ${metadata.documentRevision}, lifecycle = ${metadata.lifecycle},
            updated_at_ts = ${new Date(metadata.updatedAtEpochMs)},
            archived_at_ts = ${toDate(metadata.archivedAtEpochMs)},
            destroyed_at_ts = ${toDate(metadata.destroyedAtEpochMs)},
            last_append_sequence = ${metadata.lastAppendSequence},
            update_count = ${metadata.updateCount}, snapshot_count = ${metadata.snapshotCount},
            stored_update_bytes = ${metadata.storedUpdateBytes},
            retention_policy = ${toJson(metadata.retention)},
            quota_policy = ${toJson(metadata.quota)},
            projection_ids = ${JSON.stringify(metadata.projectionIds)}
        where document_key = ${metadata.documentKey}
          and document_revision = ${expectedRevision}
        returning document_key
    `;
    return rows.length === 1;
}

async function insertUpdate(
    sql: PSqlSql,
    documentKey: string,
    update: RallarCrdtUpdateEnvelope,
    append: RallarCrdtTrustedAppendMetadata,
): Promise<void> {
    await sql`
        insert into crdt_updates (
            document_key, append_sequence, update_id, update_envelope,
            accepted_update_hash, actor_id, principal_id, session_id, server_id,
            authorization_scope, accepted_at_ts
        ) values (
            ${documentKey}, ${append.appendSequence}, ${update.updateId},
            ${JSON.stringify(update)}, ${append.acceptedUpdateHash}, ${append.actorId},
            ${append.principalId}, ${append.sessionId}, ${append.serverId},
            ${append.authorizationScope}, ${new Date(append.acceptedAtEpochMs)}
        )
    `;
}

async function insertSnapshot(
    sql: PSqlSql,
    documentKey: string,
    snapshot: RallarCrdtSnapshotEnvelope,
    appendSequence: number,
): Promise<void> {
    await sql`
        insert into crdt_snapshots (
            document_key, snapshot_id, append_sequence, snapshot_envelope,
            created_at_ts, reason
        ) values (
            ${documentKey}, ${snapshot.snapshotId}, ${appendSequence},
            ${JSON.stringify(snapshot)}, ${new Date(snapshot.createdAtEpochMs)},
            ${'app-inbox-compaction'}
        )
    `;
}

function toMetadata(row: DocumentRow): RallarCrdtDocumentMetadata {
    return {
        document: JSON.parse(row.document_ref) as RallarCrdtDocumentRef,
        documentKey: row.document_key,
        documentRevision: Number(row.document_revision),
        lifecycle: row.lifecycle as RallarCrdtDocumentLifecycleState,
        createdAtEpochMs: new Date(row.created_at_ts).getTime(),
        updatedAtEpochMs: new Date(row.updated_at_ts).getTime(),
        archivedAtEpochMs: toEpoch(row.archived_at_ts),
        destroyedAtEpochMs: toEpoch(row.destroyed_at_ts),
        lastAppendSequence: Number(row.last_append_sequence),
        updateCount: Number(row.update_count),
        snapshotCount: Number(row.snapshot_count),
        storedUpdateBytes: Number(row.stored_update_bytes),
        retention: fromJson<RallarCrdtRetentionPolicy>(row.retention_policy),
        quota: fromJson<RallarCrdtQuotaPolicy>(row.quota_policy),
        projectionIds: fromJson<readonly string[]>(row.projection_ids) ?? [],
    };
}

function toRecord(row: UpdateRow, document: RallarCrdtDocumentRef): RallarCrdtDurableUpdateRecord {
    return {
        document,
        documentKey: row.document_key,
        update: JSON.parse(row.update_envelope) as RallarCrdtUpdateEnvelope,
        append: {
            appendSequence: Number(row.append_sequence),
            acceptedAtEpochMs: new Date(row.accepted_at_ts).getTime(),
            actorId: row.actor_id ?? undefined,
            principalId: row.principal_id ?? undefined,
            sessionId: row.session_id ?? undefined,
            serverId: row.server_id ?? undefined,
            authorizationScope: row.authorization_scope as RallarCrdtTrustedAppendMetadata['authorizationScope'],
            acceptedUpdateHash: row.accepted_update_hash,
        },
    };
}

function toDate(epochMs: number | null): Date | null {
    return epochMs === null ? null : new Date(epochMs);
}

function toEpoch(value: Date | string | null): number | null {
    return value === null ? null : new Date(value).getTime();
}

function toJson(value: unknown): string | null {
    return value === null ? null : JSON.stringify(value);
}

function fromJson<T>(value: string | null): T | null {
    return value === null ? null : JSON.parse(value) as T;
}
