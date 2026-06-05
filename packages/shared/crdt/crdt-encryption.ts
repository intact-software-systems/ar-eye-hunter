import {
    canonicalRallarCrdtJson,
    hashRallarCrdtJson,
    hashRallarCrdtSnapshotEnvelope,
    hashRallarCrdtUpdateEnvelope,
} from './crdt-hash.ts';
import {
    formatRallarCrdtValidation,
    validateRallarCrdtOperationBatch,
    validateRallarCrdtSnapshotEnvelope,
} from './crdt-codec.ts';
import type {
    RallarCrdtEncryptedJsonEnvelope,
    RallarCrdtEncryptedPlaintextType,
    RallarCrdtOperationBatch,
    RallarCrdtSnapshotEnvelope,
    RallarCrdtSnapshotMetadata,
    RallarCrdtUpdateEnvelope,
} from './crdt-types.ts';

export type RallarCrdtEncryptionKeyMaterial = Readonly<{
    keyId: string;
    secret?: string;
    rawKeyBase64?: string;
    ownerPrincipalId?: string;
    rotationEpochMs?: number;
    revokedAtEpochMs?: number;
}>;

export type RallarCrdtEncryptionKeyring = Readonly<{
    activeKeyId: string;
    keys: readonly RallarCrdtEncryptionKeyMaterial[];
    visibleMetadataFields?: readonly string[];
    now?: () => number;
    randomBytes?: (length: number) => Uint8Array;
}>;

export type RallarCrdtEncryptionKeyStatus =
    | 'active'
    | 'available'
    | 'revoked'
    | 'material-missing';

export type RallarCrdtEncryptionKeyDescriptor = Readonly<{
    keyId: string;
    status: RallarCrdtEncryptionKeyStatus;
    ownerPrincipalId?: string;
    rotationEpochMs?: number;
    revokedAtEpochMs?: number;
    hasMaterial: boolean;
}>;

type SnapshotPlaintextBody<TValue> = Readonly<{
    value: TValue;
    metadata: RallarCrdtSnapshotMetadata;
}>;

export function isRallarCrdtEncryptedJsonEnvelope(
    value: unknown,
): value is RallarCrdtEncryptedJsonEnvelope {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { kind?: unknown }).kind === 'encrypted-json' &&
        (value as { format?: unknown }).format ===
            'rallar.crdt.encrypted-json.v1'
    );
}

export function isRallarCrdtEncryptedOperationBatch(
    value: unknown,
): value is RallarCrdtOperationBatch &
    Readonly<{ encryption: RallarCrdtEncryptedJsonEnvelope }> {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { kind?: unknown }).kind === 'batch' &&
        isRallarCrdtEncryptedJsonEnvelope(
            (value as { encryption?: unknown }).encryption,
        )
    );
}

export function describeRallarCrdtEncryptionKeyring(
    keyring: RallarCrdtEncryptionKeyring,
): readonly RallarCrdtEncryptionKeyDescriptor[] {
    return keyring.keys.map((key) => ({
        keyId: key.keyId,
        status: key.revokedAtEpochMs
            ? 'revoked'
            : !key.secret && !key.rawKeyBase64
              ? 'material-missing'
              : key.keyId === keyring.activeKeyId
                ? 'active'
                : 'available',
        ownerPrincipalId: key.ownerPrincipalId,
        rotationEpochMs: key.rotationEpochMs,
        revokedAtEpochMs: key.revokedAtEpochMs,
        hasMaterial: !!key.secret || !!key.rawKeyBase64,
    }));
}

export function rotateRallarCrdtEncryptionKeyring(
    keyring: RallarCrdtEncryptionKeyring,
    nextKey: RallarCrdtEncryptionKeyMaterial,
): RallarCrdtEncryptionKeyring {
    const rotatedAtEpochMs =
        nextKey.rotationEpochMs ?? keyring.now?.() ?? Date.now();
    const existing = keyring.keys.filter((key) => key.keyId !== nextKey.keyId);
    return {
        ...keyring,
        activeKeyId: nextKey.keyId,
        keys: [
            ...existing,
            {
                ...nextKey,
                rotationEpochMs: rotatedAtEpochMs,
            },
        ],
    };
}

export function revokeRallarCrdtEncryptionKey(
    keyring: RallarCrdtEncryptionKeyring,
    keyId: string,
    revokedAtEpochMs = keyring.now?.() ?? Date.now(),
): RallarCrdtEncryptionKeyring {
    return {
        ...keyring,
        keys: keyring.keys.map((key) =>
            key.keyId === keyId
                ? {
                      ...key,
                      revokedAtEpochMs,
                  }
                : key,
        ),
    };
}

