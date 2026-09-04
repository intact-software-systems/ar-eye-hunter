import {
    byteLengthOfRallarCrdtJson,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentTypePolicy
} from '@shared/crdt/mod.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { writeAppOutboxInsert, type AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { CrdtMutationConflictError } from '../mutation/crdt-mutation-contracts.ts';
import {
    type CrdtDocumentWrite,
    type CrdtMutationCommand,
    type CrdtMutationComputed,
    type CrdtMutationComputedWrite,
    type CrdtMutationRead,
    type CrdtMutationRepository,
    type CrdtMutationResult,
    type CrdtSnapshotWrite,
    type CrdtUpdateWrite
} from '../mutation/crdt-mutation-contracts.ts';
import { evaluateCrdtMutationFeatureDecision } from '../mutation/evaluate-crdt-mutation-feature-decision.ts';
import { decodeCrdtDocumentRow, type CrdtDocumentRow } from './row-decoding/decode-crdt-document-row.ts';
import { decodeCrdtSnapshotRow, type CrdtSnapshotRow } from './row-decoding/decode-crdt-snapshot-row.ts';
import { decodeCrdtUpdateRow, type CrdtUpdateRow } from './row-decoding/decode-crdt-update-row.ts';

export interface CrdtMutationAuthorityDecision {
    readonly allowed: boolean;
    readonly code: string;
}

export type ReadCrdtMutationAuthority = (
    command: CrdtMutationCommand
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
        config: PSqlCrdtMutationRepository.Config
    ) {
        this.sql = dependencies.sql;
        this.authorize = dependencies.authorize;
        this.policies = config.policies;
    }

    async readMutation(command: CrdtMutationCommand): Promise<CrdtMutationRead> {
        const beforeRows = await readDocument(this.sql, command.documentKey);
        const [updateRows, snapshots, authority, actorRate] = await Promise.all([
            readMutationUpdates(this.sql, command),
            readSnapshot(this.sql, command.documentKey),
            this.authorize(command),
            command.operation === 'append'
                ? readActorUpdatesInWindow(this.sql, command)
                : Promise.resolve([{ actor_updates_in_window: 0 }])
        ]);
        const afterRows = await readDocument(this.sql, command.documentKey);
        if (!sameDocumentGuard(beforeRows[0], afterRows[0])) {
            throw new CrdtMutationConflictError(command.documentKey);
        }
        const document = beforeRows[0]
            ? decodeCrdtDocumentRow({
                row: beforeRows[0],
                expectedDocumentKey: command.documentKey,
                expectedDocument: command.document
            })
            : null;
        const decodedRecords = updateRows.history.map((row) =>
            decodeCrdtUpdateRow({ row, document: command.document })
        );
        const existingRecord = updateRows.candidate
            ? decodeCrdtUpdateRow({ row: updateRows.candidate, document: command.document })
            : null;
        validateReadSet({
            document,
            records: decodedRecords,
            appendCandidate: existingRecord,
            snapshots,
            scope: updateRows.scope
        });
        const snapshot = snapshots[0]
            ? decodeCrdtSnapshotRow({
                row: snapshots[0],
                expectedDocumentKey: command.documentKey,
                expectedDocument: command.document,
                lastAppendSequence: document?.lastAppendSequence ?? 0
            })
            : null;
        const authorityDecision = typeof authority === 'boolean'
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
            featureDecision: evaluateCrdtMutationFeatureDecision({
                command,
                policies: this.policies
            }),
            actorUpdatesInWindow: Number(actorRate[0]?.actor_updates_in_window ?? 0),
            storedSnapshotBytes: Number(snapshots[0]?.snapshot_bytes ?? 0)
        };
    }

    async writeMutation(computed: CrdtMutationComputedWrite): Promise<void> {
        await writeCrdtMutationRows(this.sql, computed);
    }

    async writeOutbox(writes: readonly AppOutboxInsert[]): Promise<void> {
        await writeCrdtOutbox(this.sql, writes);
    }
}

export async function writePSqlCrdtMutation(
    transaction: PSqlSql,
    computed: CrdtMutationComputed
): Promise<CrdtMutationResult> {
    if (computed.outcome === 'write') {
        await writeCrdtMutationRows(transaction, computed);
    }
    await writeCrdtOutbox(transaction, computed.outboxWrites);
    return computed.result;
}

