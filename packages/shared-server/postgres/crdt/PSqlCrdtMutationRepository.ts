import {
  type RallarCrdtDocumentLifecycleState,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtTrustedAppendMetadata,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../resource-inbox/ResourceInboxRepository.ts';
import {
  type CrdtMutationCommand,
  type CrdtMutationComputedWrite,
  CrdtMutationConflictError,
  type CrdtMutationRead,
  type CrdtMutationRepository,
} from '../../rallar-system/services/crdt-mutation-contracts.ts';
import {
  type DocumentRow,
  type SnapshotRow,
  toDate,
  toFeatureDecision,
  toJson,
  toMetadata,
  toRecord,
  toSnapshot,
  type UpdateRow,
} from './crdt-mutation-row-codec.ts';

export type CrdtMutationAuthorityDecision = Readonly<{
  allowed: boolean;
  code: string;
}>;

export class PSqlCrdtMutationRepository implements CrdtMutationRepository {
  constructor(
    private readonly sql: PSqlSql,
    private readonly authorize: (
      command: CrdtMutationCommand,
    ) => Promise<boolean | CrdtMutationAuthorityDecision> = () =>
      Promise.resolve({ allowed: false, code: 'current-authority-reader-missing' }),
    private readonly policies: readonly RallarCrdtDocumentTypePolicy[] = [],
  ) {}

  async readMutation(command: CrdtMutationCommand): Promise<CrdtMutationRead> {
    const [documents, updates, records, snapshots, authority, actorRate] = await Promise.all([
      readDocument(this.sql, command.documentKey),
      command.operation === 'append'
        ? readUpdate(this.sql, command.documentKey, command.update.updateId)
        : Promise.resolve([]),
      command.operation === 'compact' || command.operation === 'rebuild-projection'
        ? readUpdates(this.sql, command.documentKey)
        : Promise.resolve([]),
      readSnapshot(this.sql, command.documentKey),
      this.authorize(command),
      command.operation === 'append'
        ? readActorUpdatesInWindow(this.sql, command)
        : Promise.resolve([{ actor_updates_in_window: 0 }]),
    ]);
    const document = documents[0]
      ? toMetadata(documents[0], command.documentKey, command.document)
      : null;
    const existingRecord = updates[0] ? toRecord(updates[0], command.document) : null;
    const snapshot = snapshots[0]
      ? toSnapshot(
        snapshots[0],
        command.documentKey,
        command.document,
        document?.lastAppendSequence ?? 0,
      )
      : null;
    const authorityDecision = typeof authority === 'boolean'
      ? { allowed: authority, code: authority ? 'allowed' : 'authorization-denied' }
      : authority;
    return {
      document,
      existingUpdate: existingRecord?.update ?? null,
      existingAppend: existingRecord?.append ?? null,
      records: records.map((row) => toRecord(row, command.document)),
      snapshot,
      authorized: authorityDecision.allowed,
      authorizationCode: authorityDecision.code,
      featureDecision: toFeatureDecision(command, this.policies),
      actorUpdatesInWindow: Number(actorRate[0]?.actor_updates_in_window ?? 0),
      storedSnapshotBytes: Number(snapshots[0]?.snapshot_bytes ?? 0),
    };
  }

  async writeMutation(computed: CrdtMutationComputedWrite): Promise<void> {
    const guarded = computed.expectedDocumentRevision === 'absent'
      ? await insertDocument(this.sql, computed.document)
      : await updateDocument(
        this.sql,
        computed.document,
        computed.expectedDocumentRevision,
        computed.expectedDocumentLifecycle,
        computed.expectedAppendSequence,
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
        select document_key, application_id, workspace_id, document_scope,
               document_type, document_id, document_ref, document_revision, lifecycle,
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
        select document_key, update_id, append_sequence, update_envelope, accepted_update_hash,
               actor_id, principal_id, session_id, server_id, authorization_scope,
               accepted_at_ts
        from crdt_updates
        where document_key = ${documentKey} and update_id = ${updateId}
        limit 1
    `;
}

async function readUpdates(sql: PSqlSql, documentKey: string): Promise<UpdateRow[]> {
  return await sql<UpdateRow[]>`
        select document_key, update_id, append_sequence, update_envelope, accepted_update_hash,
               actor_id, principal_id, session_id, server_id, authorization_scope,
               accepted_at_ts
        from crdt_updates
        where document_key = ${documentKey}
        order by append_sequence
    `;
}

async function readSnapshot(sql: PSqlSql, documentKey: string): Promise<SnapshotRow[]> {
  return await sql<SnapshotRow[]>`
        select document_key, snapshot_id, append_sequence, snapshot_envelope,
               created_at_ts, reason,
               sum(octet_length(snapshot_envelope)) over () as snapshot_bytes
        from crdt_snapshots
        where document_key = ${documentKey}
        order by append_sequence desc, created_at_ts desc
        limit 1
    `;
}

async function readActorUpdatesInWindow(
  sql: PSqlSql,
  command: Extract<CrdtMutationCommand, { operation: 'append' }>,
): Promise<Readonly<{ actor_updates_in_window: number | string }>[]> {
  return await sql<Readonly<{ actor_updates_in_window: number | string }>[]>`
        select count(*) as actor_updates_in_window
        from crdt_updates
        where document_key = ${command.documentKey}
          and actor_id = ${command.actor.actorId}
          and accepted_at_ts > ${new Date(command.capturedAtEpochMs - 60_000)}
          and accepted_at_ts <= ${new Date(command.capturedAtEpochMs)}
    `;
}

async function insertDocument(
  sql: PSqlSql,
  metadata: RallarCrdtDocumentMetadata,
): Promise<boolean> {
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
  expectedLifecycle: RallarCrdtDocumentLifecycleState | 'absent',
  expectedAppendSequence: number | 'absent',
): Promise<boolean> {
  if (expectedLifecycle === 'absent' || expectedAppendSequence === 'absent') return false;
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
          and lifecycle = ${expectedLifecycle}
          and last_append_sequence = ${expectedAppendSequence}
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
            ${snapshot.metadata.reason ?? 'app-inbox-compaction'}
        )
    `;
}