export async function encryptRallarCrdtUpdateEnvelope<
    TPayload extends RallarCrdtOperationBatch,
>(
    update: RallarCrdtUpdateEnvelope<TPayload>,
    keyring: RallarCrdtEncryptionKeyring,
): Promise<RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>> {
    if (isRallarCrdtEncryptedOperationBatch(update.payload)) {
        return update as RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>;
    }

    const visibleFields = new Set(keyring.visibleMetadataFields ?? []);
    const encryptedPayload = await encryptJson(update.payload, {
        keyring,
        plaintextType: 'operation-batch',
        aad: createUpdatePayloadAad(update, hashRallarCrdtJson(update.payload)),
    });
    const encryptedUpdateWithoutHash = {
        ...withoutHash(update),
        payload: {
            kind: 'batch' as const,
            operations: [],
            ...(visibleFields.has('operationGroupId') &&
            update.payload.operationGroupId
                ? { operationGroupId: update.payload.operationGroupId }
                : {}),
            ...(visibleFields.has('undo') && update.payload.undo
                ? { undo: update.payload.undo }
                : {}),
            ...(visibleFields.has('redo') && update.payload.redo
                ? { redo: update.payload.redo }
                : {}),
            encryption: encryptedPayload,
        },
    };

    return {
        ...encryptedUpdateWithoutHash,
        hash: hashRallarCrdtUpdateEnvelope(encryptedUpdateWithoutHash),
    };
}

export async function decryptRallarCrdtUpdateEnvelope<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
>(
    update: RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>,
    keyring: RallarCrdtEncryptionKeyring,
): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
    if (!isRallarCrdtEncryptedOperationBatch(update.payload)) {
        return update as RallarCrdtUpdateEnvelope<TPayload>;
    }

    const plaintextPayload = (await decryptJson(update.payload.encryption, {
        keyring,
        aad: createUpdatePayloadAad(
            update,
            update.payload.encryption.plaintextHash,
        ),
    })) as TPayload;
    const validation = validateRallarCrdtOperationBatch(
        plaintextPayload,
        '$.payload',
    );
    if (!validation.valid) {
        throw new Error(formatRallarCrdtValidation(validation));
    }

    const plaintextUpdateWithoutHash = {
        ...withoutHash(update),
        payload: plaintextPayload,
    };
    return {
        ...plaintextUpdateWithoutHash,
        hash: hashRallarCrdtUpdateEnvelope(plaintextUpdateWithoutHash),
    };
}

export async function encryptRallarCrdtSnapshotEnvelope<TValue>(
    snapshot: RallarCrdtSnapshotEnvelope<TValue>,
    keyring: RallarCrdtEncryptionKeyring,
): Promise<RallarCrdtSnapshotEnvelope<RallarCrdtEncryptedJsonEnvelope>> {
    if (isRallarCrdtEncryptedJsonEnvelope(snapshot.value)) {
        return snapshot as RallarCrdtSnapshotEnvelope<RallarCrdtEncryptedJsonEnvelope>;
    }

    const body: SnapshotPlaintextBody<TValue> = {
        value: snapshot.value,
        metadata: snapshot.metadata,
    };
    const encryptedBody = await encryptJson(body, {
        keyring,
        plaintextType: 'snapshot-body',
        aad: createSnapshotBodyAad(snapshot, hashRallarCrdtJson(body)),
    });
    const encryptedSnapshotWithoutHash = {
        ...withoutHash(snapshot),
        value: encryptedBody,
        metadata: toVisibleSnapshotMetadata(snapshot.metadata),
    };

    return {
        ...encryptedSnapshotWithoutHash,
        hash: hashRallarCrdtSnapshotEnvelope(encryptedSnapshotWithoutHash),
    };
}

export async function decryptRallarCrdtSnapshotEnvelope<TValue>(
    snapshot: RallarCrdtSnapshotEnvelope,
    keyring: RallarCrdtEncryptionKeyring,
): Promise<RallarCrdtSnapshotEnvelope<TValue>> {
    if (!isRallarCrdtEncryptedJsonEnvelope(snapshot.value)) {
        return snapshot as RallarCrdtSnapshotEnvelope<TValue>;
    }

    const body = (await decryptJson(snapshot.value, {
        keyring,
        aad: createSnapshotBodyAad(snapshot, snapshot.value.plaintextHash),
    })) as SnapshotPlaintextBody<TValue>;
    const plaintextSnapshotWithoutHash = {
        ...withoutHash(snapshot),
        value: body.value,
        metadata: body.metadata,
    };
    const plaintextSnapshot = {
        ...plaintextSnapshotWithoutHash,
        hash: hashRallarCrdtSnapshotEnvelope(plaintextSnapshotWithoutHash),
    };
    const validation = validateRallarCrdtSnapshotEnvelope(plaintextSnapshot);
    if (!validation.valid) {
        throw new Error(formatRallarCrdtValidation(validation));
    }
    return plaintextSnapshot;
}

