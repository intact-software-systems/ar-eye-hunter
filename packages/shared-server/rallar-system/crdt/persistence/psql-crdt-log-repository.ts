import {
    createRallarCrdtAdminDocumentStatus,
    createRallarCrdtBackupBundle,
    createRallarCrdtDebugBundle,
    evaluateRallarCrdtFeaturePolicy,
    fromRallarCrdtAppendCursor,
    toRallarCrdtAppendCursor,
    toRallarCrdtDocumentKey,
    verifyRallarCrdtDebugBundle,
    type RallarCrdtAdminReadRepository,
    type RallarCrdtAuditEventKind,
    type RallarCrdtAuditSink,
    type RallarCrdtBackupBundle,
    type RallarCrdtBackupBundleExportOptions,
    type RallarCrdtDebugBundle,
    type RallarCrdtDebugBundleExportOptions,
    type RallarCrdtDocumentAdminPage,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtDurableUpdateRecord,
    type RallarCrdtIntegrityReport,
    type RallarCrdtListDocumentsInput,
    type RallarCrdtListUpdatesInput,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtUpdatePage
} from '@shared/crdt/mod.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    decodeCrdtDocumentRow,
    decodeStoredCrdtDocumentRow,
    type CrdtDocumentRow
} from './row-decoding/decode-crdt-document-row.ts';
import { decodeCrdtSnapshotRow, type CrdtSnapshotRow } from './row-decoding/decode-crdt-snapshot-row.ts';
import { decodeCrdtUpdateRow, type CrdtUpdateRow } from './row-decoding/decode-crdt-update-row.ts';

export interface PSqlCrdtLogRepositoryOptions {
    readonly now?: () => number;
    readonly policies?: readonly RallarCrdtDocumentTypePolicy[];
    readonly audit?: RallarCrdtAuditSink;
}

