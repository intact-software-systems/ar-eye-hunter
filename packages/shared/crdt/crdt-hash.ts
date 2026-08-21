import type {
    RallarCrdtJsonValue,
    RallarCrdtSnapshotEnvelope,
    RallarCrdtUpdateEnvelope,
    RallarCrdtValidationIssue
} from './crdt-types.ts';

export function canonicalRallarCrdtJson(value: unknown): string {
    const issues = validateRallarCrdtJsonValue(value);
    if (issues.length > 0) {
        throw new Error(
            `Value is not CRDT JSON-compatible: ${issues[0]?.message}`
        );
    }

    return serializeCanonicalJson(value as RallarCrdtJsonValue);
}

export function validateRallarCrdtJsonValue(
    value: unknown,
    path = '$'
): RallarCrdtValidationIssue[] {
    const issues: RallarCrdtValidationIssue[] = [];
    collectJsonIssues(value, path, issues, new Set<object>());
    return issues;
}

export function hashRallarCrdtJson(value: unknown): string {
    return hashRallarCrdtCanonicalJson(canonicalRallarCrdtJson(value));
}

export function hashRallarCrdtCanonicalJson(canonicalJson: string): string {
    let hash = 0x811c9dc5;
    const bytes = new TextEncoder().encode(canonicalJson);

    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return `crdt-fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

export async function hashRallarCrdtCanonicalJsonSha256(
    canonicalJson: string
): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalJson)
    );
    const hex = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    return `crdt-sha256:${hex}`;
}

export async function hashRallarCrdtJsonSha256(
    value: unknown
): Promise<string> {
    return await hashRallarCrdtCanonicalJsonSha256(
        canonicalRallarCrdtJson(value)
    );
}

export function hashRallarCrdtUpdateEnvelope(
    envelope: RallarCrdtUpdateEnvelope
): string {
    return hashRallarCrdtJson(toHashableUpdateEnvelope(envelope));
}

export function hashRallarCrdtSnapshotEnvelope(
    envelope: RallarCrdtSnapshotEnvelope
): string {
    return hashRallarCrdtJson(toHashableSnapshotEnvelope(envelope));
}

export function byteLengthOfRallarCrdtJson(value: unknown): number {
    return new TextEncoder().encode(canonicalRallarCrdtJson(value)).byteLength;
}

function serializeCanonicalJson(value: RallarCrdtJsonValue): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(serializeCanonicalJson).join(',')}]`;
    }

    const entries = Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));

    return `{${
        entries
            .map(
                ([key, entryValue]) => `${JSON.stringify(key)}:${serializeCanonicalJson(entryValue)}`
            )
            .join(',')
    }}`;
}

function collectJsonIssues(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
    seenObjects: Set<object>
): void {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    ) {
        return;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            issues.push({
                path,
                code: 'non-finite-number',
                message: 'CRDT JSON values must not contain non-finite numbers.'
            });
        }
        return;
    }

    if (typeof value !== 'object') {
        issues.push({
            path,
            code: 'unsupported-json-value',
            message: `CRDT JSON values must not contain ${typeof value}.`
        });
        return;
    }

    if (seenObjects.has(value)) {
        issues.push({
            path,
            code: 'cyclic-json-value',
            message: 'CRDT JSON values must not contain cycles.'
        });
        return;
    }
    seenObjects.add(value);

    if (Array.isArray(value)) {
        value.forEach((entry, index) => collectJsonIssues(entry, `${path}[${index}]`, issues, seenObjects));
        seenObjects.delete(value);
        return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        issues.push({
            path,
            code: 'unsupported-json-object',
            message: 'CRDT JSON values must use plain objects, arrays, and primitives.'
        });
        seenObjects.delete(value);
        return;
    }

    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) {
            issues.push({
                path: `${path}.${key}`,
                code: 'undefined-json-value',
                message: 'CRDT JSON object properties must not be undefined.'
            });
            continue;
        }
        collectJsonIssues(entry, `${path}.${key}`, issues, seenObjects);
    }

    seenObjects.delete(value);
}

function toHashableUpdateEnvelope(
    envelope: RallarCrdtUpdateEnvelope
): Record<string, unknown> {
    return omitUndefinedProperties({
        protocolVersion: envelope.protocolVersion,
        document: envelope.document,
        updateId: envelope.updateId,
        replicaId: envelope.replicaId,
        actorId: envelope.actorId,
        sessionId: envelope.sessionId,
        lamport: envelope.lamport,
        parents: envelope.parents,
        schemaVersion: envelope.schemaVersion,
        operationVersion: envelope.operationVersion,
        createdAtEpochMs: envelope.createdAtEpochMs,
        causalFrontier: envelope.causalFrontier,
        payload: envelope.payload
    });
}

function toHashableSnapshotEnvelope(
    envelope: RallarCrdtSnapshotEnvelope
): Record<string, unknown> {
    return omitUndefinedProperties({
        protocolVersion: envelope.protocolVersion,
        document: envelope.document,
        snapshotId: envelope.snapshotId,
        schemaVersion: envelope.schemaVersion,
        createdAtEpochMs: envelope.createdAtEpochMs,
        maxLamport: envelope.maxLamport,
        includedUpdateIds: envelope.includedUpdateIds,
        updateClock: envelope.updateClock,
        value: envelope.value,
        metadata: envelope.metadata
    });
}

function omitUndefinedProperties(
    value: Record<string, unknown>
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined)
    );
}
