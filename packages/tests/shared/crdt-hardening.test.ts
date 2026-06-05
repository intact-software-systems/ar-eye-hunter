import { describe, expect, it } from 'vitest';
import {
    createRallarCrdtAdminDocumentStatus,
    createRallarCrdtBackupBundle,
    createRallarCrdtCompactedSnapshot,
    createRallarCrdtDebugBundle,
    createRallarCrdtErasureAuditEvent,
    encryptRallarCrdtUpdateEnvelope,
    evaluateRallarCrdtFeaturePolicy,
    evaluateRallarCrdtRetentionStatus,
    hashRallarCrdtUpdateEnvelope,
    InMemoryRallarCrdtAuditSink,
    InMemoryRallarCrdtMetricsSink,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    rallarCrdtBatch,
    summarizeRallarCrdtScheduledHealth,
    toRallarCrdtAppendRejectionCategory,
    toRallarCrdtDocumentKey,
    validateRallarCrdtEncryptionMetadata,
    validateRallarCrdtSpatialMetadata,
    verifyRallarCrdtDebugBundle,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtDurableUpdateRecord,
    type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';

const roomRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1',
};

const documentRef: RallarCrdtDocumentRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'room-1',
    roomRef,
};

describe('Rallar CRDT hardening contracts', () => {
    it('evaluates feature flags and rollout kill switches deterministically', () => {
        expect(
            evaluateRallarCrdtFeaturePolicy({
                document: documentRef,
                operation: 'rtc-send',
                policies: [
                    {
                        documentType: 'checklist',
                        rollout: 'durable-beta',
                        flags: {
                            rtc: false,
                        },
                    },
                ],
            }),
        ).toMatchObject({
            allowed: false,
            code: 'rtc-disabled',
            rollout: 'durable-beta',
        });

        expect(
            evaluateRallarCrdtFeaturePolicy({
                document: documentRef,
                operation: 'ws-send',
                policies: [
                    {
                        documentType: 'checklist',
                        rollout: 'durable-beta',
                        flags: {
                            rtc: false,
                        },
                    },
                ],
            }).allowed,
        ).toBe(true);

        expect(
            evaluateRallarCrdtFeaturePolicy({
                document: documentRef,
                operation: 'durable-append',
                policies: [
                    {
                        documentType: '*',
                        rollout: 'disabled',
                        flags: {
                            killSwitchReason: 'maintenance',
                        },
                    },
                ],
            }),
        ).toMatchObject({
            allowed: false,
            code: 'rollout-disabled',
            reason: 'maintenance',
        });
    });

    it('keeps canonical document keys isolated across scopes and namespaces', () => {
        const principal: RallarCrdtDocumentRef = {
            ...documentRef,
            scope: 'principal',
            documentId: 'principal-a',
            roomRef: undefined,
            principalId: 'principal-a',
        };
        const custom: RallarCrdtDocumentRef = {
            ...documentRef,
            scope: 'custom',
            documentId: 'room-1',
            roomRef: undefined,
            customScope: 'report-section',
        };

        expect(
            new Set([
                toRallarCrdtDocumentKey(documentRef),
                toRallarCrdtDocumentKey(principal),
                toRallarCrdtDocumentKey(custom),
            ]).size,
        ).toBe(3);
    });

    it('creates debug and backup bundles and detects tampered update hashes', () => {
        const metadata = createMetadata();
        const update = createUpdate('update-1');
        const record = createRecord(update, 1);
        const bundle = createRallarCrdtDebugBundle({
            exportedAtEpochMs: 3_000,
            reason: 'operator-export',
            document: documentRef,
            metadata,
            records: [record],
            redaction: {
                payloadsRedacted: false,
            },
        });
        const backup = createRallarCrdtBackupBundle({
            exportedAtEpochMs: 3_000,
            document: documentRef,
            metadata,
            records: [record],
        });

        expect(verifyRallarCrdtDebugBundle(bundle).valid).toBe(true);
        expect(verifyRallarCrdtDebugBundle(backup).valid).toBe(true);

        const tampered = {
            ...bundle,
            records: [
                createRecord(
                    {
                        ...update,
                        payload: rallarCrdtBatch([
                            {
                                kind: 'map.set',
                                path: [],
                                key: 'title',
                                value: 'Tampered',
                            },
                        ]),
                    },
                    1,
                ),
            ],
        };

        expect(
            verifyRallarCrdtDebugBundle(tampered).issues.map(
                (issue) => issue.code,
            ),
        ).toEqual(expect.arrayContaining(['update-hash-mismatch']));
    });

    it('reports sequence gaps, metrics, rejection categories, and admin status', () => {
        const metrics = new InMemoryRallarCrdtMetricsSink();
        metrics.record({
            name: 'crdt.server.append.rejected.count',
            value: 1,
            atEpochMs: 4_000,
            documentKey: toRallarCrdtDocumentKey(documentRef),
            tags: {
                reason: 'quota-exceeded',
            },
        });

        const report = verifyRallarCrdtDebugBundle(
            createRallarCrdtDebugBundle({
                exportedAtEpochMs: 5_000,
                reason: 'gap-test',
                document: documentRef,
                metadata: createMetadata(),
                records: [
                    createRecord(createUpdate('update-1'), 1),
                    createRecord(createUpdate('update-3'), 3),
                ],
            }),
        );

        expect(metrics.count('crdt.server.append.rejected.count')).toBe(1);
        expect(report.sequenceGaps).toEqual([2]);
        expect(report.issues.map((issue) => issue.code)).toContain(
            'append-sequence-gap',
        );
        expect(toRallarCrdtAppendRejectionCategory('quota-exceeded')).toBe(
            'permanent.quota',
        );
        expect(
            createRallarCrdtAdminDocumentStatus({
                metadata: createMetadata({
                    lifecycle: 'quarantined',
                }),
                rollout: 'durable-beta',
                quarantineReason: 'integrity-check-failed',
            }),
        ).toMatchObject({
            lifecycle: 'quarantined',
            rollout: 'durable-beta',
            quarantineReason: 'integrity-check-failed',
        });
    });

    it('redacts debug payloads while keeping bundle integrity verifiable', async () => {
        const encryptedUpdate = await encryptRallarCrdtUpdateEnvelope(
            createUpdate('update-1'),
            testKeyring(),
        );
        const record = createRecord(encryptedUpdate, 1);
        const bundle = createRallarCrdtDebugBundle({
            exportedAtEpochMs: 3_000,
            reason: 'operator-export',
            document: documentRef,
            metadata: createMetadata(),
            records: [record],
            redaction: {
                payloadsRedacted: true,
                reason: 'privacy-review',
            },
        });

        expect(bundle.records[0]?.update.payload.operations).toEqual([]);
        expect(bundle.records[0]?.update.payload.encryption).toBeUndefined();
        expect(JSON.stringify(bundle)).not.toContain(
            encryptedUpdate.payload.encryption?.ciphertext ?? 'missing',
        );
        expect(bundle.records[0]?.append.acceptedUpdateHash).not.toBe(
            record.append.acceptedUpdateHash,
        );
        expect(verifyRallarCrdtDebugBundle(bundle)).toMatchObject({
            valid: true,
            checkedUpdateCount: 1,
        });
    });

    it('creates non-destructive compacted snapshots from durable replay', () => {
        const snapshot = createRallarCrdtCompactedSnapshot<{
            title?: string;
        }>({
            document: documentRef,
            records: [
                createRecord(createUpdate('update-1'), 1),
                createRecord(createUpdate('update-2'), 2),
            ],
            now: () => 9_000,
            createSnapshotId: () => 'snapshot-compact-1',
        });

        expect(snapshot).toMatchObject({
            snapshotId: 'snapshot-compact-1',
            createdAtEpochMs: 9_000,
            value: {
                title: 'update-2',
            },
            metadata: {
                updateCount: 2,
                reason: 'non-destructive-compaction',
            },
        });
    });

    it('summarizes retention, erasure audit, stale snapshots, and encryption metadata', () => {
        const audit = new InMemoryRallarCrdtAuditSink();
        audit.record(
            createRallarCrdtErasureAuditEvent({
                document: documentRef,
                requestedAtEpochMs: 6_000,
                requestedBy: 'principal-a',
                reason: 'privacy-request',
                mode: 'redact-payloads',
            }),
        );

        const retentionMetadata = createMetadata({
            updatedAtEpochMs: 1_000,
            updateCount: 3,
            snapshotCount: 0,
            retention: {
                mode: 'redact-after',
                ttlMs: 500,
                reason: 'debug-window',
            },
        });
        const deleteMetadata = createMetadata({
            documentKey: `${toRallarCrdtDocumentKey(documentRef)}#delete`,
            updatedAtEpochMs: 1_000,
            updateCount: 0,
            retention: {
                mode: 'delete-after',
                ttlMs: 500,
            },
        });
        const summary = summarizeRallarCrdtScheduledHealth({
            documents: [retentionMetadata, deleteMetadata],
            nowEpochMs: 2_000,
            staleSnapshotAfterMs: 250,
        });

        expect(audit.count('redact')).toBe(1);
        expect(
            evaluateRallarCrdtRetentionStatus(retentionMetadata, 2_000),
        ).toMatchObject({
            state: 'retention-due',
            dueAtEpochMs: 1_500,
        });
        expect(summary).toMatchObject({
            total: 2,
            unhealthy: 2,
            retentionDue: 1,
            expired: 1,
            staleSnapshots: 1,
        });
        expect(
            validateRallarCrdtEncryptionMetadata({
                enabled: true,
            }).issues.map((issue) => issue.code),
        ).toEqual(
            expect.arrayContaining([
                'invalid-non-empty-string',
                'missing-encrypted-surface',
            ]),
        );
        expect(
            validateRallarCrdtEncryptionMetadata({
                enabled: true,
                algorithm: 'xchacha20-poly1305',
                keyId: 'key-1',
                payloadEncrypted: true,
                visibleMetadataFields: ['documentKey', 'appendSequence'],
            }).valid,
        ).toBe(true);
    });

    it('validates AR/spatial metadata conventions', () => {
        expect(
            validateRallarCrdtSpatialMetadata({
                coordinateFrameId: 'site-a',
                coordinateFrameVersion: 'frame-v2',
                anchorRef: 'anchor-1',
                calibrationVersion: 'calibration-v4',
                confidence: 0.9,
                accuracyMeters: 0.15,
            }).valid,
        ).toBe(true);

        expect(
            validateRallarCrdtSpatialMetadata({
                coordinateFrameId: '',
                coordinateFrameVersion: 'frame-v2',
                confidence: 2,
                accuracyMeters: -1,
            }).issues.map((issue) => issue.code),
        ).toEqual(
            expect.arrayContaining([
                'invalid-non-empty-string',
                'invalid-confidence',
                'invalid-accuracy',
            ]),
        );
    });
});

