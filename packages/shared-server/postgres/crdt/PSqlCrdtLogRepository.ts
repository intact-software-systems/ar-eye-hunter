import {
    type RallarCrdtAppendBatchInput,
    type RallarCrdtAppendBatchResult,
    type RallarCrdtAppendResult,
    type RallarCrdtAppendUpdateInput,
    type RallarCrdtBackupBundle,
    type RallarCrdtDocumentLifecycleState,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtDurableUpdateRecord,
    type RallarCrdtIntegrityReport,
    type RallarCrdtLifecycleInput,
    type RallarCrdtListDocumentsInput,
    type RallarCrdtListUpdatesInput,
    type RallarCrdtOperationBatch,
    type RallarCrdtQuotaPolicy,
    type RallarCrdtRetentionPolicy,
    type RallarCrdtRestoreResult,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtTrustedAppendMetadata,
    type RallarCrdtUpdateEnvelope,
    type RallarCrdtUpdateLogRepository,
    type RallarCrdtUpdatePage,
    type RallarCrdtValidationOptions,
    type RallarCrdtWriteSnapshotInput,
    byteLengthOfRallarCrdtJson,
    createRallarCrdtAdminDocumentStatus,
    createRallarCrdtBackupBundle,
    createRallarCrdtDebugBundle,
    evaluateRallarCrdtFeaturePolicy,
    fromRallarCrdtAppendCursor,
    hashRallarCrdtUpdateEnvelope,
    type RallarCrdtAdminLogRepository,
    type RallarCrdtDebugBundle,
    type RallarCrdtDebugBundleRedaction,
    type RallarCrdtDocumentAdminPage,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtMetricsSink,
    toRallarCrdtAppendCursor,
    toRallarCrdtDocumentKey,
    validateRallarCrdtSnapshotEnvelope,
    validateRallarCrdtUpdateEnvelope,
    verifyRallarCrdtDebugBundle,
    type RallarCrdtAuditEventKind,
    type RallarCrdtAuditSink,
} from '@shared/crdt/mod.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { readAdminCrdtLifecycle } from '../../rallar-system/admin-operations/crdt-admin-validation.ts';

export type PSqlCrdtLogRepositoryOptions = Readonly<{
    now?: () => number;
    serverId?: string;
    validation?: RallarCrdtValidationOptions;
    policies?: readonly RallarCrdtDocumentTypePolicy[];
    metrics?: RallarCrdtMetricsSink;
    audit?: RallarCrdtAuditSink;
}>;

type CrdtDocumentRow = Readonly<{
    document_key: string;
    document_ref: string;
    lifecycle: string;
    created_at_ts: Date | string;
    updated_at_ts: Date | string;
    archived_at_ts: Date | string | null;
    destroyed_at_ts: Date | string | null;
    last_append_sequence: number | string;
    update_count: number | string;
    snapshot_count: number | string;
    retention_policy: string | null;
    quota_policy: string | null;
    projection_ids: string | null;
}>;

type CrdtUpdateRow = Readonly<{
    document_key: string;
    append_sequence: number | string;
    update_id: string;
    update_envelope: string;
    accepted_update_hash: string;
    actor_id: string | null;
    principal_id: string | null;
    session_id: string | null;
    server_id: string | null;
    authorization_scope: string;
    accepted_at_ts: Date | string;
}>;

type CrdtSnapshotRow = Readonly<{
    snapshot_envelope: string;
}>;

export class PSqlCrdtLogRepository<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
    TValue = unknown,
