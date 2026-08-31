import {
    decodeRallarCrdtDocumentTypePolicy,
    isRallarCrdtOperation,
    isRallarCrdtOperationBatch,
    validateRallarCrdtJsonValue,
    type RallarCrdtEncryptionKeyMaterial,
    type RallarCrdtEncryptionKeyring,
    type RallarCrdtJsonValue,
    type RallarCrdtOperationKind,
    type RallarCrdtPathKind,
    type RallarCrdtPathSchema,
    type RallarCrdtSyncOptions,
    type RallarCrdtTransportStrategy,
    type RallarCrdtValidationOptions
} from '@shared/crdt/mod.ts';
import type {
    BlackBoxRallarCrdtApplyInput,
    BlackBoxRallarCrdtConnectionInput,
    BlackBoxRallarCrdtOpenInput,
    BlackBoxRallarCrdtScopeInput,
    BlackBoxRallarCrdtSyncInput,
    BlackBoxRallarCrdtUndoRedoInput,
    BlackBoxRallarCrdtWaitCondition,
    BlackBoxRallarCrdtWaitInput
} from './black-box-rallar-operation-contracts.ts';
import {
    decodeBlackBoxCommandRoomRef,
    isBlackBoxCommandRecord
} from './decode-black-box-rallar-command-input.ts';
import { decodeBlackBoxRallarConfigFields } from './decode-black-box-rallar-connection-config.ts';

function commandRecord(value: unknown): Record<string, unknown> {
    if (!isBlackBoxCommandRecord(value)) {
        throw new TypeError('CRDT command options must be an object.');
    }
    return value;
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError('CRDT option must be a non-empty string.');
    }
    return value;
}

function optionalNumber(value: unknown): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError('CRDT option must be a finite number.');
    }
    return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
    if (value === undefined || typeof value === 'boolean') {
        return value;
    }
    throw new TypeError('CRDT option must be boolean.');
}

function stringList(value: unknown): readonly string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new TypeError('CRDT option must be an array of strings.');
    }
    return value.map((item) => {
        const text = optionalString(item);
        if (text === undefined) {
            throw new TypeError('CRDT option must contain strings.');
        }
        return text;
    });
}

function numberList(value: unknown): readonly number[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new TypeError('CRDT option must be an array of numbers.');
    }
    return value.map((item) => {
        const number = optionalNumber(item);
        if (number === undefined) {
            throw new TypeError('CRDT option must contain numbers.');
        }
        return number;
    });
}

function isCrdtJsonValue(value: unknown): value is RallarCrdtJsonValue {
    return validateRallarCrdtJsonValue(value).length === 0;
}

function optionalJsonValue(value: unknown): RallarCrdtJsonValue | undefined {
    if (value === undefined || isCrdtJsonValue(value)) {
        return value;
    }
    throw new TypeError('CRDT option must be a JSON value.');
}

function transport(value: unknown): RallarCrdtTransportStrategy | undefined {
    switch (value) {
        case undefined:
        case 'local-only':
        case 'ws':
        case 'rtc':
        case 'ws-then-rtc':
        case 'rtc-with-ws-fallback':
            return value;
        default:
            throw new TypeError('CRDT transport is invalid.');
    }
}

function scope(value: unknown): BlackBoxRallarCrdtScopeInput | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = commandRecord(value);
    const kind = record.kind;
    if (kind !== undefined && kind !== 'app' && kind !== 'principal' && kind !== 'room' && kind !== 'custom') {
        throw new TypeError('CRDT scope kind is invalid.');
    }
    return {
        kind,
        applicationId: optionalString(record.applicationId),
        workspaceId: optionalString(record.workspaceId),
        principalId: optionalString(record.principalId),
        customScope: optionalString(record.customScope)
    };
}

function registration(value: unknown): boolean | 'if-needed' | undefined {
    if (value === undefined || typeof value === 'boolean' || value === 'if-needed') {
        return value;
    }
    throw new TypeError('CRDT registration option is invalid.');
}

function connection(value: unknown): BlackBoxRallarCrdtConnectionInput {
    const record = value === undefined ? {} : commandRecord(value);
    return {
        ...decodeBlackBoxRallarConfigFields(record),
        scope: scope(record.scope),
        roomId: optionalString(record.roomId),
        sessionId: optionalString(record.sessionId),
        crdtTransport: transport(record.crdtTransport)
    };
}

function operationKind(value: unknown): RallarCrdtOperationKind {
    switch (value) {
        case 'orset.add':
        case 'orset.remove':
        case 'register.set':
        case 'map.set':
        case 'map.delete':
        case 'sequence.insert':
        case 'sequence.delete':
        case 'sequence.move':
        case 'counter.add':
        case 'number.min':
        case 'number.max':
            return value;
        default:
            throw new TypeError('CRDT validation operation kind is invalid.');
    }
}

