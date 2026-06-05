import { describe, expect, it } from 'vitest';
import {
    canonicalRallarCrdtJson,
    createRallarCrdtDocument,
    describeRallarCrdtEncryptionKeyring,
    decryptRallarCrdtSnapshotEnvelope,
    decryptRallarCrdtUpdateEnvelope,
    encryptRallarCrdtSnapshotEnvelope,
    encryptRallarCrdtUpdateEnvelope,
    evaluateRallarCrdtDestructiveCompactionSafety,
    hashRallarCrdtUpdateEnvelope,
    isRallarCrdtEncryptedJsonEnvelope,
    isRallarCrdtEncryptedOperationBatch,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    revokeRallarCrdtEncryptionKey,
    rotateRallarCrdtEncryptionKeyring,
    rallarCrdtBatch,
    rallarCrdtAddCounterOperation,
    rallarCrdtNumberMaxOperation,
    rallarCrdtNumberMinOperation,
    type RallarCrdtDocumentRef,
    type RallarCrdtUpdateEnvelope,
    toRallarCrdtDocumentKey,
    validateRallarCrdtDocumentRef,
    validateRallarCrdtOperationBatch,
    validateRallarCrdtSyncRequestEnvelope,
    validateRallarCrdtSyncResponseEnvelope,
    validateRallarCrdtUpdateEnvelope,
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

describe('Rallar CRDT contracts', () => {
    it('creates stable canonical document keys from full scoped refs', () => {
        const reordered: RallarCrdtDocumentRef = {
            documentId: 'room-1',
            documentType: 'checklist',
            scope: 'room',
            roomRef: {
                groupId: 'room-1',
                workspaceId: 'main',
                applicationId: 'rallar-test',
            },
            workspaceId: 'main',
            applicationId: 'rallar-test',
        };

        expect(toRallarCrdtDocumentKey(documentRef)).toBe(
            toRallarCrdtDocumentKey(reordered),
        );
        expect(toRallarCrdtDocumentKey(documentRef)).toContain('room');
        expect(toRallarCrdtDocumentKey(documentRef)).toContain('checklist');
    });

    it('rejects invalid document scopes and mismatched room refs', () => {
        const result = validateRallarCrdtDocumentRef({
            ...documentRef,
            roomRef: {
                ...roomRef,
                applicationId: 'other-app',
            },
        });

        expect(result.valid).toBe(false);
        expect(result.issues.map((issue) => issue.code)).toContain(
            'room-application-mismatch',
        );
    });

    it('rejects raw binary and undefined values inside operations', () => {
        const result = validateRallarCrdtOperationBatch(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: ['files'],
                    key: 'raw',
                    value: new Uint8Array([1, 2, 3]) as never,
                },
                {
                    kind: 'register.set',
                    path: ['bad'],
                    policy: 'lww',
                    value: { missing: undefined } as never,
                },
            ]),
        );

        expect(result.valid).toBe(false);
        expect(result.issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining([
                'unsupported-json-object',
                'undefined-json-value',
            ]),
        );
    });

    it('does not expose OT, Yjs, Automerge, arbitrary JSON Patch, or delta-state operation kinds', () => {
        for (const kind of [
            'ot.apply',
            'yjs.update',
            'automerge.update',
            'json.patch',
            'delta.state',
        ]) {
            const result = validateRallarCrdtOperationBatch({
                kind: 'batch',
                operations: [
                    {
                        kind,
                        path: [],
                    },
                ],
            });

            expect(result.valid).toBe(false);
            expect(result.issues.map((issue) => issue.code)).toContain(
                'invalid-operation-kind',
            );
        }
    });

    it('rejects unknown protocol and operation versions', () => {
        const update = createUpdateEnvelope({
            protocolVersion: 2,
            operationVersion: 99,
        });

        const result = validateRallarCrdtUpdateEnvelope(update);

        expect(result.valid).toBe(false);
        expect(result.issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining([
                'unknown-protocol-version',
                'unknown-operation-version',
            ]),
        );
    });

    it('verifies update hashes against canonical envelopes', () => {
        const update = createUpdateEnvelope();
        const signed = {
            ...update,
            hash: hashRallarCrdtUpdateEnvelope(update),
        };

        expect(validateRallarCrdtUpdateEnvelope(signed).valid).toBe(true);
        expect(
            validateRallarCrdtUpdateEnvelope({
                ...signed,
                payload: rallarCrdtBatch([
                    {
                        kind: 'register.set',
                        path: ['title'],
                        policy: 'lww',
                        value: 'Tampered',
                    },
                ]),
            }).issues.map((issue) => issue.code),
        ).toContain('hash-mismatch');
    });

    it('canonicalizes JSON independent of object property order', () => {
        expect(
            canonicalRallarCrdtJson({
                b: 2,
                a: {
                    d: true,
                    c: null,
                },
            }),
        ).toBe('{"a":{"c":null,"d":true},"b":2}');
    });

    it('converges counter and numeric min/max operations across replicas', () => {
        const first = createRallarCrdtDocument<Record<string, unknown>>({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('a'),
        });
        const second = createRallarCrdtDocument<Record<string, unknown>>({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(2_000),
            createUpdateId: sequenceIds('b'),
        });

        const firstUpdate = first.applyLocal(
            rallarCrdtBatch([
                rallarCrdtAddCounterOperation(['votes'], 3),
                rallarCrdtNumberMinOperation(['lowestLatencyMs'], 42),
                rallarCrdtNumberMaxOperation(['highestScore'], 9),
            ]),
        );
        const secondUpdate = second.applyLocal(
            rallarCrdtBatch([
                rallarCrdtAddCounterOperation(['votes'], -1),
                rallarCrdtNumberMinOperation(['lowestLatencyMs'], 21),
                rallarCrdtNumberMaxOperation(['highestScore'], 12),
            ]),
        );

        first.apply(secondUpdate);
        second.apply(firstUpdate);

        expect(first.read()).toEqual({
            votes: 2,
            lowestLatencyMs: 21,
            highestScore: 12,
        });
        expect(second.read()).toEqual(first.read());
    });

    it('preserves numeric CRDT state across snapshot import plus later replay', () => {
        const full = createRallarCrdtDocument<Record<string, unknown>>({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('a'),
        });
        const first = full.applyLocal(
            rallarCrdtBatch([
                rallarCrdtAddCounterOperation(['views'], 10),
                rallarCrdtNumberMaxOperation(['peak'], 3),
            ]),
        );
        const snapshot = full.snapshot('numeric-state');
        const later = full.applyLocal(
            rallarCrdtBatch([
                rallarCrdtAddCounterOperation(['views'], 5),
                rallarCrdtNumberMaxOperation(['peak'], 7),
            ]),
        );

        const compacted = createRallarCrdtDocument<Record<string, unknown>>({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(2_000),
            createUpdateId: sequenceIds('b'),
        });
        compacted.importSnapshot(snapshot);
        expect(compacted.apply(first).status).toBe('duplicate');
        expect(compacted.apply(later).status).toBe('applied');

        expect(compacted.read()).toEqual(full.read());
        expect(snapshot.metadata.crdtState?.counters).toBeDefined();
        expect(snapshot.metadata.crdtState?.numbers).toBeDefined();
    });

    it('validates numeric operations and strict numeric path ownership', () => {
        const valid = validateRallarCrdtOperationBatch(
            rallarCrdtBatch([
                rallarCrdtAddCounterOperation(['votes'], 1),
                rallarCrdtNumberMinOperation(['latency'], 12),
            ]),
            '$',
            {
                pathSchema: {
                    mode: 'strict',
                    paths: [
                        {
                            path: ['votes'],
                            kind: 'counter',
                        },
                        {
                            path: ['latency'],
                            kind: 'number',
                        },
                    ],
                },
            },
        );
        expect(valid.valid).toBe(true);

        const invalid = validateRallarCrdtOperationBatch(
            rallarCrdtBatch([
                {
                    kind: 'counter.add',
                    path: ['latency'],
                    delta: Number.POSITIVE_INFINITY,
                },
            ]),
            '$',
            {
                pathSchema: {
                    mode: 'strict',
                    paths: [
                        {
                            path: ['latency'],
                            kind: 'number',
                        },
                    ],
                },
            },
        );
        expect(invalid.valid).toBe(false);
        expect(invalid.issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining([
                'invalid-finite-number',
                'crdt-path-kind-mismatch',
            ]),
        );
    });

    it('requires CRDT-state snapshots before destructive compaction is considered safe', () => {
        const document = createRallarCrdtDocument<Record<string, unknown>>({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('a'),
        });
        const update = document.applyLocal(
            rallarCrdtBatch([rallarCrdtAddCounterOperation(['votes'], 1)]),
        );
        const record = {
            document: documentRef,
            documentKey: toRallarCrdtDocumentKey(documentRef),
            update,
            append: {
                appendSequence: 1,
                acceptedAtEpochMs: 1_100,
                authorizationScope: 'room' as const,
                acceptedUpdateHash: hashRallarCrdtUpdateEnvelope(update),
            },
        };
        const snapshot = document.snapshot('destructive-gc-boundary');

        expect(
            evaluateRallarCrdtDestructiveCompactionSafety({
                records: [record],
                snapshot: {
                    ...snapshot,
                    metadata: {
                        ...snapshot.metadata,
                        crdtState: undefined,
                    },
                },
            }),
        ).toMatchObject({
            safe: false,
            code: 'missing-crdt-state',
        });
        expect(
            evaluateRallarCrdtDestructiveCompactionSafety({
                records: [record],
                snapshot,
            }),
        ).toMatchObject({
            safe: true,
            code: 'safe',
            compactableUpdateIds: [update.updateId],
        });
    });

    it('validates sync request and response envelopes', () => {
        const update = createUpdateEnvelope();

        expect(
            validateRallarCrdtSyncRequestEnvelope({
                protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
                document: documentRef,
                requestId: 'sync-request-1',
                replicaId: 'replica-b',
                createdAtEpochMs: 1_000,
                knownUpdateIds: [],
                missingUpdateIds: [update.updateId],
                maxUpdateCount: 100,
            }).valid,
        ).toBe(true);

        expect(
            validateRallarCrdtSyncResponseEnvelope({
                protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
                document: documentRef,
                requestId: 'sync-request-1',
                responseId: 'sync-response-1',
                replicaId: 'replica-a',
                createdAtEpochMs: 1_001,
                updates: [update],
                hasMore: false,
            }).valid,
        ).toBe(true);

        const invalid = validateRallarCrdtSyncResponseEnvelope({
            protocolVersion: 99,
            document: documentRef,
            requestId: '',
            responseId: 'sync-response-1',
            replicaId: 'replica-a',
            createdAtEpochMs: 1_001,
            updates: [{}],
        });

        expect(invalid.valid).toBe(false);
        expect(invalid.issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining([
                'unknown-protocol-version',
                'invalid-non-empty-string',
                'unknown-protocol-version',
            ]),
        );
    });

    it('encrypts update payloads and snapshots while preserving client convergence', async () => {
        const keyring = testKeyring();
        const first = createRallarCrdtDocument<Record<string, unknown>>({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('a'),
        });
        const second = createRallarCrdtDocument<Record<string, unknown>>({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('b'),
        });

        const plaintextUpdate = first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Encrypted title',
                },
            ]),
        );
        const encryptedUpdate = await encryptRallarCrdtUpdateEnvelope(
            plaintextUpdate,
            keyring,
        );

        expect(
            isRallarCrdtEncryptedOperationBatch(encryptedUpdate.payload),
        ).toBe(true);
        expect(encryptedUpdate.payload.operations).toEqual([]);
        expect(JSON.stringify(encryptedUpdate)).not.toContain(
            'Encrypted title',
        );
        expect(validateRallarCrdtUpdateEnvelope(encryptedUpdate).valid).toBe(
            true,
        );

        const decryptedUpdate = await decryptRallarCrdtUpdateEnvelope(
            encryptedUpdate,
            keyring,
        );
        expect(decryptedUpdate.payload.operations).toEqual(
            plaintextUpdate.payload.operations,
        );
        expect(second.apply(decryptedUpdate).status).toBe('applied');
        expect(second.read()).toEqual({
            title: 'Encrypted title',
        });

        const encryptedSnapshot = await encryptRallarCrdtSnapshotEnvelope(
            first.snapshot('encrypted-snapshot'),
            keyring,
        );
        expect(isRallarCrdtEncryptedJsonEnvelope(encryptedSnapshot.value)).toBe(
            true,
        );
        expect(JSON.stringify(encryptedSnapshot)).not.toContain(
            'Encrypted title',
        );

        const decryptedSnapshot = await decryptRallarCrdtSnapshotEnvelope<
            Record<string, unknown>
        >(encryptedSnapshot, keyring);
        expect(decryptedSnapshot.value).toEqual({
            title: 'Encrypted title',
        });
    });

    it('decrypts rotated encrypted updates and rejects revoked keys', async () => {
        const oldKeyring = testKeyring({
            activeKeyId: 'key-v1',
            secret: 'old-secret',
            randomByte: 3,
        });
        const rotatedKeyring = {
            activeKeyId: 'key-v2',
            keys: [
                {
                    keyId: 'key-v1',
                    secret: 'old-secret',
                    rotationEpochMs: 2_000,
                    ownerPrincipalId: 'principal-a',
                },
                {
                    keyId: 'key-v2',
                    secret: 'new-secret',
                    rotationEpochMs: 3_000,
                    ownerPrincipalId: 'principal-a',
                },
            ],
            now: fixedNow(4_000),
            randomBytes: (length: number) => new Uint8Array(length).fill(4),
        };
        const revokedKeyring = {
            ...rotatedKeyring,
            keys: [
                {
                    keyId: 'key-v1',
                    secret: 'old-secret',
                    revokedAtEpochMs: 5_000,
                },
                rotatedKeyring.keys[1],
            ],
        };
        const helperRotatedKeyring = rotateRallarCrdtEncryptionKeyring(
            oldKeyring,
            {
                keyId: 'key-v2',
                secret: 'new-secret',
                ownerPrincipalId: 'principal-a',
            },
        );
        const helperRevokedKeyring = revokeRallarCrdtEncryptionKey(
            helperRotatedKeyring,
            'key-v1',
            5_000,
        );
        const update = createUpdateEnvelope({
            payload: rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Rotated title',
                },
            ]),
        });

        const encryptedWithOldKey = await encryptRallarCrdtUpdateEnvelope(
            update,
            oldKeyring,
        );
        const encryptedWithNewKey = await encryptRallarCrdtUpdateEnvelope(
            update,
            rotatedKeyring,
        );

        expect(encryptedWithOldKey.payload.encryption?.keyId).toBe('key-v1');
        expect(encryptedWithNewKey.payload.encryption?.keyId).toBe('key-v2');
        expect(describeRallarCrdtEncryptionKeyring(rotatedKeyring)).toEqual([
            {
                keyId: 'key-v1',
                status: 'available',
                ownerPrincipalId: 'principal-a',
                rotationEpochMs: 2_000,
                revokedAtEpochMs: undefined,
                hasMaterial: true,
            },
            {
                keyId: 'key-v2',
                status: 'active',
                ownerPrincipalId: 'principal-a',
                rotationEpochMs: 3_000,
                revokedAtEpochMs: undefined,
                hasMaterial: true,
            },
        ]);
        expect(helperRotatedKeyring.activeKeyId).toBe('key-v2');
        expect(
            describeRallarCrdtEncryptionKeyring(helperRevokedKeyring).find(
                (key) => key.keyId === 'key-v1',
            ),
        ).toMatchObject({
            status: 'revoked',
            revokedAtEpochMs: 5_000,
        });
        expect(
            (
                await decryptRallarCrdtUpdateEnvelope(
                    encryptedWithOldKey,
                    rotatedKeyring,
                )
            ).payload.operations,
        ).toEqual(update.payload.operations);
        await expect(
            decryptRallarCrdtUpdateEnvelope(
                encryptedWithOldKey,
                revokedKeyring,
            ),
        ).rejects.toThrow(/revoked/);
    });
});