async function writeCrdtMutationRows(
    sql: PSqlSql,
    computed: CrdtMutationComputedWrite
): Promise<void> {
    const guarded = computed.documentWrite.operation === 'insert'
        ? await insertDocument(sql, computed.documentWrite)
        : await updateDocument(sql, computed.documentWrite);
    if (!guarded) {
        throw computed.conflict;
    }
    if (computed.updateWrite) {
        await insertUpdate(sql, computed.updateWrite);
    }
    if (computed.snapshotWrite) {
        await insertSnapshot(sql, computed.snapshotWrite);
    }
}

async function writeCrdtOutbox(
    transaction: PSqlSql,
    writes: readonly AppOutboxInsert[]
): Promise<void> {
    for (const write of writes) {
        await writeAppOutboxInsert(transaction, write);
    }
}

async function readDocument(sql: PSqlSql, documentKey: string): Promise<CrdtDocumentRow[]> {
    return await sql<CrdtDocumentRow[]>`
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

interface AppendLocalCrdtMutationUpdateRows {
    readonly scope: 'append-local';
    readonly candidate: CrdtUpdateRow | undefined;
    readonly history: readonly [];
}

interface CompleteCrdtMutationUpdateHistory {
    readonly scope: 'complete-history';
    readonly candidate: undefined;
    readonly history: readonly CrdtUpdateRow[];
}

type CrdtMutationUpdateRows = AppendLocalCrdtMutationUpdateRows | CompleteCrdtMutationUpdateHistory;

async function readMutationUpdates(
    sql: PSqlSql,
    command: CrdtMutationCommand
): Promise<CrdtMutationUpdateRows> {
    if (command.operation === 'append') {
        return {
            scope: 'append-local',
            candidate: await readAppendUpdate(sql, command.documentKey, command.update.updateId),
            history: []
        };
    }
    return {
        scope: 'complete-history',
        candidate: undefined,
        history: await readCompleteUpdateHistory(sql, command.documentKey)
    };
}

async function readAppendUpdate(
    sql: PSqlSql,
    documentKey: string,
    updateId: string
): Promise<CrdtUpdateRow | undefined> {
    const rows = await sql<CrdtUpdateRow[]>`
        select document_key, update_id, append_sequence, update_envelope, accepted_update_hash,
               actor_id, principal_id, session_id, server_id, authorization_scope,
               accepted_at_ts
        from crdt_updates
        where document_key = ${documentKey}
          and update_id = ${updateId}
        limit 1
    `;
    return rows[0];
}

async function readCompleteUpdateHistory(sql: PSqlSql, documentKey: string): Promise<CrdtUpdateRow[]> {
    return await sql<CrdtUpdateRow[]>`
        select document_key, update_id, append_sequence, update_envelope, accepted_update_hash,
               actor_id, principal_id, session_id, server_id, authorization_scope,
               accepted_at_ts
        from crdt_updates
        where document_key = ${documentKey}
        order by append_sequence
    `;
}

async function readSnapshot(sql: PSqlSql, documentKey: string): Promise<CrdtSnapshotRow[]> {
    return await sql<CrdtSnapshotRow[]>`
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

function sameDocumentGuard(
    left: CrdtDocumentRow | undefined,
    right: CrdtDocumentRow | undefined
): boolean {
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
    readonly records: readonly ReturnType<typeof decodeCrdtUpdateRow>[];
    readonly appendCandidate: ReturnType<typeof decodeCrdtUpdateRow> | null;
    readonly snapshots: readonly CrdtSnapshotRow[];
    readonly scope: CrdtMutationUpdateRows['scope'];
}

function validateReadSet(input: ValidateReadSetInput): void {
    const { document, records, appendCandidate, snapshots, scope } = input;
    if (!document) {
        if (records.length > 0 || appendCandidate || snapshots.length > 0) {
            throw new TypeError('CRDT persisted read set has children without a document');
        }
        return;
    }
    if (
        Number(snapshots[0]?.snapshot_count ?? 0) !== document.snapshotCount ||
        (appendCandidate !== null &&
            (appendCandidate.append.appendSequence > document.lastAppendSequence ||
                appendCandidate.append.appendSequence > document.updateCount))
    ) {
        throw new TypeError('CRDT persisted read set differs from document counters');
    }
    if (scope === 'append-local') {
        return;
    }
    const sequences = records.map((record) => record.append.appendSequence);
    if (
        records.length !== document.updateCount ||
        (sequences.at(-1) ?? 0) !== document.lastAppendSequence ||
        sequences.some((sequence, index) => sequence !== index + 1) ||
        records.reduce((bytes, record) => bytes + byteLengthOfRallarCrdtJson(record.update), 0) !==
            document.storedUpdateBytes
    ) {
        throw new TypeError('CRDT persisted read set differs from document counters');
    }
}

interface ActorUpdatesInWindowRow {
    readonly actor_updates_in_window: number | string;
}

interface DocumentKeyRow {
    readonly document_key: string;
}

async function readActorUpdatesInWindow(
    sql: PSqlSql,
    command: Extract<CrdtMutationCommand, { operation: 'append'; }>
): Promise<readonly ActorUpdatesInWindowRow[]> {
    return await sql<ActorUpdatesInWindowRow[]>`
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
    write: Extract<CrdtDocumentWrite, { operation: 'insert'; }>
): Promise<boolean> {
    const rows = await sql<DocumentKeyRow[]>`
        insert into crdt_documents (
            document_key, application_id, workspace_id, document_scope, document_type,
            document_id, document_ref, document_revision, lifecycle, created_at_ts,
            updated_at_ts, archived_at_ts, destroyed_at_ts, last_append_sequence,
            update_count, snapshot_count, stored_update_bytes, retention_policy,
            quota_policy, projection_ids
        ) values (
            ${write.documentKey}, ${write.applicationId},
            ${write.workspaceId}, ${write.scope},
            ${write.documentType}, ${write.documentId},
            ${write.documentRefJson}, ${write.documentRevision},
            ${write.lifecycle}, ${write.createdAt},
            ${write.updatedAt}, ${write.archivedAt},
            ${write.destroyedAt}, ${write.lastAppendSequence},
            ${write.updateCount}, ${write.snapshotCount}, ${write.storedUpdateBytes},
            ${write.retentionJson}, ${write.quotaJson},
            ${write.projectionIdsJson}
        ) on conflict (document_key) do nothing
        returning document_key
    `;
    return rows.length === 1;
}

async function updateDocument(
    sql: PSqlSql,
    write: Extract<CrdtDocumentWrite, { operation: 'update'; }>
): Promise<boolean> {
    const rows = await sql<DocumentKeyRow[]>`
        update crdt_documents
        set document_revision = ${write.documentRevision}, lifecycle = ${write.lifecycle},
            updated_at_ts = ${write.updatedAt},
            archived_at_ts = ${write.archivedAt},
            destroyed_at_ts = ${write.destroyedAt},
            last_append_sequence = ${write.lastAppendSequence},
            update_count = ${write.updateCount}, snapshot_count = ${write.snapshotCount},
            stored_update_bytes = ${write.storedUpdateBytes},
            retention_policy = ${write.retentionJson},
            quota_policy = ${write.quotaJson},
            projection_ids = ${write.projectionIdsJson}
        where document_key = ${write.documentKey}
          and document_revision = ${write.expectedRevision}
          and lifecycle = ${write.expectedLifecycle}
          and last_append_sequence = ${write.expectedAppendSequence}
        returning document_key
    `;
    return rows.length === 1;
}

async function insertUpdate(sql: PSqlSql, write: CrdtUpdateWrite): Promise<void> {
    await sql`
        insert into crdt_updates (
            document_key, append_sequence, update_id, update_envelope,
            accepted_update_hash, actor_id, principal_id, session_id, server_id,
            authorization_scope, accepted_at_ts
        ) values (
            ${write.documentKey}, ${write.appendSequence}, ${write.updateId},
            ${write.updateEnvelopeJson}, ${write.acceptedUpdateHash}, ${write.actorId},
            ${write.principalId}, ${write.sessionId}, ${write.serverId},
            ${write.authorizationScope}, ${write.acceptedAt}
        )
    `;
}

async function insertSnapshot(sql: PSqlSql, write: CrdtSnapshotWrite): Promise<void> {
    await sql`
        insert into crdt_snapshots (
            document_key, snapshot_id, append_sequence, snapshot_envelope,
            created_at_ts, reason
        ) values (
            ${write.documentKey}, ${write.snapshotId}, ${write.appendSequence},
            ${write.snapshotEnvelopeJson}, ${write.createdAt},
            ${write.reason}
        )
    `;
}