> implements RallarCrdtAdminLogRepository<TPayload, TValue> {
    private readonly now: () => number;
    private readonly serverId?: string;
    private readonly validation?: RallarCrdtValidationOptions;
    private readonly policies: readonly RallarCrdtDocumentTypePolicy[];
    private readonly metrics?: RallarCrdtMetricsSink;
    private readonly audit?: RallarCrdtAuditSink;

    constructor(
        private readonly sql: PSqlSql,
        options: PSqlCrdtLogRepositoryOptions = {},
    ) {
        this.now = options.now ?? Date.now;
        this.serverId = options.serverId;
        this.validation = options.validation;
        this.policies = options.policies ?? [];
        this.metrics = options.metrics;
        this.audit = options.audit;
    }

    async append(
        input: RallarCrdtAppendUpdateInput<TPayload>,
    ): Promise<RallarCrdtAppendResult<TPayload>> {
        const startedAtEpochMs = this.now();
        const validation = validateRallarCrdtUpdateEnvelope(
            input.update,
            '$',
            this.validation,
        );
        if (!validation.valid) {
            return this.recordAppendResult(startedAtEpochMs, {
                status: 'rejected',
                update: input.update,
                code: 'invalid-update',
                reason: 'CRDT update envelope failed validation.',
                retryable: false,
                validation,
            });
        }

        return await this.sql.begin(
            async (tx) =>
                await this.appendInTransaction(tx, input, startedAtEpochMs),
        );
    }

    async appendBatch(
        input: RallarCrdtAppendBatchInput<TPayload>,
    ): Promise<RallarCrdtAppendBatchResult<TPayload>> {
        const expectedKey = toRallarCrdtDocumentKey(input.document);
        const results: RallarCrdtAppendResult<TPayload>[] = [];

        for (const appendInput of input.updates) {
            if (
                toRallarCrdtDocumentKey(appendInput.update.document) !==
                expectedKey
            ) {
                results.push({
                    status: 'rejected',
                    update: appendInput.update,
                    code: 'invalid-update',
                    reason: 'CRDT append batch contains an update for a different document.',
                    retryable: false,
                });
            } else {
                results.push(await this.append(appendInput));
            }

            if (
                input.stopOnFirstRejection &&
                results[results.length - 1]?.status === 'rejected'
            ) {
                break;
            }
        }

        const rejectedCount = results.filter(
            (result) => result.status === 'rejected',
        ).length;

        return {
            status:
                rejectedCount === 0
                    ? 'accepted'
                    : rejectedCount === results.length
                      ? 'rejected'
                      : 'partial',
            document: input.document,
            results,
        };
    }

    async listAfter(
        input: RallarCrdtListUpdatesInput,
    ): Promise<RallarCrdtUpdatePage<TPayload>> {
        const documentKey = toRallarCrdtDocumentKey(input.document);
        const afterSequence =
            input.afterSequence ??
            fromRallarCrdtAppendCursor(input.afterCursor) ??
            0;
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
        const selected = rows.slice(0, limit);
        const records = selected.map((row) =>
            toUpdateRecord<TPayload>(row, input.document),
        );
        const lastSequence = records.at(-1)?.append.appendSequence;

        return {
            document: input.document,
            records,
            firstSequence: records[0]?.append.appendSequence,
            lastSequence,
            nextCursor:
                lastSequence !== undefined
                    ? toRallarCrdtAppendCursor(lastSequence)
                    : undefined,
            hasMore: rows.length > selected.length,
        };
    }

    async readSnapshot(
        document: RallarCrdtDocumentRef,
    ): Promise<RallarCrdtSnapshotEnvelope<TValue> | undefined> {
        const rows = await this.sql<CrdtSnapshotRow[]>`
            select snapshot_envelope
            from crdt_snapshots
            where document_key = ${toRallarCrdtDocumentKey(document)}
            order by append_sequence desc, created_at_ts desc
            limit 1
        `;

        return rows[0]
            ? (JSON.parse(
                  rows[0].snapshot_envelope,
              ) as RallarCrdtSnapshotEnvelope<TValue>)
            : undefined;
    }

    async writeSnapshot(
        input: RallarCrdtWriteSnapshotInput<TValue>,
    ): Promise<void> {
        const validation = validateRallarCrdtSnapshotEnvelope(input.snapshot);
        if (!validation.valid) {
            throw new Error('CRDT snapshot envelope failed validation.');
        }

        const documentKey = toRallarCrdtDocumentKey(input.snapshot.document);
        await this.sql.begin(async (tx) => {
            await ensureDocument(tx, input.snapshot.document, this.now());
            const metadata = await requireDocumentMetadataByKey(
                tx,
                documentKey,
                true,
            );
            if (metadata.quota?.maxDocumentBytes !== undefined) {
                const storedBytes = await readStoredDocumentBytes(
                    tx,
                    documentKey,
                );
                const snapshotBytes = byteLengthOfRallarCrdtJson(
                    input.snapshot,
                );
                if (
                    storedBytes.updateBytes + snapshotBytes >
                    metadata.quota.maxDocumentBytes
                ) {
                    throw new Error(
                        'CRDT snapshot exceeds the document-byte quota.',
                    );
                }
            }
            await tx`
                insert into crdt_snapshots (document_key,
                                            snapshot_id,
                                            append_sequence,
                                            snapshot_envelope,
                                            created_at_ts,
                                            reason)
                values (${documentKey},
                        ${input.snapshot.snapshotId},
                        ${input.appendSequence},
                        ${serializeJson(input.snapshot)},
                        ${toPgDate(input.snapshot.createdAtEpochMs)},
                        ${input.reason})
                on conflict (document_key, snapshot_id)
                    do update set append_sequence   = excluded.append_sequence,
                                  snapshot_envelope = excluded.snapshot_envelope,
                                  created_at_ts     = excluded.created_at_ts,
                                  reason            = excluded.reason
            `;
            await tx`
                update crdt_documents
                set updated_at_ts  = ${toPgDate(input.snapshot.createdAtEpochMs)},
                    snapshot_count = (
                        select count(*)
                        from crdt_snapshots
                        where document_key = ${documentKey}
                    )
                where document_key = ${documentKey}
            `;
        });
        if (input.reason?.includes('compact')) {
            this.recordAudit('compact', documentKey, {
                appendSequence: input.appendSequence,
                reason: input.reason,
            });
        }
    }

    async readDocumentMetadata(
        document: RallarCrdtDocumentRef,
    ): Promise<RallarCrdtDocumentMetadata | undefined> {
        return await readDocumentMetadataByKey(
            this.sql,
            toRallarCrdtDocumentKey(document),
        );
    }

    async updateDocumentLifecycle(
        input: RallarCrdtLifecycleInput,
    ): Promise<RallarCrdtDocumentMetadata> {
        const lifecycle = readAdminCrdtLifecycle(input.lifecycle);
        const documentKey = toRallarCrdtDocumentKey(input.document);
        const changedAtEpochMs = input.changedAtEpochMs ?? this.now();

        const metadata = await this.sql.begin(async (tx) => {
            await ensureDocument(tx, input.document, changedAtEpochMs);
            const current = await requireDocumentMetadataByKey(tx, documentKey);
            const archivedAtEpochMs =
                lifecycle === 'archived'
                    ? changedAtEpochMs
                    : current.archivedAtEpochMs;
            const destroyedAtEpochMs =
                lifecycle === 'destroyed'
                    ? changedAtEpochMs
                    : current.destroyedAtEpochMs;

            await tx`
                update crdt_documents
                set lifecycle       = ${lifecycle},
                    updated_at_ts   = ${toPgDate(changedAtEpochMs)},
                    archived_at_ts  = ${toNullablePgDate(archivedAtEpochMs)},
                    destroyed_at_ts = ${toNullablePgDate(destroyedAtEpochMs)},
                    retention_policy = ${serializeNullableJson(
                        input.retention ?? current.retention,
                    )},
                    quota_policy     = ${serializeNullableJson(input.quota ?? current.quota)},
                    projection_ids   = ${serializeNullableJson(
                        input.projectionIds ?? current.projectionIds,
                    )}
                where document_key = ${documentKey}
            `;

            return await requireDocumentMetadataByKey(tx, documentKey);
        });
        const auditKind = toLifecycleAuditKind(lifecycle);
        if (auditKind) {
            this.recordAudit(auditKind, documentKey, {
                lifecycle,
            });
        }
        return metadata;
    }

    async listDocuments(
        input: RallarCrdtListDocumentsInput = {},
    ): Promise<RallarCrdtDocumentAdminPage> {
        const rows = await this.sql<CrdtDocumentRow[]>`
            select document_key,
                   document_ref,
                   lifecycle,
                   created_at_ts,
                   updated_at_ts,
                   archived_at_ts,
                   destroyed_at_ts,
                   last_append_sequence,
                   update_count,
                   snapshot_count,
                   retention_policy,
                   quota_policy,
                   projection_ids
            from crdt_documents
            order by document_key
        `;
        const limit = Math.max(0, input.limit ?? 100);
        const documents = rows
            .map(toDocumentMetadata)
            .filter((metadata) => matchesDocumentListInput(metadata, input));
        const startIndex = input.cursor
            ? documents.findIndex(
                  (metadata) => metadata.documentKey > input.cursor!,
              )
            : 0;
        const safeStartIndex = startIndex < 0 ? documents.length : startIndex;
        const selected = documents.slice(
            safeStartIndex,
            safeStartIndex + limit,
        );

        return {
            documents: selected.map((metadata) =>
                createRallarCrdtAdminDocumentStatus({
                    metadata,
                    rollout: this.rolloutFor(metadata.document),
                    quarantineReason:
                        metadata.lifecycle === 'quarantined'
                            ? 'document lifecycle is quarantined'
                            : undefined,
                }),
            ),
            nextCursor: selected.at(-1)?.documentKey,
            hasMore: safeStartIndex + selected.length < documents.length,
        };
    }

    async exportDebugBundle(
        document: RallarCrdtDocumentRef,
        options: Readonly<{
            reason?: string;
            exportedAtEpochMs?: number;
            redaction?: RallarCrdtDebugBundleRedaction;
        }> = {},
    ): Promise<RallarCrdtDebugBundle<TPayload>> {
        const [metadata, snapshot, records] = await Promise.all([
            this.readDocumentMetadata(document),
            this.readSnapshot(document),
            this.readAllRecords(document),
        ]);
        this.recordAudit('export', toRallarCrdtDocumentKey(document), {
            reason: options.reason ?? 'operator-export',
            redacted: options.redaction?.payloadsRedacted ?? false,
        });

        return createRallarCrdtDebugBundle({
            exportedAtEpochMs: options.exportedAtEpochMs ?? this.now(),
            reason: options.reason ?? 'operator-export',
            document,
            metadata,
            snapshot: snapshot as RallarCrdtSnapshotEnvelope | undefined,
            records,
            redaction: options.redaction,
        });
    }

    async exportBackupBundle(
        document: RallarCrdtDocumentRef,
        options: Readonly<{
            exportedAtEpochMs?: number;
        }> = {},
    ): Promise<RallarCrdtBackupBundle<TPayload> | undefined> {
        const [metadata, snapshot, records] = await Promise.all([
            this.readDocumentMetadata(document),
            this.readSnapshot(document),
            this.readAllRecords(document),
        ]);
        if (!metadata) {
            return undefined;
        }

        this.recordAudit('backup', metadata.documentKey);
        return createRallarCrdtBackupBundle({
            exportedAtEpochMs: options.exportedAtEpochMs ?? this.now(),
            document,
            metadata,
            snapshot: snapshot as RallarCrdtSnapshotEnvelope | undefined,
            records,
        });
    }

    async restoreBackupBundle(
        bundle: RallarCrdtBackupBundle<TPayload>,
        options: Readonly<{
            overwrite?: boolean;
        }> = {},
    ): Promise<RallarCrdtRestoreResult> {
        const report = verifyRallarCrdtDebugBundle(bundle);
        if (!report.valid) {
            throw new Error(
                `CRDT backup bundle failed integrity verification: ${report.issues[0]?.message}`,
            );
        }

        const result = await this.sql.begin(async (tx) => {
            const existing = await readDocumentMetadataByKey(
                tx,
                bundle.documentKey,
                true,
            );
            if (existing && !options.overwrite) {
                throw new Error(
                    `CRDT document already exists: ${bundle.documentKey}`,
                );
            }
            if (existing && options.overwrite) {
                await tx`
                    delete from crdt_documents
                    where document_key = ${bundle.documentKey}
                `;
            }

            await insertDocumentMetadata(tx, bundle.metadata);
            let restoredUpdateBytes = 0;
            for (const record of bundle.records) {
                const serializedUpdate = serializeJson(record.update);
                restoredUpdateBytes += byteLengthOfSerializedJson(serializedUpdate);
                await tx`
                    insert into crdt_updates (document_key,
                                              append_sequence,
                                              update_id,
                                              update_envelope,
                                              accepted_update_hash,
                                              actor_id,
                                              principal_id,
                                              session_id,
                                              server_id,
                                              authorization_scope,
                                              accepted_at_ts)
                    values (${bundle.documentKey},
                            ${record.append.appendSequence},
                            ${record.update.updateId},
                            ${serializedUpdate},
                            ${record.append.acceptedUpdateHash},
                            ${record.append.actorId},
                            ${record.append.principalId},
                            ${record.append.sessionId},
                            ${record.append.serverId},
                            ${record.append.authorizationScope},
                            ${toPgDate(record.append.acceptedAtEpochMs)})
                `;
            }
            await tx`
                update crdt_documents
                set stored_update_bytes = ${restoredUpdateBytes}
                where document_key = ${bundle.documentKey}
            `;
            if (bundle.snapshot) {
                await tx`
                    insert into crdt_snapshots (document_key,
                                                snapshot_id,
                                                append_sequence,
                                                snapshot_envelope,
                                                created_at_ts,
                                                reason)
                    values (${bundle.documentKey},
                            ${bundle.snapshot.snapshotId},
                            ${bundle.metadata.lastAppendSequence},
                            ${serializeJson(bundle.snapshot)},
                            ${toPgDate(bundle.snapshot.createdAtEpochMs)},
                            'restore')
                `;
            }

            return {
                document: bundle.document,
                documentKey: bundle.documentKey,
                restoredUpdateCount: bundle.records.length,
                restoredSnapshot: bundle.snapshot !== undefined,
                firstAppendSequence: bundle.integrity.firstAppendSequence,
                lastAppendSequence: bundle.integrity.lastAppendSequence,
            };
        });
        this.recordAudit('restore', bundle.documentKey, {
            updateCount: bundle.records.length,
            overwrite: options.overwrite === true,
        });
        return result;
    }

    async verifyIntegrity(
        document: RallarCrdtDocumentRef,
    ): Promise<RallarCrdtIntegrityReport> {
        return verifyRallarCrdtDebugBundle(
            await this.exportDebugBundle(document, {
                reason: 'integrity-check',
            }),
        );
    }

    async rebuildProjection(
        document: RallarCrdtDocumentRef,
        projectionId = 'default',
    ): Promise<RallarCrdtIntegrityReport> {
        const report = await this.verifyIntegrity(document);
        if (report.valid) {
            const current = await this.readDocumentMetadata(document);
            await this.updateDocumentLifecycle({
                document,
                lifecycle: current?.lifecycle ?? 'active',
                projectionIds: [projectionId],
            });
            this.recordAudit('rebuild', toRallarCrdtDocumentKey(document), {
                projectionId,
            });
        }
        return report;
    }

    private async appendInTransaction(
        tx: PSqlSql,
        input: RallarCrdtAppendUpdateInput<TPayload>,
        startedAtEpochMs: number,
    ): Promise<RallarCrdtAppendResult<TPayload>> {
        const acceptedAtEpochMs = input.trusted.acceptedAtEpochMs ?? this.now();
        const documentKey = toRallarCrdtDocumentKey(input.update.document);
        await ensureDocument(tx, input.update.document, acceptedAtEpochMs);
        const metadata = await requireDocumentMetadataByKey(
            tx,
            documentKey,
            true,
        );
        const policyDecision = evaluateRallarCrdtFeaturePolicy({
            document: input.update.document,
            operation: 'durable-append',
            policies: this.policies,
        });
        if (!policyDecision.allowed) {
            return this.recordAppendResult(startedAtEpochMs, {
                status: 'rejected',
                update: input.update,
                code: 'feature-disabled',
                reason: policyDecision.reason,
                retryable: policyDecision.retryable,
                document: metadata,
            });
        }
        const acceptedUpdateHash = hashRallarCrdtUpdateEnvelope(input.update);
        const duplicateRows = await tx<CrdtUpdateRow[]>`
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
              and update_id = ${input.update.updateId}
            limit 1
        `;
        const duplicate = duplicateRows[0];
        if (duplicate) {
            const append = toAppendMetadata(duplicate);
            if (append.acceptedUpdateHash === acceptedUpdateHash) {
                return this.recordAppendResult(startedAtEpochMs, {
                    status: 'duplicate',
                    update: input.update,
                    append,
                    document: metadata,
                });
            }

            return this.recordAppendResult(startedAtEpochMs, {
                status: 'rejected',
                update: input.update,
                code: 'duplicate-hash-mismatch',
                reason: 'CRDT updateId already exists with a different canonical hash.',
                retryable: false,
                document: metadata,
            });
        }

        if (metadata.lifecycle === 'archived') {
            return this.recordAppendResult(startedAtEpochMs, {
                status: 'rejected',
                update: input.update,
                code: 'document-archived',
                reason: 'CRDT document is archived and no longer accepts writes.',
                retryable: false,
                document: metadata,
            });
        }
        if (metadata.lifecycle === 'destroyed') {
            return this.recordAppendResult(startedAtEpochMs, {
                status: 'rejected',
                update: input.update,
                code: 'document-destroyed',
                reason: 'CRDT document is destroyed and no longer accepts writes.',
                retryable: false,
                document: metadata,
            });
        }
        if (metadata.lifecycle === 'quarantined') {
            return this.recordAppendResult(startedAtEpochMs, {
                status: 'rejected',
                update: input.update,
                code: 'document-quarantined',
                reason: 'CRDT document is quarantined and no longer accepts writes.',
                retryable: false,
                document: metadata,
            });
        }
        if (
            metadata.quota?.maxUpdateCount !== undefined &&
            metadata.updateCount >= metadata.quota.maxUpdateCount
        ) {
            return this.recordAppendResult(startedAtEpochMs, {
                status: 'rejected',
                update: input.update,
                code: 'quota-exceeded',
                reason: 'CRDT document update quota is exhausted.',
                retryable: false,
                document: metadata,
            });
        }
        const updateQuotaBytes = byteLengthOfRallarCrdtJson(input.update);
        if (
            metadata.quota?.maxUpdateBytes !== undefined &&
            updateQuotaBytes > metadata.quota.maxUpdateBytes
        ) {
            return this.recordAppendResult(startedAtEpochMs, {
                status: 'rejected',
                update: input.update,
                code: 'update-too-large',
                reason: 'CRDT update exceeds the document update-byte quota.',
                retryable: false,
                document: metadata,
            });
        }
        if (metadata.quota?.maxDocumentBytes !== undefined) {
            const storedBytes = await readStoredDocumentBytes(tx, documentKey);
            if (
                storedBytes.totalBytes + updateQuotaBytes >
                metadata.quota.maxDocumentBytes
            ) {
                return this.recordAppendResult(startedAtEpochMs, {
                    status: 'rejected',
                    update: input.update,
                    code: 'quota-exceeded',
                    reason: 'CRDT document exceeds the document-byte quota.',
                    retryable: false,
                    document: metadata,
                });
            }
        }
        if (
            await isRateLimited(
                tx,
                documentKey,
                input.trusted.actorId,
                input.trusted.principalId,
                acceptedAtEpochMs,
                metadata.quota?.maxUpdatesPerMinutePerActor,
            )
        ) {
            return this.recordAppendResult(startedAtEpochMs, {
                status: 'rejected',
                update: input.update,
                code: 'rate-limited',
                reason: 'CRDT document actor update-rate limit is exhausted.',
                retryable: true,
                document: metadata,
            });
        }

        const appendSequence = metadata.lastAppendSequence + 1;
        const serializedUpdate = serializeJson(input.update);
        const storedUpdateBytes = byteLengthOfSerializedJson(serializedUpdate);
        await tx`
            insert into crdt_updates (document_key,
                                      append_sequence,
                                      update_id,
                                      update_envelope,
                                      accepted_update_hash,
                                      actor_id,
                                      principal_id,
                                      session_id,
                                      server_id,
                                      authorization_scope,
                                      accepted_at_ts)
            values (${documentKey},
                    ${appendSequence},
                    ${input.update.updateId},
                    ${serializedUpdate},
                    ${acceptedUpdateHash},
                    ${input.trusted.actorId},
                    ${input.trusted.principalId},
                    ${input.trusted.sessionId},
                    ${input.trusted.serverId ?? this.serverId},
                    ${input.trusted.authorizationScope},
                    ${toPgDate(acceptedAtEpochMs)})
        `;
        await tx`
            update crdt_documents
            set last_append_sequence = ${appendSequence},
                update_count         = update_count + 1,
                stored_update_bytes  = stored_update_bytes + ${storedUpdateBytes},
                updated_at_ts        = ${toPgDate(acceptedAtEpochMs)}
            where document_key = ${documentKey}
        `;

        const document = await requireDocumentMetadataByKey(tx, documentKey);
        return this.recordAppendResult(startedAtEpochMs, {
            status: 'accepted',
            update: input.update,
            append: {
                appendSequence,
                acceptedAtEpochMs,
                actorId: input.trusted.actorId,
                principalId: input.trusted.principalId,
                sessionId: input.trusted.sessionId,
                serverId: input.trusted.serverId ?? this.serverId,
                authorizationScope: input.trusted.authorizationScope,
                acceptedUpdateHash,
            },
            document,
        });
    }

    private async readAllRecords(
        document: RallarCrdtDocumentRef,
    ): Promise<RallarCrdtDurableUpdateRecord<TPayload>[]> {
        const records: RallarCrdtDurableUpdateRecord<TPayload>[] = [];
        let cursor: string | undefined;

        do {
            const page = await this.listAfter({
                document,
                afterCursor: cursor,
                limit: 500,
            });
            records.push(...page.records);
            cursor = page.nextCursor;
            if (!page.hasMore) {
                break;
            }
        } while (cursor);

        return records;
    }

    private rolloutFor(document: RallarCrdtDocumentRef) {
        return (
            this.policies.find(
                (policy) =>
                    (policy.documentType === '*' ||
                        policy.documentType === document.documentType) &&
                    (policy.scope === undefined ||
                        policy.scope === 'any' ||
                        policy.scope === document.scope) &&
                    (policy.applicationId === undefined ||
                        policy.applicationId === document.applicationId) &&
                    (policy.workspaceId === undefined ||
                        policy.workspaceId === document.workspaceId),
            )?.rollout ?? 'production'
        );
    }

    private recordAppendResult(
        startedAtEpochMs: number,
        result: RallarCrdtAppendResult<TPayload>,
    ): RallarCrdtAppendResult<TPayload> {
        const document = result.update?.document ?? result.document?.document;
        const documentKey = document
            ? toRallarCrdtDocumentKey(document)
            : result.document?.documentKey;
        void this.metrics?.record({
            name: 'crdt.server.append.ms',
            value: Math.max(0, this.now() - startedAtEpochMs),
            atEpochMs: this.now(),
            documentKey,
            tags: {
                status: result.status,
            },
        });
        if (result.status === 'rejected') {
            void this.metrics?.record({
                name: 'crdt.server.append.rejected.count',
                value: 1,
                atEpochMs: this.now(),
                documentKey,
                tags: {
                    code: result.code,
                },
            });
            this.recordAudit('reject', documentKey, {
                code: result.code,
                retryable: result.retryable,
            });
        } else {
            this.recordAudit('append', documentKey, {
                status: result.status,
                appendSequence: result.append.appendSequence,
            });
        }
        return result;
    }

    private recordAudit(
        kind: RallarCrdtAuditEventKind,
        documentKey: string | undefined,
        metadata?: Readonly<Record<string, string | number | boolean>>,
    ): void {
        void this.audit?.record({
            kind,
            atEpochMs: this.now(),
            documentKey,
            metadata,
        });
    }
}