describe('Rallar CRDT deterministic engine', () => {
    it('dedupes updates and converges independent map/register order', () => {
        const first = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('a'),
        });
        const second = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('b'),
        });

        const title = first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'register.set',
                    path: ['title'],
                    policy: 'lww',
                    value: 'North entrance',
                },
            ]),
        );
        const priority = second.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: ['meta'],
                    key: 'priority',
                    value: 'high',
                },
            ]),
        );

        expect(first.apply(priority).status).toBe('applied');
        expect(first.apply(priority).status).toBe('duplicate');
        expect(second.apply(title).status).toBe('applied');

        expect(first.read()).toEqual(second.read());
        expect(first.read()).toEqual({
            title: 'North entrance',
            meta: {
                priority: 'high',
            },
        });
    });

    it('keeps OR-set tombstones and blocks removes until observed adds arrive', () => {
        const first = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(2_000),
            createUpdateId: sequenceIds('a'),
        });
        const second = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(2_000),
            createUpdateId: sequenceIds('b'),
        });

        const add = first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'orset.add',
                    path: ['items'],
                    elementId: 'item-1',
                    value: { text: 'Inspect north entrance', done: false },
                },
            ]),
        );
        const remove = createUpdateEnvelope({
            updateId: 'remove-1',
            lamport: add.lamport + 1,
            parents: [],
            payload: rallarCrdtBatch([
                {
                    kind: 'orset.remove',
                    path: ['items'],
                    elementId: 'item-1',
                    observedAddUpdateIds: [add.updateId],
                },
            ]),
        });

        expect(second.apply(remove).status).toBe('dependency-blocked');
        expect(second.dependencyState().missingUpdateIds).toEqual([
            add.updateId,
        ]);

        expect(second.apply(add).status).toBe('applied');
        expect(second.read()).toEqual({
            items: [],
        });
        expect(second.snapshot().metadata.tombstoneCount).toBe(1);
    });

    it('surfaces multi-value register conflicts and resolves causal descendants', () => {
        const first = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(3_000),
            createUpdateId: sequenceIds('a'),
        });
        const second = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(3_000),
            createUpdateId: sequenceIds('b'),
        });

        const left = first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'register.set',
                    path: ['status'],
                    policy: 'multi',
                    value: 'ready',
                },
            ]),
        );
        const right = second.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'register.set',
                    path: ['status'],
                    policy: 'multi',
                    value: 'blocked',
                },
            ]),
        );

        first.apply(right);
        expect(first.read()).toEqual({
            status: ['ready', 'blocked'],
        });
        expect(first.conflicts()).toHaveLength(1);

        const resolved = first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'register.set',
                    path: ['status'],
                    policy: 'multi',
                    value: 'ready',
                },
            ]),
        );

        second.apply(left);
        second.apply(resolved);

        expect(first.read()).toEqual(second.read());
        expect(first.read()).toEqual({
            status: 'ready',
        });
        expect(first.conflicts()).toHaveLength(0);
    });

    it('converges ordered sequence inserts with deterministic tie-breaks', () => {
        const first = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(4_000),
            createUpdateId: sequenceIds('a'),
        });
        const second = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(4_000),
            createUpdateId: sequenceIds('b'),
        });

        const left = first.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'sequence.insert',
                    path: ['items'],
                    elementId: 'item-a',
                    positionId: 'm',
                    value: { text: 'Alpha' },
                },
            ]),
        );
        const right = second.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'sequence.insert',
                    path: ['items'],
                    elementId: 'item-b',
                    positionId: 'm',
                    value: { text: 'Beta' },
                },
            ]),
        );

        first.apply(right);
        second.apply(left);

        expect(first.read()).toEqual(second.read());
        expect(first.read()).toEqual({
            items: [{ text: 'Alpha' }, { text: 'Beta' }],
        });
    });

    it('moves and deletes ordered sequence entries through observed update IDs', () => {
        const document = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(4_500),
            createUpdateId: sequenceIds('a'),
        });

        const alpha = document.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'sequence.insert',
                    path: ['items'],
                    elementId: 'item-a',
                    positionId: 'a',
                    value: 'Alpha',
                },
            ]),
        );
        const beta = document.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'sequence.insert',
                    path: ['items'],
                    elementId: 'item-b',
                    positionId: 'b',
                    value: 'Beta',
                },
            ]),
        );
        document.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'sequence.move',
                    path: ['items'],
                    elementId: 'item-a',
                    positionId: 'z',
                    observedUpdateIds: [alpha.updateId],
                },
                {
                    kind: 'sequence.delete',
                    path: ['items'],
                    elementId: 'item-b',
                    observedUpdateIds: [beta.updateId],
                },
            ]),
        );

        expect(document.read()).toEqual({
            items: ['Alpha'],
        });
        expect(document.snapshot().metadata.tombstoneCount).toBe(1);
    });

    it('imports snapshots and keeps future dependency checks satisfied', () => {
        const source = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(5_000),
            createUpdateId: sequenceIds('a'),
            createSnapshotId: sequenceIds('snapshot'),
        });
        const add = source.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Snapshot title',
                },
            ]),
        );
        const snapshot = source.snapshot();
        const target = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(4_000),
        });

        target.importSnapshot(snapshot);
        expect(target.read()).toEqual({
            title: 'Snapshot title',
        });
        expect(target.seenUpdateIds().has(add.updateId)).toBe(true);

        const deleteTitle = createUpdateEnvelope({
            updateId: 'delete-title',
            lamport: add.lamport + 1,
            parents: [add.updateId],
            payload: rallarCrdtBatch([
                {
                    kind: 'map.delete',
                    path: [],
                    key: 'title',
                    observedUpdateIds: [add.updateId],
                },
            ]),
        });

        expect(target.apply(deleteTitle).status).toBe('applied');
        expect(target.read()).toEqual({});
    });

    it('imports ordered sequence snapshots as compaction boundaries', () => {
        const source = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(6_000),
            createUpdateId: sequenceIds('a'),
            createSnapshotId: sequenceIds('snapshot'),
        });
        const alpha = source.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'sequence.insert',
                    path: ['items'],
                    elementId: 'item-a',
                    positionId: 'a',
                    value: 'Alpha',
                },
            ]),
        );
        const beta = source.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'sequence.insert',
                    path: ['items'],
                    elementId: 'item-b',
                    positionId: 'b',
                    value: 'Beta',
                },
            ]),
        );
        const snapshot = source.snapshot('sequence-compaction');
        const target = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(7_000),
        });

        target.importSnapshot(snapshot);
        const moveAlpha = createUpdateEnvelope({
            updateId: 'move-alpha',
            lamport: 3,
            parents: [alpha.updateId, beta.updateId],
            payload: rallarCrdtBatch([
                {
                    kind: 'sequence.move',
                    path: ['items'],
                    elementId: 'item-a',
                    positionId: 'z',
                    observedUpdateIds: [alpha.updateId],
                },
                {
                    kind: 'sequence.delete',
                    path: ['items'],
                    elementId: 'item-b',
                    observedUpdateIds: [beta.updateId],
                },
            ]),
        });

        expect(target.apply(moveAlpha).status).toBe('applied');
        expect(target.read()).toEqual({
            items: ['Alpha'],
        });
        expect(target.seenUpdateIds().has(alpha.updateId)).toBe(true);
        expect(target.seenUpdateIds().has(beta.updateId)).toBe(true);
    });

    it('keeps CRDT-state snapshots equivalent to full replay across core kinds', () => {
        const full = createRallarCrdtDocument<Record<string, unknown>>({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(8_000),
            createUpdateId: sequenceIds('full'),
            createSnapshotId: sequenceIds('snapshot'),
        });

        const title = full.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.set',
                    path: [],
                    key: 'title',
                    value: 'Snapshot title',
                },
            ]),
        );
        const tag = full.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'orset.add',
                    path: ['tags'],
                    elementId: 'tag-1',
                    value: 'urgent',
                },
            ]),
        );
        full.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'register.set',
                    path: ['status'],
                    policy: 'multi',
                    value: 'ready',
                },
            ]),
        );
        const alpha = full.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'sequence.insert',
                    path: ['items'],
                    elementId: 'item-a',
                    positionId: 'a',
                    value: 'Alpha',
                },
            ]),
        );
        const snapshot = full.snapshot('state-preserving-compaction');
        const compacted = createRallarCrdtDocument<Record<string, unknown>>({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(9_000),
        });
        compacted.importSnapshot(snapshot);

        const later = full.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'map.delete',
                    path: [],
                    key: 'title',
                    observedUpdateIds: [title.updateId],
                },
                {
                    kind: 'orset.remove',
                    path: ['tags'],
                    elementId: 'tag-1',
                    observedAddUpdateIds: [tag.updateId],
                },
                {
                    kind: 'sequence.move',
                    path: ['items'],
                    elementId: 'item-a',
                    positionId: 'z',
                    observedUpdateIds: [alpha.updateId],
                },
            ]),
        );

        expect(snapshot.metadata.crdtState).toMatchObject({
            format: 'rallar.crdt.state.v1',
        });
        expect(compacted.apply(later).status).toBe('applied');
        expect(compacted.read()).toEqual(full.read());
        expect(compacted.snapshot().metadata.crdtState).toBeTruthy();
    });

    it('enforces opt-in strict path ownership validation', () => {
        const document = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-strict',
            validation: {
                pathSchema: {
                    mode: 'strict',
                    paths: [
                        {
                            path: ['title'],
                            kind: 'register',
                        },
                        {
                            path: ['items'],
                            kind: 'sequence',
                        },
                    ],
                },
            },
        });

        expect(() =>
            document.applyLocal(
                rallarCrdtBatch([
                    {
                        kind: 'register.set',
                        path: ['title'],
                        policy: 'lww',
                        value: 'Strict title',
                    },
                ]),
            ),
        ).not.toThrow();
        expect(() =>
            document.applyLocal(
                rallarCrdtBatch([
                    {
                        kind: 'map.set',
                        path: ['title'],
                        key: 'bad',
                        value: true,
                    },
                ]),
            ),
        ).toThrow(/requires a map path/);
    });

    it('uses compact causal frontiers for new local updates', () => {
        const document = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-frontier',
            now: fixedNow(10_000),
            createUpdateId: sequenceIds('frontier'),
        });

        for (let index = 0; index < 5; index += 1) {
            document.applyLocal(
                rallarCrdtBatch([
                    {
                        kind: 'map.set',
                        path: ['items'],
                        key: `item-${index}`,
                        value: index,
                    },
                ]),
            );
        }
        const next = document.applyLocal(
            rallarCrdtBatch([
                {
                    kind: 'register.set',
                    path: ['status'],
                    policy: 'lww',
                    value: 'done',
                },
            ]),
        );

        expect(next.parents).toEqual(['frontier-4']);
        expect(next.causalFrontier?.frontierUpdateIds).toEqual(next.parents);
        expect(Object.keys(next.causalFrontier?.replicaClocks ?? {})).toContain(
            'replica-frontier',
        );
    });
});