async function encryptJson(
    plaintext: unknown,
    input: Readonly<{
        keyring: RallarCrdtEncryptionKeyring;
        plaintextType: RallarCrdtEncryptedPlaintextType;
        aad: unknown;
    }>,
): Promise<RallarCrdtEncryptedJsonEnvelope> {
    const key = resolveActiveKey(input.keyring);
    const plaintextHash = hashRallarCrdtJson(plaintext);
    const aad = stripUndefined({
        ...asRecord(input.aad),
        keyId: key.keyId,
        plaintextHash,
        plaintextType: input.plaintextType,
    });
    const nonce = randomBytes(input.keyring, 12);
    const cryptoKey = await importAesGcmKey(key);
    const ciphertext = await subtle().encrypt(
        {
            name: 'AES-GCM',
            iv: toArrayBuffer(nonce),
            additionalData: toArrayBuffer(
                encodeUtf8(canonicalRallarCrdtJson(aad)),
            ),
        },
        cryptoKey,
        toArrayBuffer(encodeUtf8(canonicalRallarCrdtJson(plaintext))),
    );

    return {
        kind: 'encrypted-json',
        format: 'rallar.crdt.encrypted-json.v1',
        algorithm: 'AES-GCM-256',
        keyId: key.keyId,
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
        plaintextHash,
        aadHash: hashRallarCrdtJson(aad),
        plaintextType: input.plaintextType,
        encryptedAtEpochMs: input.keyring.now?.() ?? Date.now(),
        ...(input.keyring.visibleMetadataFields
            ? { visibleMetadataFields: input.keyring.visibleMetadataFields }
            : {}),
    };
}

async function decryptJson(
    encrypted: RallarCrdtEncryptedJsonEnvelope,
    input: Readonly<{
        keyring: RallarCrdtEncryptionKeyring;
        aad: unknown;
    }>,
): Promise<unknown> {
    const key = resolveKey(input.keyring, encrypted.keyId);
    const aad = stripUndefined({
        ...asRecord(input.aad),
        keyId: encrypted.keyId,
        plaintextHash: encrypted.plaintextHash,
        plaintextType: encrypted.plaintextType,
    });
    if (hashRallarCrdtJson(aad) !== encrypted.aadHash) {
        throw new Error('CRDT encrypted payload AAD hash mismatch.');
    }

    const plaintext = await subtle().decrypt(
        {
            name: 'AES-GCM',
            iv: toArrayBuffer(decodeBase64Url(encrypted.nonce)),
            additionalData: toArrayBuffer(
                encodeUtf8(canonicalRallarCrdtJson(aad)),
            ),
        },
        await importAesGcmKey(key),
        toArrayBuffer(decodeBase64Url(encrypted.ciphertext)),
    );
    const parsed = JSON.parse(decodeUtf8(new Uint8Array(plaintext)));
    if (hashRallarCrdtJson(parsed) !== encrypted.plaintextHash) {
        throw new Error('CRDT encrypted payload plaintext hash mismatch.');
    }
    return parsed;
}

function createUpdatePayloadAad(
    update: RallarCrdtUpdateEnvelope,
    plaintextHash: string,
): Record<string, unknown> {
    const { payload: _payload, hash: _hash, ...metadata } = update;
    return {
        context: 'rallar.crdt.update.payload.v1',
        plaintextHash,
        envelope: metadata,
    };
}

function createSnapshotBodyAad(
    snapshot: RallarCrdtSnapshotEnvelope,
    plaintextHash: string,
): Record<string, unknown> {
    const {
        value: _value,
        hash: _hash,
        metadata: _metadata,
        ...metadata
    } = snapshot;
    return {
        context: 'rallar.crdt.snapshot.body.v1',
        plaintextHash,
        envelope: metadata,
    };
}

