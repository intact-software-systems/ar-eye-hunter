import {
    hashRallarCrdtJson,
    toRallarCrdtDocumentKey,
    validateRallarCrdtSnapshotEnvelope,
    type RallarCrdtDocumentRef,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type {
    CrdtMutationCommand,
    CrdtMutationResult,
    CreateCrdtMutationCommandInput,
} from './crdt-mutation-contracts.ts';

export async function createCrdtMutationCommand(
    input: CreateCrdtMutationCommandInput,
): Promise<CrdtMutationCommand> {
    const stable = {
        ...input,
        documentKey: toRallarCrdtDocumentKey(input.document),
        version: 1 as const,
    };
    return decodeCrdtMutationCommand({
        ...stable,
        commandHash: hashRallarCrdtJson(stable),
    });
}

export function decodeCrdtMutationCommand(value: unknown): CrdtMutationCommand {
    const command = requireRecord(value, 'CRDT mutation command');
    const operation = requireOneOf(command.operation, [
        'append', 'rebuild-projection', 'compact', 'lifecycle', 'erase',
    ] as const, 'CRDT mutation operation');
    const allowed = commonCommandKeys.concat(operation === 'append'
        ? ['update', 'authorizationScope']
        : operation === 'rebuild-projection'
        ? ['projectionId']
        : operation === 'compact'
        ? ['snapshot', 'reason']
        : operation === 'lifecycle'
        ? ['lifecycle', 'retention', 'quota', 'projectionIds']
        : ['mode', 'reason']);
    requireExactKeys(command, allowed, 'CRDT mutation command');
    if (command.version !== 1) throw new TypeError('CRDT mutation version is invalid');
    requireString(command.commandId, 'commandId');
    requireString(command.commandHash, 'commandHash');
    requireEpoch(command.capturedAtEpochMs, 'capturedAtEpochMs');
    requireEpoch(command.expireAtEpochMs, 'expireAtEpochMs');
    if ((command.expireAtEpochMs as number) <= (command.capturedAtEpochMs as number)) {
        throw new TypeError('CRDT mutation expiry must follow capture time');
    }
    const actor = requireRecord(command.actor, 'CRDT mutation actor');
    requireExactKeys(actor, ['actorId', 'principalId', 'sessionId', 'serverId'], 'actor');
    Object.values(actor).forEach((field) => requireString(field, 'actor field'));
    const audience = requireRecord(command.responseAudience, 'CRDT response audience');
    requireExactKeys(
        audience,
        ['kind', 'senderSessionId', 'topicId', 'contextId'],
        'responseAudience',
    );
    requireOneOf(audience.kind, ['room', 'principal', 'app', 'admin'] as const, 'audience kind');
    requireString(audience.senderSessionId, 'senderSessionId');
    requireString(audience.topicId, 'topicId');
    requireString(audience.contextId, 'contextId');
    const document = command.document as RallarCrdtDocumentRef;
    if (toRallarCrdtDocumentKey(document) !== command.documentKey) {
        throw new TypeError('CRDT command document key differs from document');
    }
    validateOperationFields(operation, command, document);
    const { commandHash: _hash, ...stable } = command;
    if (hashRallarCrdtJson(stable) !== command.commandHash) {
        throw new TypeError('CRDT mutation command hash differs from canonical command');
    }
    return command as unknown as CrdtMutationCommand;
}

export function decodeCrdtMutationResult(value: unknown): CrdtMutationResult {
    const result = requireRecord(value, 'CRDT mutation result');
    requireExactKeys(result, [
        'version', 'operation', 'status', 'commandId', 'documentKey',
        'documentRevision', 'appendSequence', 'code',
    ], 'CRDT mutation result');
    if (result.version !== 1) throw new TypeError('CRDT mutation result version is invalid');
    requireOneOf(result.operation, [
        'append', 'rebuild-projection', 'compact', 'lifecycle', 'erase',
    ] as const, 'result operation');
    requireOneOf(result.status, ['accepted', 'replay', 'rejected'] as const, 'result status');
    requireString(result.commandId, 'result commandId');
    requireString(result.documentKey, 'result documentKey');
    requireNullableInteger(result.documentRevision, 'result documentRevision');
    requireNullableInteger(result.appendSequence, 'result appendSequence');
    if (result.code !== null) requireString(result.code, 'result code');
    return result as unknown as CrdtMutationResult;
}

function validateOperationFields(
    operation: CrdtMutationCommand['operation'],
    command: Record<string, unknown>,
    document: RallarCrdtDocumentRef,
): void {
    if (operation === 'append') {
        const update = command.update as RallarCrdtUpdateEnvelope;
        if (toRallarCrdtDocumentKey(update.document) !== toRallarCrdtDocumentKey(document)) {
            throw new TypeError('CRDT update document differs');
        }
        requireOneOf(command.authorizationScope, ['room', 'principal', 'app', 'custom'] as const, 'authorizationScope');
    } else if (operation === 'rebuild-projection') requireString(command.projectionId, 'projectionId');
    else if (operation === 'compact') {
        if (command.snapshot !== null && !validateRallarCrdtSnapshotEnvelope(command.snapshot as RallarCrdtSnapshotEnvelope).valid) {
            throw new TypeError('CRDT compact snapshot is invalid');
        }
        requireString(command.reason, 'reason');
    } else if (operation === 'lifecycle') {
        requireOneOf(command.lifecycle, ['active', 'archived', 'destroyed', 'quarantined'] as const, 'lifecycle');
        if (command.retention !== null && typeof command.retention !== 'object') {
            throw new TypeError('retention is invalid');
        }
        if (command.quota !== null && typeof command.quota !== 'object') {
            throw new TypeError('quota is invalid');
        }
        if (!Array.isArray(command.projectionIds) || command.projectionIds.some((id) => typeof id !== 'string')) {
            throw new TypeError('projectionIds are invalid');
        }
    } else {
        requireOneOf(command.mode, ['destroy-document', 'redact-payloads'] as const, 'erase mode');
        requireString(command.reason, 'reason');
    }
}

const commonCommandKeys = [
    'version', 'operation', 'commandId', 'commandHash', 'actor', 'capturedAtEpochMs',
    'expireAtEpochMs', 'document', 'documentKey', 'responseAudience',
];

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
        throw new TypeError(`${label} fields are invalid`);
    }
}

function requireString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
}

function requireEpoch(value: unknown, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
}

function requireNullableInteger(value: unknown, label: string): void {
    if (value !== null) requireEpoch(value, label);
}

function requireOneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
    if (typeof value !== 'string' || !values.includes(value as T)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as T;
}