function pathKind(value: unknown): RallarCrdtPathKind {
    switch (value) {
        case 'register':
        case 'map':
        case 'orset':
        case 'sequence':
        case 'counter':
        case 'number':
            return value;
        default:
            throw new TypeError('CRDT validation path kind is invalid.');
    }
}

function pathSchema(value: unknown): RallarCrdtPathSchema | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = commandRecord(value);
    const mode = record.mode;
    if ((mode !== 'permissive' && mode !== 'strict') || !Array.isArray(record.paths)) {
        throw new TypeError('CRDT validation path schema is invalid.');
    }
    return {
        mode,
        paths: record.paths.map((item) => {
            const entry = commandRecord(item);
            const path = stringList(entry.path);
            if (!path) {
                throw new TypeError('CRDT validation path is required.');
            }
            return { path, kind: pathKind(entry.kind) };
        })
    };
}

function validation(value: unknown): RallarCrdtValidationOptions | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = commandRecord(value);
    const allowedOperationKinds = stringList(record.allowedOperationKinds)?.map(operationKind);
    return {
        maxPayloadBytes: optionalNumber(record.maxPayloadBytes),
        maxOperationCount: optionalNumber(record.maxOperationCount),
        maxParentCount: optionalNumber(record.maxParentCount),
        maxPathDepth: optionalNumber(record.maxPathDepth),
        maxPathSegmentLength: optionalNumber(record.maxPathSegmentLength),
        maxKeyLength: optionalNumber(record.maxKeyLength),
        maxElementIdLength: optionalNumber(record.maxElementIdLength),
        maxBlockedUpdateCount: optionalNumber(record.maxBlockedUpdateCount),
        allowedDocumentTypes: stringList(record.allowedDocumentTypes),
        allowedOperationKinds,
        allowedSchemaVersions: numberList(record.allowedSchemaVersions),
        allowedOperationVersions: numberList(record.allowedOperationVersions),
        pathSchema: pathSchema(record.pathSchema)
    };
}

function encryptionKey(value: unknown): RallarCrdtEncryptionKeyMaterial {
    const record = commandRecord(value);
    const keyId = optionalString(record.keyId);
    if (!keyId) {
        throw new TypeError('CRDT encryption keyId is required.');
    }
    return {
        keyId,
        secret: optionalString(record.secret),
        rawKeyBase64: optionalString(record.rawKeyBase64),
        ownerPrincipalId: optionalString(record.ownerPrincipalId),
        rotationEpochMs: optionalNumber(record.rotationEpochMs),
        revokedAtEpochMs: optionalNumber(record.revokedAtEpochMs)
    };
}

function encryption(value: unknown): RallarCrdtEncryptionKeyring | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = commandRecord(value);
    const activeKeyId = optionalString(record.activeKeyId);
    if (!activeKeyId || !Array.isArray(record.keys)) {
        throw new TypeError('CRDT encryption requires activeKeyId and keys.');
    }
    if (record.now !== undefined || record.randomBytes !== undefined) {
        throw new TypeError('CRDT encryption command options must be serializable.');
    }
    return {
        activeKeyId,
        keys: record.keys.map(encryptionKey),
        visibleMetadataFields: stringList(record.visibleMetadataFields)
    };
}

export function decodeBlackBoxRallarCrdtHandle(value: unknown): string {
    const record = commandRecord(value);
    const handle = optionalString(record.handle) ?? optionalString(record.commandId) ?? optionalString(record.name);
    if (!handle) {
        throw new Error('CRDT command requires handle.');
    }
    return handle;
}