function toLifecycleAuditKind(
    lifecycle: RallarCrdtDocumentLifecycleState,
): RallarCrdtAuditEventKind | undefined {
    switch (lifecycle) {
        case 'archived':
            return 'archive';
        case 'quarantined':
            return 'quarantine';
        case 'destroyed':
            return 'destroy';
        case 'active':
            return 'restore';
    }
}

async function ensureDocument(
    sql: PSqlSql,
    document: RallarCrdtDocumentRef,
    nowEpochMs: number,
): Promise<void> {
    await sql`
        insert into crdt_documents (document_key,
                                    application_id,
                                    workspace_id,
                                    document_scope,
                                    document_type,
                                    document_id,
                                    document_ref,
                                    created_at_ts,
                                    updated_at_ts)
        values (${toRallarCrdtDocumentKey(document)},
                ${document.applicationId},
                ${document.workspaceId},
                ${document.scope},
                ${document.documentType},
                ${document.documentId},
                ${serializeJson(document)},
                ${toPgDate(nowEpochMs)},
                ${toPgDate(nowEpochMs)})
        on conflict (document_key) do nothing
    `;
}

async function insertDocumentMetadata(
    sql: PSqlSql,
    metadata: RallarCrdtDocumentMetadata,
): Promise<void> {
    await sql`
        insert into crdt_documents (document_key,
                                    application_id,
                                    workspace_id,
                                    document_scope,
                                    document_type,
                                    document_id,
                                    document_ref,
                                    lifecycle,
                                    created_at_ts,
                                    updated_at_ts,
                                    archived_at_ts,
                                    destroyed_at_ts,
                                    last_append_sequence,
                                    update_count,
                                    snapshot_count,
                                    retention_policy,
                                    quota_policy,
                                    projection_ids)
        values (${metadata.documentKey},
                ${metadata.document.applicationId},
                ${metadata.document.workspaceId},
                ${metadata.document.scope},
                ${metadata.document.documentType},
                ${metadata.document.documentId},
                ${serializeJson(metadata.document)},
                ${metadata.lifecycle},
                ${toPgDate(metadata.createdAtEpochMs)},
                ${toPgDate(metadata.updatedAtEpochMs)},
                ${toNullablePgDate(metadata.archivedAtEpochMs)},
                ${toNullablePgDate(metadata.destroyedAtEpochMs)},
                ${metadata.lastAppendSequence},
                ${metadata.updateCount},
                ${metadata.snapshotCount},
                ${serializeNullableJson(metadata.retention)},
                ${serializeNullableJson(metadata.quota)},
                ${serializeNullableJson(metadata.projectionIds)})
    `;
}

