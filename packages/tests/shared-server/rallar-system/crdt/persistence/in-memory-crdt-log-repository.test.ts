import { describe, expect, it, vi } from 'vitest';

import { InMemoryRallarCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    createRallarCrdtAppendRequestEnvelope,
    createRallarCrdtBackupBundle,
    createRallarCrdtCatchUpRequestEnvelope,
    createRallarCrdtCompactedSnapshot,
    decryptRallarCrdtUpdateEnvelope,
    encryptRallarCrdtUpdateEnvelope,
    InMemoryRallarCrdtAuditSink,
    InMemoryRallarCrdtMetricsSink,
    isRallarCrdtAppendAccepted,
    isRallarCrdtAppendDuplicate,
    isRallarCrdtAppendRejected,
    isRallarCrdtEncryptedOperationBatch,
    RALLAR_CRDT_APPEND_REQUEST_TYPE_ID,
    RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    toRallarCrdtAppendCursor,
    toRallarCrdtDocumentKey,
    verifyRallarCrdtDebugBundle,
    type RallarCrdtDocumentRef,
    type RallarCrdtOperationBatch,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtUpdateEnvelope
} from '@shared/mod.ts';

const roomRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1'
};

const documentRef: RallarCrdtDocumentRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'room-1',
    roomRef
};

const otherDocumentRef: RallarCrdtDocumentRef = {
    ...documentRef,
    documentId: 'room-2',
    roomRef: {
        ...roomRef,
        groupId: 'room-2'
    }
};

describe('Rallar CRDT durable log contracts', () => {
    it('exposes stable append and catch-up envelopes', () => {
        const update = createUpdateEnvelope('update-1');

        expect(RALLAR_CRDT_APPEND_REQUEST_TYPE_ID).toBe('rallar.crdt.append-request.v1');
        expect(RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID).toBe('rallar.crdt.catch-up-request.v1');
        expect(
            createRallarCrdtAppendRequestEnvelope({
                requestId: 'append-1',
                document: documentRef,
                replicaId: 'replica-a',
                createdAtEpochMs: 1_000,
                updates: [update]
            })
        ).toMatchObject({
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            requestId: 'append-1',
            updates: [update]
        });
        expect(
            createRallarCrdtCatchUpRequestEnvelope({
                requestId: 'catch-up-1',
                document: documentRef,
                replicaId: 'replica-b',
                createdAtEpochMs: 1_100,
                afterCursor: toRallarCrdtAppendCursor(4),
                maxUpdateCount: 100,
                includeSnapshot: true
            })
        ).toMatchObject({
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            afterCursor: 'seq:4',
            includeSnapshot: true
        });
    });
});