function createMetadata(
    overrides: Partial<RallarCrdtDocumentMetadata> = {},
): RallarCrdtDocumentMetadata {
    return {
        document: documentRef,
        documentKey: toRallarCrdtDocumentKey(documentRef),
        lifecycle: 'active',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
        lastAppendSequence: 1,
        updateCount: 1,
        snapshotCount: 0,
        ...overrides,
    };
}

function createRecord(
    update: RallarCrdtUpdateEnvelope,
    appendSequence: number,
): RallarCrdtDurableUpdateRecord {
    return {
        document: documentRef,
        documentKey: toRallarCrdtDocumentKey(documentRef),
        update,
        append: {
            appendSequence,
            acceptedAtEpochMs: 2_000 + appendSequence,
            authorizationScope: 'room',
            acceptedUpdateHash: hashRallarCrdtUpdateEnvelope(update),
        },
    };
}

function createUpdate(updateId: string): RallarCrdtUpdateEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: documentRef,
        updateId,
        replicaId: 'replica-a',
        lamport: Number(updateId.replace(/\D/g, '')) || 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 1_000,
        payload: rallarCrdtBatch([
            {
                kind: 'map.set',
                path: [],
                key: 'title',
                value: updateId,
            },
        ]),
    };
}

function testKeyring() {
    return {
        activeKeyId: 'hardening-test-key',
        keys: [
            {
                keyId: 'hardening-test-key',
                secret: 'hardening-rallar-crdt-encryption-secret',
            },
        ],
        now: () => 8_000,
        randomBytes: (length: number) => new Uint8Array(length).fill(11),
    };
}