async function isRateLimited(
    sql: PSqlSql,
    documentKey: string,
    actorId: string | undefined,
    principalId: string | undefined,
    acceptedAtEpochMs: number,
    maxUpdatesPerMinutePerActor: number | undefined,
): Promise<boolean> {
    if (maxUpdatesPerMinutePerActor === undefined) {
        return false;
    }

    const actorKey = actorId ?? principalId;
    if (!actorKey) {
        return false;
    }

    const rows = await sql<ReadonlyArray<{ count: number | string }>>`
        select count(*) as count
        from crdt_updates
        where document_key = ${documentKey}
          and accepted_at_ts >= ${toPgDate(acceptedAtEpochMs - 60_000)}
          and coalesce(actor_id, principal_id) = ${actorKey}
    `;

    return Number(rows[0]?.count ?? 0) >= maxUpdatesPerMinutePerActor;
}

async function readStoredDocumentBytes(
    sql: PSqlSql,
    documentKey: string,
): Promise<{
    updateBytes: number;
    snapshotBytes: number;
    totalBytes: number;
}> {
    const rows = await sql<
        ReadonlyArray<{
            update_bytes: number | string | null;
            snapshot_bytes: number | string | null;
        }>
    >`
        select stored_update_bytes as update_bytes,
               coalesce((
                   select max(octet_length(snapshot_envelope))
                   from crdt_snapshots
                   where document_key = ${documentKey}
               ), 0) as snapshot_bytes
        from crdt_documents
        where document_key = ${documentKey}
        limit 1
    `;
    const updateBytes = Number(rows[0]?.update_bytes ?? 0);
    const snapshotBytes = Number(rows[0]?.snapshot_bytes ?? 0);
    return {
        updateBytes,
        snapshotBytes,
        totalBytes: updateBytes + snapshotBytes,
    };
}