describe('InMemoryRallarCrdtLogRepository', () => {
    it('assigns monotonic append sequence and returns idempotent duplicates', async () => {
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000),
            serverId: 'server-a'
        });
        const update = createUpdateEnvelope('update-1');

        const accepted = await repository.append(toAppendInput(update));
        const duplicate = await repository.append(toAppendInput(update));

        expect(isRallarCrdtAppendAccepted(accepted)).toBe(true);
        expect(isRallarCrdtAppendDuplicate(duplicate)).toBe(true);
        expect(accepted.status === 'accepted' && accepted.append).toMatchObject({
            appendSequence: 1,
            acceptedAtEpochMs: 2_000,
            principalId: 'principal-a',
            sessionId: 'session-a',
            serverId: 'server-a',
            authorizationScope: 'room'
        });
        expect(duplicate.status === 'duplicate' && duplicate.append).toEqual(accepted.status === 'accepted' && accepted.append);
    });

    it('stores encrypted updates durably without plaintext and restores them', async () => {
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000),
            serverId: 'server-a'
        });
        const keyring = testKeyring();
        const encrypted = await encryptRallarCrdtUpdateEnvelope(
            createUpdateEnvelope('encrypted-1', {
                payload: batchWithTitle('Sensitive durable title')
            }),
            keyring
        );

        const accepted = await repository.append(toAppendInput(encrypted));
        const duplicate = await repository.append(toAppendInput(encrypted));
        const backup = await repository.exportBackupBundle(documentRef);
        const restored = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(4_000)
        });
        await restored.restoreBackupBundle(backup!, {
            overwrite: true
        });
        const restoredRecord = (await restored.listAfter({ document: documentRef })).records[0];

        expect(isRallarCrdtAppendAccepted(accepted)).toBe(true);
        expect(isRallarCrdtAppendDuplicate(duplicate)).toBe(true);
        expect(isRallarCrdtEncryptedOperationBatch(encrypted.payload)).toBe(true);
        expect(JSON.stringify(backup)).not.toContain('Sensitive durable title');
        expect(restoredRecord?.update.payload).toEqual(encrypted.payload);
        expect((await decryptRallarCrdtUpdateEnvelope(restoredRecord!.update, keyring)).payload.operations).toEqual([
            {
                kind: 'register.set',
                path: ['title'],
                policy: 'lww',
                value: 'Sensitive durable title'
            }
        ]);
    });

    it('rejects server-side compaction of encrypted logs without a supplied snapshot', async () => {
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000),
            serverId: 'server-a'
        });
        const encrypted = await encryptRallarCrdtUpdateEnvelope(
            createUpdateEnvelope('encrypted-compact-1', {
                payload: batchWithTitle('Encrypted compact title')
            }),
            testKeyring()
        );

        await repository.append(toAppendInput(encrypted));
        const backup = await repository.exportBackupBundle(documentRef);

        expect(() =>
            createRallarCrdtCompactedSnapshot({
                document: documentRef,
                records: backup!.records
            })
        ).toThrow(/encrypted CRDT logs/);
    });

    it('rejects duplicate update IDs with mismatched canonical hashes', async () => {
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000)
        });
        const update = createUpdateEnvelope('update-1');
        const tampered = createUpdateEnvelope('update-1', {
            payload: batchWithTitle('Tampered')
        });

        await repository.append(toAppendInput(update));
        const rejected = await repository.append(toAppendInput(tampered));

        expect(isRallarCrdtAppendRejected(rejected)).toBe(true);
        expect(rejected.status === 'rejected' && rejected.code).toBe('duplicate-hash-mismatch');
    });

    it('reads the clock once for an existing duplicate append', async () => {
        const clock = createRecordingClock(2_000);
        const repository = new InMemoryRallarCrdtLogRepository({
            now: clock.now
        });
        const update = createUpdateEnvelope('clock-duplicate-1');
        await repository.append(toAppendInput(update));
        clock.reset();

        const duplicate = await repository.append(toAppendInput(update));

        expect(duplicate.status).toBe('duplicate');
        expect(clock.callCount()).toBe(1);
    });

    it('does not read a creation clock while rejecting an existing ' + 'mismatched duplicate', async () => {
        const clock = createRecordingClock(2_000);
        const repository = new InMemoryRallarCrdtLogRepository({
            now: clock.now
        });
        await repository.append(toAppendInput(createUpdateEnvelope('clock-rejected-1')));
        clock.reset();
        clock.throwOnCall(2);

        const rejected = await repository.append(
            toAppendInput(
                createUpdateEnvelope('clock-rejected-1', {
                    payload: batchWithTitle('Mismatched duplicate')
                })
            )
        );

        expect(rejected.status === 'rejected' && rejected.code).toBe('duplicate-hash-mismatch');
        expect(clock.callCount()).toBe(1);
    });

    it('serves catch-up pages by append sequence and cursor', async () => {
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000)
        });
        await repository.append(toAppendInput(createUpdateEnvelope('update-1')));
        await repository.append(toAppendInput(createUpdateEnvelope('update-2')));
        await repository.append(toAppendInput(createUpdateEnvelope('update-3')));

        const firstPage = await repository.listAfter({
            document: documentRef,
            limit: 2
        });
        const secondPage = await repository.listAfter({
            document: documentRef,
            afterCursor: firstPage.nextCursor,
            limit: 2
        });

        expect(firstPage.records.map((record) => record.update.updateId)).toEqual(['update-1', 'update-2']);
        expect(firstPage).toMatchObject({
            firstSequence: 1,
            lastSequence: 2,
            nextCursor: 'seq:2',
            hasMore: true
        });
        expect(secondPage.records.map((record) => record.update.updateId)).toEqual(['update-3']);
        expect(secondPage.hasMore).toBe(false);
    });

    it('stores compact snapshots separately from the append log', async () => {
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000)
        });
        await repository.append(toAppendInput(createUpdateEnvelope('update-1')));
        const snapshot: RallarCrdtSnapshotEnvelope<JsonWireValue> = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: documentRef,
            snapshotId: 'snapshot-1',
            schemaVersion: 1,
            createdAtEpochMs: 2_500,
            maxLamport: 1,
            includedUpdateIds: ['update-1'],
            value: {
                title: 'Inspect north entrance'
            },
            metadata: {
                updateCount: 1
            }
        };

        await repository.writeSnapshot({
            snapshot,
            appendSequence: 1,
            reason: 'test'
        });

        expect(await repository.readSnapshot(documentRef)).toEqual(snapshot);
        const metadata = await repository.readDocumentMetadata(documentRef);
        expect(metadata?.snapshotCount).toBe(1);
        expect(metadata?.updateCount).toBe(1);
    });

    it('does not read the creation clock when writing an existing document snapshot', async () => {
        const clock = createRecordingClock(2_000);
        const repository = new InMemoryRallarCrdtLogRepository({ now: clock.now });
        await repository.append(toAppendInput(createUpdateEnvelope('snapshot-clock-1')));
        clock.reset();
        clock.throwOnCall(1);
        const snapshot: RallarCrdtSnapshotEnvelope<JsonWireValue> = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: documentRef,
            snapshotId: 'snapshot-clock-1',
            schemaVersion: 1,
            createdAtEpochMs: 2_500,
            maxLamport: 1,
            includedUpdateIds: ['snapshot-clock-1'],
            value: { title: 'Existing snapshot' },
            metadata: { updateCount: 1 }
        };

        await repository.writeSnapshot({ snapshot, appendSequence: 1 });

        expect(await repository.readSnapshot(documentRef)).toEqual(snapshot);
        expect(clock.callCount()).toBe(0);
    });

    it('does not read the clock for an existing lifecycle change with an ' + 'explicit timestamp', async () => {
        const clock = createRecordingClock(2_000);
        const repository = new InMemoryRallarCrdtLogRepository({ now: clock.now });
        await repository.append(toAppendInput(createUpdateEnvelope('lifecycle-clock-1')));
        clock.reset();
        clock.throwOnCall(1);

        const metadata = await repository.updateDocumentLifecycle({
            document: documentRef,
            lifecycle: 'archived',
            changedAtEpochMs: 3_000
        });

        expect(metadata.updatedAtEpochMs).toBe(3_000);
        expect(clock.callCount()).toBe(0);
    });

    it('does not read the clock for an existing debug export with an ' + 'explicit timestamp', async () => {
        const clock = createRecordingClock(2_000);
        const repository = new InMemoryRallarCrdtLogRepository({ now: clock.now });
        await repository.append(toAppendInput(createUpdateEnvelope('debug-clock-1')));
        clock.reset();
        clock.throwOnCall(1);

        const bundle = await repository.exportDebugBundle(documentRef, {
            exportedAtEpochMs: 4_000
        });

        expect(bundle.exportedAtEpochMs).toBe(4_000);
        expect(clock.callCount()).toBe(0);
    });

    it('rejects appends after a document is archived', async () => {
        const lifecycleHook = vi.fn();
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000),
            hooks: {
                onLifecycleChanged: lifecycleHook
            }
        });
        await repository.updateDocumentLifecycle({
            document: documentRef,
            lifecycle: 'archived',
            changedAtEpochMs: 3_000,
            retention: {
                mode: 'retain'
            },
            quota: {
                maxUpdateCount: 10
            },
            projectionIds: ['checklist-summary']
        });

        const rejected = await repository.append(toAppendInput(createUpdateEnvelope('update-1')));

        expect(isRallarCrdtAppendRejected(rejected)).toBe(true);
        expect(rejected.status === 'rejected' && rejected.code).toBe('document-archived');
        expect(lifecycleHook).toHaveBeenCalledWith(
            expect.objectContaining({
                lifecycle: 'archived',
                archivedAtEpochMs: 3_000,
                retention: {
                    mode: 'retain'
                },
                quota: {
                    maxUpdateCount: 10
                },
                projectionIds: ['checklist-summary']
            })
        );
    });

    it('enforces rollout kill switches and records append metrics', async () => {
        const metrics = new InMemoryRallarCrdtMetricsSink();
        const audit = new InMemoryRallarCrdtAuditSink();
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000),
            metrics,
            audit,
            policies: [
                {
                    documentType: 'checklist',
                    rollout: 'disabled',
                    flags: {
                        killSwitchReason: 'maintenance'
                    }
                }
            ]
        });

        const rejected = await repository.append(toAppendInput(createUpdateEnvelope('update-1')));

        expect(isRallarCrdtAppendRejected(rejected)).toBe(true);
        expect(rejected.status === 'rejected' && rejected.code).toBe('feature-disabled');
        expect(metrics.count('crdt.server.append.ms')).toBe(1);
        expect(metrics.count('crdt.server.append.rejected.count')).toBe(1);
        expect(audit.count('reject')).toBe(1);
    });

    it('quarantines documents and applies actor rate limits', async () => {
        const audit = new InMemoryRallarCrdtAuditSink();
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000),
            audit
        });
        await repository.updateDocumentLifecycle({
            document: documentRef,
            lifecycle: 'active',
            quota: {
                maxUpdatesPerMinutePerActor: 1
            }
        });

        expect((await repository.append(toAppendInput(createUpdateEnvelope('update-1')))).status).toBe('accepted');
        const rateLimited = await repository.append(toAppendInput(createUpdateEnvelope('update-2')));
        expect(rateLimited.status === 'rejected' && rateLimited.code).toBe('rate-limited');

        await repository.updateDocumentLifecycle({
            document: documentRef,
            lifecycle: 'quarantined'
        });
        const quarantined = await repository.append(toAppendInput(createUpdateEnvelope('update-3')));

        expect(quarantined.status === 'rejected' && quarantined.code).toBe('document-quarantined');
        expect(audit.count('append')).toBe(1);
        expect(audit.count('reject')).toBe(2);
        expect(audit.count('quarantine')).toBe(1);
    });

    it('enforces max document bytes before accepting appends', async () => {
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000)
        });
        await repository.updateDocumentLifecycle({
            document: documentRef,
            lifecycle: 'active',
            quota: {
                maxDocumentBytes: 10
            }
        });

        const rejected = await repository.append(toAppendInput(createUpdateEnvelope('too-large-1')));

        expect(rejected.status === 'rejected' && rejected.code).toBe('quota-exceeded');
    });

    it('lists admin status, exports debug bundles, restores backups, and ' + 'rebuilds projections', async () => {
        const rebuildHook = vi.fn();
        const audit = new InMemoryRallarCrdtAuditSink();
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000),
            audit,
            hooks: {
                rebuild: rebuildHook
            }
        });
        await repository.append(toAppendInput(createUpdateEnvelope('update-1')));

        const list = await repository.listDocuments({
            documentType: 'checklist'
        });
        const debugBundle = await repository.exportDebugBundle(documentRef, {
            reason: 'test-export'
        });
        const backup = await repository.exportBackupBundle(documentRef);
        const rebuildReport = await repository.rebuildProjection(documentRef, 'checklist-summary');
        await repository.writeSnapshot({
            snapshot: {
                protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
                document: documentRef,
                snapshotId: 'snapshot-compact-1',
                schemaVersion: 1,
                createdAtEpochMs: 3_000,
                maxLamport: 1,
                includedUpdateIds: ['update-1'],
                value: {
                    title: 'Title update-1'
                },
                metadata: {
                    updateCount: 1
                }
            },
            appendSequence: 1,
            reason: 'non-destructive-compaction'
        });
        const restored = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(4_000),
            audit
        });

        expect(list.documents).toHaveLength(1);
        expect(debugBundle.integrity.updateCount).toBe(1);
        expect(backup?.integrity.updateCount).toBe(1);
        expect(rebuildReport.valid).toBe(true);
        expect(rebuildHook).toHaveBeenCalledWith(documentRef);
        expect(
            await restored.restoreBackupBundle(backup!, {
                overwrite: true
            })
        ).toMatchObject({
            restoredUpdateCount: 1,
            firstAppendSequence: 1,
            lastAppendSequence: 1
        });
        expect((await restored.listAfter({ document: documentRef })).records).toHaveLength(1);
        expect(audit.count('append')).toBe(1);
        expect(audit.count('export')).toBeGreaterThanOrEqual(2);
        expect(audit.count('backup')).toBeGreaterThanOrEqual(1);
        expect(audit.count('compact')).toBe(1);
        expect(audit.count('restore')).toBe(1);
        expect(audit.count('rebuild')).toBe(1);
    });

    it('rejects a valid cross-document backup without changing either document', async () => {
        const source = new InMemoryRallarCrdtLogRepository({ now: fixedNow(2_000) });
        await source.append(toAppendInput(createUpdateEnvelope('source-a-1')));
        const sourceBackup = await source.exportBackupBundle(documentRef, {
            exportedAtEpochMs: 2_500
        });
        const target = new InMemoryRallarCrdtLogRepository({ now: fixedNow(3_000) });
        await target.append(
            toAppendInput(
                createUpdateEnvelope('existing-b-1', {
                    document: otherDocumentRef
                })
            )
        );
        const beforeA = await target.listAfter({ document: documentRef });
        const beforeB = await target.listAfter({ document: otherDocumentRef });
        const crossDocumentBackup = createRallarCrdtBackupBundle({
            exportedAtEpochMs: sourceBackup!.exportedAtEpochMs,
            document: documentRef,
            metadata: {
                ...sourceBackup!.metadata,
                document: otherDocumentRef,
                documentKey: toRallarCrdtDocumentKey(otherDocumentRef)
            },
            snapshot: sourceBackup!.snapshot,
            records: sourceBackup!.records
        });
        expect(verifyRallarCrdtDebugBundle(crossDocumentBackup).valid).toBe(true);

        await expect(target.restoreBackupBundle(crossDocumentBackup)).rejects.toThrow(
            'CRDT backup bundle identity mismatch at $.metadata.document'
        );

        expect(await target.listAfter({ document: documentRef })).toEqual(beforeA);
        expect(await target.listAfter({ document: otherDocumentRef })).toEqual(beforeB);
    });

    it.each([
        {
            label: 'metadata documentKey',
            change: 'metadata-key' as const,
            expectedPath: '$.metadata.documentKey'
        },
        {
            label: 'snapshot document',
            change: 'snapshot-document' as const,
            expectedPath: '$.snapshot.document'
        },
        {
            label: 'record document',
            change: 'record-document' as const,
            expectedPath: '$.records.source-a-2.document'
        },
        {
            label: 'record documentKey',
            change: 'record-key' as const,
            expectedPath: '$.records.source-a-2.documentKey'
        }
    ])('rejects a valid backup with mismatched $label identity', async (testCase) => {
        const source = new InMemoryRallarCrdtLogRepository({ now: fixedNow(2_000) });
        await source.append(toAppendInput(createUpdateEnvelope('source-a-2')));
        await source.writeSnapshot({
            snapshot: {
                protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
                document: documentRef,
                snapshotId: 'source-a-snapshot',
                schemaVersion: 1,
                createdAtEpochMs: 2_500,
                maxLamport: 1,
                includedUpdateIds: ['source-a-2'],
                value: { title: 'Source A' },
                metadata: { updateCount: 1 }
            },
            appendSequence: 1
        });
        const sourceBackup = await source.exportBackupBundle(documentRef, {
            exportedAtEpochMs: 3_000
        });
        const record = sourceBackup!.records[0]!;
        const inconsistentBackup = createRallarCrdtBackupBundle({
            exportedAtEpochMs: sourceBackup!.exportedAtEpochMs,
            document: documentRef,
            metadata: testCase.change === 'metadata-key'
                ? {
                    ...sourceBackup!.metadata,
                    documentKey: toRallarCrdtDocumentKey(otherDocumentRef)
                }
                : sourceBackup!.metadata,
            snapshot: testCase.change === 'snapshot-document' ? { ...sourceBackup!.snapshot!, document: otherDocumentRef } : sourceBackup!.snapshot,
            records: [
                {
                    ...record,
                    document: testCase.change === 'record-document' ? otherDocumentRef : record.document,
                    documentKey: testCase.change === 'record-key' ? toRallarCrdtDocumentKey(otherDocumentRef) : record.documentKey
                }
            ]
        });
        expect(verifyRallarCrdtDebugBundle(inconsistentBackup).valid).toBe(true);
        const target = new InMemoryRallarCrdtLogRepository({ now: fixedNow(4_000) });

        await expect(target.restoreBackupBundle(inconsistentBackup)).rejects.toThrow(
            `CRDT backup bundle identity mismatch at ${testCase.expectedPath}`
        );

        expect(await target.listAfter({ document: documentRef })).toMatchObject({ records: [] });
        expect(await target.listAfter({ document: otherDocumentRef })).toMatchObject({ records: [] });
    });

    it('pages larger update logs and verifies integrity digests without ' + 'unbounded payloads', async () => {
        const repository = new InMemoryRallarCrdtLogRepository({
            now: fixedNow(2_000)
        });
        for (let index = 1; index <= 25; index += 1) {
            await repository.append(toAppendInput(createUpdateEnvelope(`large-${index}`)));
        }

        const seen: string[] = [];
        let cursor: string | undefined;
        let pageCount = 0;
        do {
            const page = await repository.listAfter({
                document: documentRef,
                afterCursor: cursor,
                limit: 7
            });
            pageCount += 1;
            seen.push(...page.records.map((record) => record.update.updateId));
            cursor = page.nextCursor;
            if (!page.hasMore) {
                break;
            }
        }
        while (cursor);

        const integrity = await repository.verifyIntegrity(documentRef);

        expect(pageCount).toBe(4);
        expect(seen).toHaveLength(25);
        expect(seen[0]).toBe('large-1');
        expect(seen.at(-1)).toBe('large-25');
        expect(integrity).toMatchObject({
            valid: true,
            checkedUpdateCount: 25,
            sequenceGaps: []
        });
        expect(integrity.bundleHash).toMatch(/^crdt-fnv1a32:/);
    });
});

