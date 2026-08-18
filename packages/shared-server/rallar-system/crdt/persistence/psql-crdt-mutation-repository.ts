import {
  byteLengthOfRallarCrdtJson,
  type RallarCrdtDocumentLifecycleState,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtTrustedAppendMetadata,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../../postgres/PostgresSqlClient.ts';
// prettier-ignore
import { ResourceInboxRepository } from '../../../postgres/resource-inbox/\
ResourceInboxRepository.ts';
import {
  type CrdtCanonicalSnapshotEnvelope,
  type CrdtMutationCommand,
  type CrdtMutationComputedWrite,
  CrdtMutationConflictError,
  type CrdtMutationRead,
  type CrdtMutationRepository,
} from '../mutation/crdt-mutation-contracts.ts';
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

export interface CrdtMutationAuthorityDecision {
  readonly allowed: boolean;
  readonly code: string;
}

export type ReadCrdtMutationAuthority = (
  command: CrdtMutationCommand,
) => Promise<boolean | CrdtMutationAuthorityDecision>;

export namespace PSqlCrdtMutationRepository {
  export interface Dependencies {
    readonly sql: PSqlSql;
    readonly authorize: ReadCrdtMutationAuthority;
  }

  export interface Config {
    readonly policies: readonly RallarCrdtDocumentTypePolicy[];
  }
}

export class PSqlCrdtMutationRepository implements CrdtMutationRepository {
  private readonly sql: PSqlSql;
  private readonly authorize: ReadCrdtMutationAuthority;
  private readonly policies: readonly RallarCrdtDocumentTypePolicy[];

  constructor(
    dependencies: PSqlCrdtMutationRepository.Dependencies,
    config: PSqlCrdtMutationRepository.Config,
  ) {
    this.sql = dependencies.sql;
    this.authorize = dependencies.authorize;
    this.policies = config.policies;
  }

  async readMutation(command: CrdtMutationCommand): Promise<CrdtMutationRead> {
    const beforeRows = await readDocument(this.sql, command.documentKey);
    const [records, snapshots, authority, actorRate] = await Promise.all([
      readUpdates(this.sql, command.documentKey),
      readSnapshot(this.sql, command.documentKey),
      this.authorize(command),
      command.operation === 'append'
        ? readActorUpdatesInWindow(this.sql, command)
        : Promise.resolve([{ actor_updates_in_window: 0 }]),
    ]);
    const afterRows = await readDocument(this.sql, command.documentKey);
    if (!sameDocumentGuard(beforeRows[0], afterRows[0])) {
      throw new CrdtMutationConflictError(command.documentKey);
    }
    const document = beforeRows[0]
      ? toMetadata(beforeRows[0], command.documentKey, command.document)
      : null;
    const decodedRecords = records.map((row) => toRecord(row, command.document));
    validateReadSet({ document, records: decodedRecords, snapshots });
    const existingRecord =
      command.operation === 'append'
        ? (decodedRecords.find((record) => record.update.updateId === command.update.updateId) ??
          null)
        : null;
    const snapshot = snapshots[0]
      ? toSnapshot({
          row: snapshots[0],
          expectedDocumentKey: command.documentKey,
          expectedDocument: command.document,
          lastAppendSequence: document?.lastAppendSequence ?? 0,
        })
      : null;
    const authorityDecision =
      typeof authority === 'boolean'
        ? { allowed: authority, code: authority ? 'allowed' : 'authorization-denied' }
        : authority;
    return {
      document,
      existingUpdate: existingRecord?.update ?? null,
      existingAppend: existingRecord?.append ?? null,
      records: decodedRecords,
      snapshot,
      authorized: authorityDecision.allowed,
      authorizationCode: authorityDecision.code,
      featureDecision: toFeatureDecision(command, this.policies),
      actorUpdatesInWindow: Number(actorRate[0]?.actor_updates_in_window ?? 0),
      storedSnapshotBytes: Number(snapshots[0]?.snapshot_bytes ?? 0),
    };
  }

  async writeMutation(computed: CrdtMutationComputedWrite): Promise<void> {
    const guarded =
      computed.expectedDocumentRevision === 'absent'
        ? await insertDocument(this.sql, computed.document)
        : await updateDocument({
            sql: this.sql,
            metadata: computed.document,
            expectedRevision: computed.expectedDocumentRevision,
            expectedLifecycle: computed.expectedDocumentLifecycle,
            expectedAppendSequence: computed.expectedAppendSequence,
          });
    if (!guarded) {
      throw new CrdtMutationConflictError(computed.documentKey);
    }
    if (computed.update && computed.append) {
      await insertUpdate({
        sql: this.sql,
        documentKey: computed.documentKey,
        update: computed.update,
        append: computed.append,
      });
    }
    if (computed.snapshot) {
      await insertSnapshot({
        sql: this.sql,
        documentKey: computed.documentKey,
        snapshot: computed.snapshot,
        appendSequence: computed.document.lastAppendSequence,
      });
    }
  }

  async writeOutbox(entries: readonly ResourceEntry[]): Promise<void> {
    const outbox = new ResourceInboxRepository(this.sql);
    for (const entry of entries) {
      await outbox.write(entry);
    }
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
               sum(octet_length(snapshot_envelope)) over () as snapshot_bytes,
               count(*) over () as snapshot_count
        from crdt_snapshots
        where document_key = ${documentKey}
        order by append_sequence desc, created_at_ts desc
        limit 1
    `;
}

function sameDocumentGuard(left: DocumentRow | undefined, right: DocumentRow | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.document_key === right.document_key &&
    Number(left.document_revision) === Number(right.document_revision) &&
    left.lifecycle === right.lifecycle &&
    Number(left.last_append_sequence) === Number(right.last_append_sequence) &&
    Number(left.update_count) === Number(right.update_count) &&
    Number(left.snapshot_count) === Number(right.snapshot_count) &&
    Number(left.stored_update_bytes) === Number(right.stored_update_bytes)
  );
}

interface ValidateReadSetInput {
  readonly document: RallarCrdtDocumentMetadata | null;
  readonly records: readonly ReturnType<typeof toRecord>[];
  readonly snapshots: readonly SnapshotRow[];
}

function validateReadSet(input: ValidateReadSetInput): void {
  const { document, records, snapshots } = input;
  if (!document) {
    if (records.length > 0 || snapshots.length > 0) {
      throw new TypeError('CRDT persisted read set has children without a document');
    }
    return;
  }
  const sequences = records.map((record) => record.append.appendSequence);
  if (
    records.length !== document.updateCount ||
    (sequences.at(-1) ?? 0) !== document.lastAppendSequence ||
    sequences.some((sequence, index) => sequence !== index + 1) ||
    records.reduce((bytes, record) => bytes + byteLengthOfRallarCrdtJson(record.update), 0) !==
      document.storedUpdateBytes ||
    Number(snapshots[0]?.snapshot_count ?? 0) !== document.snapshotCount
  ) {
    throw new TypeError('CRDT persisted read set differs from document counters');
  }
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

interface UpdateDocumentInput {
  readonly sql: PSqlSql;
  readonly metadata: RallarCrdtDocumentMetadata;
  readonly expectedRevision: number;
  readonly expectedLifecycle: RallarCrdtDocumentLifecycleState | 'absent';
  readonly expectedAppendSequence: number | 'absent';
}

async function updateDocument(input: UpdateDocumentInput): Promise<boolean> {
  const { sql, metadata, expectedRevision, expectedLifecycle, expectedAppendSequence } = input;
  if (expectedLifecycle === 'absent' || expectedAppendSequence === 'absent') {
    return false;
  }
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

interface InsertUpdateInput {
  readonly sql: PSqlSql;
  readonly documentKey: string;
  readonly update: RallarCrdtUpdateEnvelope;
  readonly append: RallarCrdtTrustedAppendMetadata;
}

async function insertUpdate(input: InsertUpdateInput): Promise<void> {
  const { sql, documentKey, update, append } = input;
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

interface InsertSnapshotInput {
  readonly sql: PSqlSql;
  readonly documentKey: string;
  readonly snapshot: CrdtCanonicalSnapshotEnvelope;
  readonly appendSequence: number;
}

async function insertSnapshot(input: InsertSnapshotInput): Promise<void> {
  const { sql, documentKey, snapshot, appendSequence } = input;
  await sql`
        insert into crdt_snapshots (
            document_key, snapshot_id, append_sequence, snapshot_envelope,
            created_at_ts, reason
        ) values (
            ${documentKey}, ${snapshot.snapshotId}, ${appendSequence},
            ${JSON.stringify(snapshot)}, ${new Date(snapshot.createdAtEpochMs)},
            ${snapshot.metadata.reason}
        )
    `;
}