function matchesDocumentListInput(
    metadata: RallarCrdtDocumentMetadata,
    input: RallarCrdtListDocumentsInput,
): boolean {
    return (
        (input.applicationId === undefined ||
            metadata.document.applicationId === input.applicationId) &&
        (input.workspaceId === undefined ||
            metadata.document.workspaceId === input.workspaceId) &&
        (input.scope === undefined ||
            metadata.document.scope === input.scope) &&
        (input.documentType === undefined ||
            metadata.document.documentType === input.documentType) &&
        (input.lifecycle === undefined ||
            metadata.lifecycle === input.lifecycle)
    );
}

async function readDocumentMetadataByKey(
    sql: PSqlSql,
    documentKey: string,
    forUpdate = false,
): Promise<RallarCrdtDocumentMetadata | undefined> {
    const rows = forUpdate
        ? await sql<CrdtDocumentRow[]>`
            select document_key,
                   document_ref,
                   lifecycle,
                   created_at_ts,
                   updated_at_ts,
                   archived_at_ts,
                   destroyed_at_ts,
                   last_append_sequence,
                   update_count,
                   snapshot_count,
                   retention_policy,
                   quota_policy,
                   projection_ids
            from crdt_documents
            where document_key = ${documentKey}
            limit 1
            for update
        `
        : await sql<CrdtDocumentRow[]>`
            select document_key,
                   document_ref,
                   lifecycle,
                   created_at_ts,
                   updated_at_ts,
                   archived_at_ts,
                   destroyed_at_ts,
                   last_append_sequence,
                   update_count,
                   snapshot_count,
                   retention_policy,
                   quota_policy,
                   projection_ids
            from crdt_documents
            where document_key = ${documentKey}
            limit 1
        `;

    return rows[0] ? toDocumentMetadata(rows[0]) : undefined;
}