function toAppendInput(update: RallarCrdtUpdateEnvelope) {
    return {
        update,
        trusted: {
            actorId: 'actor-a',
            authorizationScope: 'room' as const,
            principalId: 'principal-a',
            sessionId: 'session-a',
            serverId: 'server-a'
        }
    };
}
function createUpdateEnvelope(updateId: string, overrides: Partial<RallarCrdtUpdateEnvelope> = {}): RallarCrdtUpdateEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: documentRef,
        updateId,
        replicaId: 'replica-a',
        lamport: Number(updateId.split('-').at(-1) ?? 1),
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 1_000,
        payload: batchWithTitle(`Title ${updateId}`),
        ...overrides
    };
}
function batchWithTitle(title: string): RallarCrdtOperationBatch {
    return {
        kind: 'batch',
        operations: [
            {
                kind: 'register.set',
                path: ['title'],
                policy: 'lww',
                value: title
            }
        ]
    };
}

function fixedNow(value: number): () => number {
    return () => value;
}

function createRecordingClock(value: number) {
    let calls = 0;
    let failingCall: number | undefined;

    return {
        now: () => {
            calls += 1;
            if (calls === failingCall) {
                throw new Error(`Unexpected clock call ${calls}`);
            }
            return value;
        },
        callCount: () => calls,
        reset: () => {
            calls = 0;
            failingCall = undefined;
        },
        throwOnCall: (call: number) => {
            failingCall = call;
        }
    };
}

function testKeyring() {
    return {
        activeKeyId: 'repository-test-key',
        keys: [
            {
                keyId: 'repository-test-key',
                secret: 'repository-rallar-crdt-encryption-secret'
            }
        ],
        now: () => 6_000,
        randomBytes: (length: number) => new Uint8Array(length).fill(13)
    };
}