export class PSqlCrdtLogRepository implements RallarCrdtAdminReadRepository {
    private readonly now: () => number;
    private readonly policies: readonly RallarCrdtDocumentTypePolicy[];
    private readonly audit?: RallarCrdtAuditSink;

    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql, options: PSqlCrdtLogRepositoryOptions = {}) {
        this.sql = sql;
        this.now = options.now ?? Date.now;
        this.policies = options.policies?.length
            ? options.policies
            : [{ documentType: '*', rollout: 'disabled' }];
        this.audit = options.audit;
    }

    async listAfter(input: RallarCrdtListUpdatesInput): Promise<RallarCrdtUpdatePage> {
        const documentKey = toRallarCrdtDocumentKey(input.document);
        const metadata = await this.readDocumentMetadata(input.document);
        const afterSequence = input.afterSequence ?? fromRallarCrdtAppendCursor(input.afterCursor) ?? 0;
        const limit = Math.max(0, input.limit ?? 100);
        const rows = await this.sql<CrdtUpdateRow[]>`
            select document_key,
                   append_sequence,
                   update_id,
                   update_envelope,
                   accepted_update_hash,
                   actor_id,
                   principal_id,
                   session_id,
                   server_id,
                   authorization_scope,
                   accepted_at_ts
            from crdt_updates
            where document_key = ${documentKey}
              and append_sequence > ${afterSequence}
            order by append_sequence
            limit ${limit + 1}
        `;
        if (!metadata && rows.length > 0) {
            throw new TypeError('CRDT persisted update has no document');
        }
        const selected = rows.slice(0, limit);
        const records = selected.map((row) => decodeCrdtUpdateRow({ row, document: input.document }));
        const lastSequence = records.at(-1)?.append.appendSequence;

        return {
            document: input.document,
            records,
            firstSequence: records[0]?.append.appendSequence,
            lastSequence,
            nextCursor: lastSequence !== undefined ? toRallarCrdtAppendCursor(lastSequence) : undefined,
            hasMore: rows.length > selected.length
        };
    }

    async readSnapshot(
        document: RallarCrdtDocumentRef
    ): Promise<RallarCrdtSnapshotEnvelope | undefined> {
        const documentKey = toRallarCrdtDocumentKey(document);
        const metadata = await this.readDocumentMetadata(document);
        const rows = await this.sql<CrdtSnapshotRow[]>`
            select document_key, snapshot_id, append_sequence, snapshot_envelope,
                   created_at_ts, reason,
                   sum(octet_length(snapshot_envelope)) over () as snapshot_bytes,
                   count(*) over () as snapshot_count
            from crdt_snapshots
            where document_key = ${documentKey}
            order by append_sequence desc, created_at_ts desc
            limit 1
        `;
        if (!metadata) {
            if (rows.length > 0) {
                throw new TypeError('CRDT persisted snapshot has no document');
            }
            return undefined;
        }
        if (Number(rows[0]?.snapshot_count ?? 0) !== metadata.snapshotCount) {
            throw new TypeError('CRDT persisted snapshot count differs from document');
        }
        return rows[0]
            ? decodeCrdtSnapshotRow({
                row: rows[0],
                expectedDocumentKey: documentKey,
                expectedDocument: document,
                lastAppendSequence: metadata.lastAppendSequence
            })
            : undefined;
    }

    async readDocumentMetadata(
        document: RallarCrdtDocumentRef
    ): Promise<RallarCrdtDocumentMetadata | undefined> {
        return await readDocumentMetadataByKey(this.sql, toRallarCrdtDocumentKey(document), document);
    }

    async listDocuments(
        input: RallarCrdtListDocumentsInput = {}
    ): Promise<RallarCrdtDocumentAdminPage> {
        const rows = await this.sql<CrdtDocumentRow[]>`
            select document_key,
                   application_id,
                   workspace_id,
                   document_scope,
                   document_type,
                   document_id,
                   document_ref,
                   document_revision,
                   lifecycle,
                   created_at_ts,
                   updated_at_ts,
                   archived_at_ts,
                   destroyed_at_ts,
                   last_append_sequence,
                   update_count,
                   snapshot_count,
                   stored_update_bytes,
                   retention_policy,
                   quota_policy,
                   projection_ids
            from crdt_documents
            order by document_key
        `;
        const limit = Math.max(0, input.limit ?? 100);
        const documents = rows
            .map(decodeStoredCrdtDocumentRow)
            .filter((metadata) => matchesDocumentListInput(metadata, input));
        const startIndex = input.cursor
            ? documents.findIndex((metadata) => metadata.documentKey > input.cursor!)
            : 0;
        const safeStartIndex = startIndex < 0 ? documents.length : startIndex;
        const selected = documents.slice(safeStartIndex, safeStartIndex + limit);

        return {
            documents: selected.map((metadata) =>
                createRallarCrdtAdminDocumentStatus({
                    metadata,
                    rollout: this.rolloutFor(metadata.document),
                    quarantineReason: metadata.lifecycle === 'quarantined'
                        ? 'document lifecycle is quarantined'
                        : undefined
                })
            ),
            nextCursor: selected.at(-1)?.documentKey,
            hasMore: safeStartIndex + selected.length < documents.length
        };
    }

    async exportDebugBundle(
        document: RallarCrdtDocumentRef,
        options: RallarCrdtDebugBundleExportOptions = {}
    ): Promise<RallarCrdtDebugBundle> {
        const [metadata, snapshot, records] = await Promise.all([
            this.readDocumentMetadata(document),
            this.readSnapshot(document),
            this.readAllRecords(document)
        ]);
        this.recordAudit('export', toRallarCrdtDocumentKey(document), {
            reason: options.reason ?? 'operator-export',
            redacted: options.redaction?.payloadsRedacted ?? false
        });

        return createRallarCrdtDebugBundle({
            exportedAtEpochMs: options.exportedAtEpochMs ?? this.now(),
            reason: options.reason ?? 'operator-export',
            document,
            metadata,
            snapshot,
            records,
            redaction: options.redaction
        });
    }

    async exportBackupBundle(
        document: RallarCrdtDocumentRef,
        options: RallarCrdtBackupBundleExportOptions = {}
    ): Promise<RallarCrdtBackupBundle | undefined> {
        const [metadata, snapshot, records] = await Promise.all([
            this.readDocumentMetadata(document),
            this.readSnapshot(document),
            this.readAllRecords(document)
        ]);
        if (!metadata) {
            return undefined;
        }

        this.recordAudit('backup', metadata.documentKey);
        return createRallarCrdtBackupBundle({
            exportedAtEpochMs: options.exportedAtEpochMs ?? this.now(),
            document,
            metadata,
            snapshot,
            records
        });
    }

    async verifyIntegrity(document: RallarCrdtDocumentRef): Promise<RallarCrdtIntegrityReport> {
        return verifyRallarCrdtDebugBundle(
            await this.exportDebugBundle(document, {
                reason: 'integrity-check'
            })
        );
    }

    private async readAllRecords(
        document: RallarCrdtDocumentRef
    ): Promise<RallarCrdtDurableUpdateRecord[]> {
        const records: RallarCrdtDurableUpdateRecord[] = [];
        let cursor: string | undefined;

        do {
            const page = await this.listAfter({
                document,
                afterCursor: cursor,
                limit: 500
            });
            records.push(...page.records);
            cursor = page.nextCursor;
            if (!page.hasMore) {
                break;
            }
        }
        while (cursor);

        return records;
    }

    private rolloutFor(document: RallarCrdtDocumentRef) {
        return evaluateRallarCrdtFeaturePolicy({
            document,
            operation: 'durable-append',
            policies: this.policies
        }).rollout;
    }

    private recordAudit(
        kind: RallarCrdtAuditEventKind,
        documentKey: string | undefined,
        metadata?: Readonly<Record<string, string | number | boolean>>
    ): void {
        void this.audit?.record({
            kind,
            atEpochMs: this.now(),
            documentKey,
            metadata
        });
    }
}

function matchesDocumentListInput(
    metadata: RallarCrdtDocumentMetadata,
    input: RallarCrdtListDocumentsInput
): boolean {
    return (
        (input.applicationId === undefined ||
            metadata.document.applicationId === input.applicationId) &&
        (input.workspaceId === undefined || metadata.document.workspaceId === input.workspaceId) &&
        (input.scope === undefined || metadata.document.scope === input.scope) &&
        (input.documentType === undefined || metadata.document.documentType === input.documentType) &&
        (input.lifecycle === undefined || metadata.lifecycle === input.lifecycle)
    );
}

async function readDocumentMetadataByKey(
    sql: PSqlSql,
    documentKey: string,
    document: RallarCrdtDocumentRef
): Promise<RallarCrdtDocumentMetadata | undefined> {
    const rows = await sql<CrdtDocumentRow[]>`
            select document_key,
                   application_id,
                   workspace_id,
                   document_scope,
                   document_type,
                   document_id,
                   document_ref,
                   document_revision,
                   lifecycle,
                   created_at_ts,
                   updated_at_ts,
                   archived_at_ts,
                   destroyed_at_ts,
                   last_append_sequence,
                   update_count,
                   snapshot_count,
                   stored_update_bytes,
                   retention_policy,
                   quota_policy,
                   projection_ids
            from crdt_documents
            where document_key = ${documentKey}
            limit 1
        `;

    return rows[0]
        ? decodeCrdtDocumentRow({
            row: rows[0],
            expectedDocumentKey: documentKey,
            expectedDocument: document
        })
        : undefined;
}