async function requireDocumentMetadataByKey(
    sql: PSqlSql,
    documentKey: string,
    forUpdate = false,
): Promise<RallarCrdtDocumentMetadata> {
    const metadata = await readDocumentMetadataByKey(
        sql,
        documentKey,
        forUpdate,
    );
    if (!metadata) {
        throw new Error(`Missing CRDT document row: ${documentKey}`);
    }
    return metadata;
}

function toDocumentMetadata(row: CrdtDocumentRow): RallarCrdtDocumentMetadata {
    return {
        document: JSON.parse(row.document_ref) as RallarCrdtDocumentRef,
        documentKey: row.document_key,
        lifecycle: row.lifecycle as RallarCrdtDocumentLifecycleState,
        createdAtEpochMs: toEpochMs(row.created_at_ts),
        updatedAtEpochMs: toEpochMs(row.updated_at_ts),
        archivedAtEpochMs: toOptionalEpochMs(row.archived_at_ts),
        destroyedAtEpochMs: toOptionalEpochMs(row.destroyed_at_ts),
        lastAppendSequence: Number(row.last_append_sequence),
        updateCount: Number(row.update_count),
        snapshotCount: Number(row.snapshot_count),
        retention: parseNullableJson<RallarCrdtRetentionPolicy>(
            row.retention_policy,
        ),
        quota: parseNullableJson<RallarCrdtQuotaPolicy>(row.quota_policy),
        projectionIds: parseNullableJson<readonly string[]>(row.projection_ids),
    };
}