function toVisibleSnapshotMetadata(
    metadata: RallarCrdtSnapshotMetadata,
): RallarCrdtSnapshotMetadata {
    return {
        updateCount: metadata.updateCount,
        ...(metadata.createdByReplicaId
            ? { createdByReplicaId: metadata.createdByReplicaId }
            : {}),
        ...(metadata.tombstoneCount !== undefined
            ? { tombstoneCount: metadata.tombstoneCount }
            : {}),
        ...(metadata.conflictCount !== undefined
            ? { conflictCount: metadata.conflictCount }
            : {}),
        ...(metadata.reason ? { reason: metadata.reason } : {}),
    };
}

function resolveActiveKey(
    keyring: RallarCrdtEncryptionKeyring,
): RallarCrdtEncryptionKeyMaterial {
    return resolveKey(keyring, keyring.activeKeyId);
}

function resolveKey(
    keyring: RallarCrdtEncryptionKeyring,
    keyId: string,
): RallarCrdtEncryptionKeyMaterial {
    const key = keyring.keys.find((candidate) => candidate.keyId === keyId);
    if (!key) {
        throw new Error(`Missing CRDT encryption key: ${keyId}.`);
    }
    if (key.revokedAtEpochMs !== undefined) {
        throw new Error(`CRDT encryption key is revoked: ${keyId}.`);
    }
    if (!key.secret && !key.rawKeyBase64) {
        throw new Error(`CRDT encryption key has no material: ${keyId}.`);
    }
    return key;
}

async function importAesGcmKey(
    key: RallarCrdtEncryptionKeyMaterial,
): Promise<CryptoKey> {
    const bytes = key.rawKeyBase64
        ? decodeBase64Url(key.rawKeyBase64)
        : new Uint8Array(
              await subtle().digest(
                  'SHA-256',
                  toArrayBuffer(encodeUtf8(key.secret ?? '')),
              ),
          );
    if (bytes.byteLength !== 32) {
        throw new Error('CRDT AES-GCM-256 keys must be 32 bytes.');
    }
    return await subtle().importKey(
        'raw',
        toArrayBuffer(bytes),
        'AES-GCM',
        false,
        ['encrypt', 'decrypt'],
    );
}

function subtle(): SubtleCrypto {
    const candidate = globalThis.crypto?.subtle;
    if (!candidate) {
        throw new Error('CRDT encryption requires Web Crypto SubtleCrypto.');
    }
    return candidate;
}

function randomBytes(
    keyring: RallarCrdtEncryptionKeyring,
    length: number,
): Uint8Array {
    if (keyring.randomBytes) {
        return keyring.randomBytes(length);
    }
    const values = new Uint8Array(length);
    globalThis.crypto.getRandomValues(values);
    return values;
}

function withoutHash<T extends { hash?: string }>(value: T): Omit<T, 'hash'> {
    const { hash: _hash, ...without } = value;
    return without;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function encodeUtf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function decodeUtf8(value: Uint8Array): string {
    return new TextDecoder().decode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

function stripUndefined(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripUndefined);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, entryValue]) => entryValue !== undefined)
                .map(([key, entryValue]) => [key, stripUndefined(entryValue)]),
        );
    }
    return value;
}

const BASE64_ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64Url(bytes: Uint8Array): string {
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index] ?? 0;
        const second = bytes[index + 1] ?? 0;
        const third = bytes[index + 2] ?? 0;
        const chunk = (first << 16) | (second << 8) | third;
        output += BASE64_ALPHABET[(chunk >> 18) & 63];
        output += BASE64_ALPHABET[(chunk >> 12) & 63];
        output +=
            index + 1 < bytes.length ? BASE64_ALPHABET[(chunk >> 6) & 63] : '=';
        output += index + 2 < bytes.length ? BASE64_ALPHABET[chunk & 63] : '=';
    }
    return output.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(encoded: string): Uint8Array {
    const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        '=',
    );
    const bytes: number[] = [];
    for (let index = 0; index < padded.length; index += 4) {
        const chunk =
            (decodeBase64Char(padded[index] ?? 'A') << 18) |
            (decodeBase64Char(padded[index + 1] ?? 'A') << 12) |
            (decodeBase64Char(padded[index + 2] ?? 'A') << 6) |
            decodeBase64Char(padded[index + 3] ?? 'A');
        bytes.push((chunk >> 16) & 255);
        if (padded[index + 2] !== '=') {
            bytes.push((chunk >> 8) & 255);
        }
        if (padded[index + 3] !== '=') {
            bytes.push(chunk & 255);
        }
    }
    return new Uint8Array(bytes);
}

function decodeBase64Char(char: string): number {
    if (char === '=') {
        return 0;
    }
    const index = BASE64_ALPHABET.indexOf(char);
    if (index < 0) {
        throw new Error(
            'Invalid base64url character in CRDT encryption value.',
        );
    }
    return index;
}