export function decodeBlackBoxRallarCrdtOpenInput(value: unknown): BlackBoxRallarCrdtOpenInput {
    const record = commandRecord(value);
    const rallar = connection(record.rallar);
    const name = optionalString(record.name);
    if (!name) {
        throw new Error('crdt.open requires name.');
    }
    if (record.policies !== undefined && !Array.isArray(record.policies)) {
        throw new TypeError('CRDT document policies must be an array.');
    }
    const durableCatchUp = record.durableCatchUp;
    if (durableCatchUp !== undefined && durableCatchUp !== false && durableCatchUp !== 'http') {
        throw new TypeError('CRDT durable catch-up option is invalid.');
    }
    return {
        handle: optionalString(record.handle) ?? optionalString(record.commandId) ?? name,
        name,
        applicationId: optionalString(record.applicationId) ?? rallar.applicationId,
        workspaceId: optionalString(record.workspaceId) ?? rallar.workspaceId,
        documentId: optionalString(record.documentId),
        documentType: optionalString(record.documentType),
        scope: scope(record.scope) ?? rallar.scope,
        roomRef: decodeBlackBoxCommandRoomRef(record.roomRef) ?? rallar.roomRef,
        principalId: optionalString(record.principalId),
        customScope: optionalString(record.customScope),
        transport: transport(record.transport) ?? rallar.crdtTransport,
        persist: optionalBoolean(record.persist),
        tabSync: optionalBoolean(record.tabSync),
        initialValue: optionalJsonValue(record.initialValue),
        policies: record.policies?.map(decodeRallarCrdtDocumentTypePolicy),
        validation: validation(record.validation),
        encryption: encryption(record.encryption),
        durableCatchUp,
        apiBaseUrl: optionalString(record.apiBaseUrl) ?? rallar.apiBaseUrl,
        actor: optionalString(record.actor),
        sessionId: optionalString(record.sessionId) ?? rallar.sessionId,
        username: optionalString(record.username) ?? rallar.username,
        password: optionalString(record.password) ?? rallar.password,
        displayName: optionalString(record.displayName) ?? rallar.displayName,
        register: registration(record.register) ?? rallar.register,
        timeoutMs: optionalNumber(record.timeoutMs) ?? rallar.timeoutMs,
        roomId: optionalString(record.roomId) ?? rallar.roomId,
        rallar
    };
}

export function decodeBlackBoxRallarCrdtApplyInput(value: unknown): BlackBoxRallarCrdtApplyInput {
    const record = commandRecord(value);
    const handle = decodeBlackBoxRallarCrdtHandle(record);
    if (!isRallarCrdtOperationBatch(record.batch)) {
        throw new Error('crdt.apply requires a valid operation batch.');
    }
    return { handle, batch: record.batch };
}

export function decodeBlackBoxRallarCrdtUndoRedoInput(value: unknown): BlackBoxRallarCrdtUndoRedoInput {
    const record = commandRecord(value);
    const handle = decodeBlackBoxRallarCrdtHandle(record);
    const targetOperationGroupId = optionalString(record.targetOperationGroupId);
    if (
        !targetOperationGroupId || !Array.isArray(record.operations) || !record.operations.every(isRallarCrdtOperation)
    ) {
        throw new Error('crdt.undo/redo requires targetOperationGroupId and valid operations.');
    }
    return {
        handle,
        targetOperationGroupId,
        operations: record.operations,
        operationGroupId: optionalString(record.operationGroupId)
    };
}

function syncOptions(value: unknown): RallarCrdtSyncOptions {
    const record = commandRecord(value);
    return { reason: optionalString(record.reason), transport: transport(record.transport) };
}

export function decodeBlackBoxRallarCrdtSyncInput(value: unknown): BlackBoxRallarCrdtSyncInput {
    return { handle: decodeBlackBoxRallarCrdtHandle(value), ...syncOptions(value) };
}

function waitCondition(value: unknown): BlackBoxRallarCrdtWaitCondition {
    const record = commandRecord(value);
    const source = record.source;
    const operator = record.operator;
    if (source !== 'value' && source !== 'health') {
        throw new Error('crdt.wait condition.source must be value or health.');
    }
    if (
        operator !== 'equals' && operator !== 'notEquals' && operator !== 'contains' && operator !== 'exists' &&
        operator !== 'gte' && operator !== 'lte'
    ) {
        throw new Error('crdt.wait condition.operator is invalid.');
    }
    return { source, operator, path: optionalString(record.path), expected: optionalJsonValue(record.expected) };
}

export function decodeBlackBoxRallarCrdtWaitInput(value: unknown): BlackBoxRallarCrdtWaitInput {
    const record = commandRecord(value);
    const handle = decodeBlackBoxRallarCrdtHandle(record);
    if (!Array.isArray(record.conditions) || record.conditions.length === 0) {
        throw new Error('crdt.wait requires at least one condition.');
    }
    const timeoutMs = optionalNumber(record.timeoutMs);
    const intervalMs = optionalNumber(record.intervalMs);
    const stableForMs = optionalNumber(record.stableForMs);
    return {
        handle,
        timeoutMs: timeoutMs === undefined ? undefined : Math.max(0, timeoutMs),
        intervalMs: intervalMs === undefined ? undefined : Math.max(0, intervalMs),
        stableForMs: stableForMs === undefined ? undefined : Math.max(0, stableForMs),
        sync: record.sync === undefined || record.sync === false ? record.sync : syncOptions(record.sync),
        conditions: record.conditions.map(waitCondition)
    };
}