function toUpdateRecord<TPayload extends RallarCrdtOperationBatch>(
    row: CrdtUpdateRow,
    document: RallarCrdtDocumentRef,
): RallarCrdtDurableUpdateRecord<TPayload> {
    return {
        document,
        documentKey: row.document_key,
        update: JSON.parse(
            row.update_envelope,
        ) as RallarCrdtUpdateEnvelope<TPayload>,
        append: toAppendMetadata(row),
    };
}

function toAppendMetadata(row: CrdtUpdateRow): RallarCrdtTrustedAppendMetadata {
    return {
        appendSequence: Number(row.append_sequence),
        acceptedAtEpochMs: toEpochMs(row.accepted_at_ts),
        actorId: row.actor_id ?? undefined,
        principalId: row.principal_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        serverId: row.server_id ?? undefined,
        authorizationScope: row.authorization_scope as never,
        acceptedUpdateHash: row.accepted_update_hash,
    };
}

function toPgDate(timestamp: number): Date {
    if (!Number.isFinite(timestamp)) {
        throw new Error('CRDT timestamp must be finite.');
    }
    return new Date(timestamp);
}

function toNullablePgDate(timestamp: number | undefined): Date | null {
    return timestamp === undefined ? null : toPgDate(timestamp);
}

function toEpochMs(value: Date | string): number {
    const timestamp =
        value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        throw new Error(`Invalid CRDT timestamp: ${String(value)}`);
    }
    return timestamp;
}

function toOptionalEpochMs(value: Date | string | null): number | undefined {
    return value === null ? undefined : toEpochMs(value);
}

function serializeJson(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error('CRDT SQL values must be JSON serializable.');
    }
    return serialized;
}

function byteLengthOfSerializedJson(serialized: string): number {
    return new TextEncoder().encode(serialized).byteLength;
}

function serializeNullableJson(value: unknown): string | null {
    return value === undefined ? null : serializeJson(value);
}

function parseNullableJson<T>(value: string | null): T | undefined {
    return value === null ? undefined : (JSON.parse(value) as T);
}