function createUpdateEnvelope(
    overrides: Partial<RallarCrdtUpdateEnvelope> = {},
): RallarCrdtUpdateEnvelope {
    const envelope: RallarCrdtUpdateEnvelope = {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: documentRef,
        updateId: 'update-1',
        replicaId: 'replica-a',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 1_000,
        payload: rallarCrdtBatch([
            {
                kind: 'register.set',
                path: ['title'],
                policy: 'lww',
                value: 'Original',
            },
        ]),
        ...overrides,
    };

    return {
        ...envelope,
        hash: hashRallarCrdtUpdateEnvelope(envelope),
    };
}

function sequenceIds(prefix: string): () => string {
    let index = 0;
    return () => `${prefix}-${index++}`;
}

function fixedNow(start: number): () => number {
    let now = start;
    return () => now++;
}

function testKeyring(
    options: Readonly<{
        activeKeyId?: string;
        secret?: string;
        randomByte?: number;
    }> = {},
) {
    return {
        activeKeyId: options.activeKeyId ?? 'test-key',
        keys: [
            {
                keyId: options.activeKeyId ?? 'test-key',
                secret: options.secret ?? 'rallar-crdt-encryption-test-secret',
            },
        ],
        visibleMetadataFields: ['operationGroupId'],
        now: fixedNow(3_000),
        randomBytes: (length: number) =>
            new Uint8Array(length).fill(options.randomByte ?? 7),
    };
}
