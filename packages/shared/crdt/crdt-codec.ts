import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    type RallarCrdtCounterAddOperation,
    type RallarCrdtDocumentRef,
    type RallarCrdtEncryptedJsonEnvelope,
    type RallarCrdtMapDeleteOperation,
    type RallarCrdtMapSetOperation,
    type RallarCrdtNumberMaxOperation,
    type RallarCrdtNumberMinOperation,
    type RallarCrdtOperation,
    type RallarCrdtOperationBatch,
    type RallarCrdtOperationKind,
    type RallarCrdtPathKind,
    type RallarCrdtPathSchema,
    type RallarCrdtOrSetAddOperation,
    type RallarCrdtOrSetRemoveOperation,
    type RallarCrdtPath,
    type RallarCrdtRegisterSetOperation,
    type RallarCrdtSequenceDeleteOperation,
    type RallarCrdtSequenceInsertOperation,
    type RallarCrdtSequenceMoveOperation,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtSyncRequestEnvelope,
    type RallarCrdtSyncResponseEnvelope,
    type RallarCrdtUpdateEnvelope,
    type RallarCrdtValidationIssue,
    type RallarCrdtValidationResult,
} from './crdt-types.ts';
import {
    byteLengthOfRallarCrdtJson,
    hashRallarCrdtSnapshotEnvelope,
    hashRallarCrdtUpdateEnvelope,
    validateRallarCrdtJsonValue,
} from './crdt-hash.ts';

export type RallarCrdtValidationOptions = Readonly<{
    maxPayloadBytes?: number;
    maxOperationCount?: number;
    maxParentCount?: number;
    maxPathDepth?: number;
    maxPathSegmentLength?: number;
    maxKeyLength?: number;
    maxElementIdLength?: number;
    maxBlockedUpdateCount?: number;
    allowedDocumentTypes?: readonly string[];
    allowedOperationKinds?: readonly RallarCrdtOperationKind[];
    allowedSchemaVersions?: readonly number[];
    allowedOperationVersions?: readonly number[];
    pathSchema?: RallarCrdtPathSchema;
}>;

export function okRallarCrdtValidation(): RallarCrdtValidationResult {
    return {
        valid: true,
        issues: [],
    };
}

export function failRallarCrdtValidation(
    issues: readonly RallarCrdtValidationIssue[],
): RallarCrdtValidationResult {
    return {
        valid: issues.length === 0,
        issues,
    };
}

export function validateRallarCrdtDocumentRef(
    value: unknown,
    path = '$',
    options: RallarCrdtValidationOptions = {},
): RallarCrdtValidationResult {
    const issues: RallarCrdtValidationIssue[] = [];

    if (!isRecord(value)) {
        return failRallarCrdtValidation([
            {
                path,
                code: 'invalid-document-ref',
                message: 'CRDT document ref must be an object.',
            },
        ]);
    }

    requireNonEmptyString(value.applicationId, `${path}.applicationId`, issues);
    requireNonEmptyString(value.documentType, `${path}.documentType`, issues);
    requireNonEmptyString(value.documentId, `${path}.documentId`, issues);
    requireOptionalNonEmptyString(
        value.workspaceId,
        `${path}.workspaceId`,
        issues,
    );

    if (
        value.scope !== 'app' &&
        value.scope !== 'principal' &&
        value.scope !== 'room' &&
        value.scope !== 'custom'
    ) {
        issues.push({
            path: `${path}.scope`,
            code: 'invalid-document-scope',
            message:
                'CRDT document scope must be app, principal, room, or custom.',
        });
    }

    if (
        options.allowedDocumentTypes &&
        typeof value.documentType === 'string' &&
        !options.allowedDocumentTypes.includes(value.documentType)
    ) {
        issues.push({
            path: `${path}.documentType`,
            code: 'document-type-not-allowed',
            message: `CRDT document type is not allowed: ${value.documentType}.`,
        });
    }

    if (value.scope === 'room') {
        validateRoomDocumentRef(value, path, issues);
    } else if (value.roomRef !== undefined) {
        issues.push({
            path: `${path}.roomRef`,
            code: 'unexpected-room-ref',
            message: 'Only room-scoped CRDT documents may include roomRef.',
        });
    }

    if (value.scope === 'principal') {
        requireNonEmptyString(value.principalId, `${path}.principalId`, issues);
    } else if (value.principalId !== undefined) {
        issues.push({
            path: `${path}.principalId`,
            code: 'unexpected-principal-id',
            message:
                'Only principal-scoped CRDT documents may include principalId.',
        });
    }

    if (value.scope === 'custom') {
        requireNonEmptyString(value.customScope, `${path}.customScope`, issues);
    } else if (value.customScope !== undefined) {
        issues.push({
            path: `${path}.customScope`,
            code: 'unexpected-custom-scope',
            message:
                'Only custom-scoped CRDT documents may include customScope.',
        });
    }

    return failRallarCrdtValidation(issues);
}

export function validateRallarCrdtOperation(
    value: unknown,
    path = '$',
    options: RallarCrdtValidationOptions = {},
): RallarCrdtValidationResult {
    const issues: RallarCrdtValidationIssue[] = [];

    if (!isRecord(value)) {
        return failRallarCrdtValidation([
            {
                path,
                code: 'invalid-operation',
                message: 'CRDT operation must be an object.',
            },
        ]);
    }

    if (
        value.kind !== 'orset.add' &&
        value.kind !== 'orset.remove' &&
        value.kind !== 'register.set' &&
        value.kind !== 'map.set' &&
        value.kind !== 'map.delete' &&
        value.kind !== 'sequence.insert' &&
        value.kind !== 'sequence.delete' &&
        value.kind !== 'sequence.move' &&
        value.kind !== 'counter.add' &&
        value.kind !== 'number.min' &&
        value.kind !== 'number.max'
    ) {
        issues.push({
            path: `${path}.kind`,
            code: 'invalid-operation-kind',
            message: 'CRDT operation kind is not supported.',
        });
        return failRallarCrdtValidation(issues);
    }

    if (
        options.allowedOperationKinds &&
        !options.allowedOperationKinds.includes(value.kind)
    ) {
        issues.push({
            path: `${path}.kind`,
            code: 'operation-kind-not-allowed',
            message: `CRDT operation kind is not allowed: ${value.kind}.`,
        });
    }

    switch (value.kind) {
        case 'orset.add':
            validateOrSetAddOperation(value, path, issues, options);
            break;
        case 'orset.remove':
            validateOrSetRemoveOperation(value, path, issues, options);
            break;
        case 'register.set':
            validateRegisterSetOperation(value, path, issues, options);
            break;
        case 'map.set':
            validateMapSetOperation(value, path, issues, options);
            break;
        case 'map.delete':
            validateMapDeleteOperation(value, path, issues, options);
            break;
        case 'sequence.insert':
            validateSequenceInsertOperation(value, path, issues, options);
            break;
        case 'sequence.delete':
            validateSequenceDeleteOperation(value, path, issues, options);
            break;
        case 'sequence.move':
            validateSequenceMoveOperation(value, path, issues, options);
            break;
        case 'counter.add':
            validateCounterAddOperation(value, path, issues, options);
            break;
        case 'number.min':
            validateNumberMinOperation(value, path, issues, options);
            break;
        case 'number.max':
            validateNumberMaxOperation(value, path, issues, options);
            break;
    }
    validateOperationPathOwnership(
        value as RallarCrdtOperation,
        path,
        options,
        issues,
    );

    return failRallarCrdtValidation(issues);
}

export function validateRallarCrdtOperationBatch(
    value: unknown,
    path = '$',
    options: RallarCrdtValidationOptions = {},
): RallarCrdtValidationResult {
    const issues: RallarCrdtValidationIssue[] = [];

    if (!isRecord(value)) {
        return failRallarCrdtValidation([
            {
                path,
                code: 'invalid-operation-batch',
                message: 'CRDT operation batch must be an object.',
            },
        ]);
    }

    if (value.kind !== 'batch') {
        issues.push({
            path: `${path}.kind`,
            code: 'invalid-operation-batch-kind',
            message: 'CRDT operation batch kind must be batch.',
        });
    }

    if (!Array.isArray(value.operations)) {
        issues.push({
            path: `${path}.operations`,
            code: 'invalid-operation-list',
            message: 'CRDT operation batch operations must be an array.',
        });
    } else if (
        options.maxOperationCount !== undefined &&
        value.operations.length > options.maxOperationCount
    ) {
        issues.push({
            path: `${path}.operations`,
            code: 'operation-count-too-large',
            message: `CRDT operation batch exceeds ${options.maxOperationCount} operations.`,
        });
    } else if (value.encryption !== undefined) {
        if (value.operations.length > 0) {
            issues.push({
                path: `${path}.operations`,
                code: 'encrypted-payload-must-hide-operations',
                message:
                    'Encrypted CRDT operation batches must not expose plaintext operations.',
            });
        }
    } else {
        value.operations.forEach((operation, index) => {
            issues.push(
                ...validateRallarCrdtOperation(
                    operation,
                    `${path}.operations[${index}]`,
                    options,
                ).issues,
            );
        });
    }
    requireOptionalNonEmptyString(
        value.operationGroupId,
        `${path}.operationGroupId`,
        issues,
    );
    if (value.undo !== undefined) {
        validateUndoRedoMetadata(value.undo, `${path}.undo`, issues);
    }
    if (value.redo !== undefined) {
        validateUndoRedoMetadata(value.redo, `${path}.redo`, issues);
    }
    if (value.encryption !== undefined) {
        validateEncryptedJsonEnvelope(
            value.encryption,
            `${path}.encryption`,
            'operation-batch',
            issues,
        );
    }

    return failRallarCrdtValidation(issues);
}

export function validateRallarCrdtUpdateEnvelope(
    value: unknown,
    path = '$',
    options: RallarCrdtValidationOptions = {},
): RallarCrdtValidationResult {
    const issues: RallarCrdtValidationIssue[] = [];

    if (!isRecord(value)) {
        return failRallarCrdtValidation([
            {
                path,
                code: 'invalid-update-envelope',
                message: 'CRDT update envelope must be an object.',
            },
        ]);
    }

    requireExactNumber(
        value.protocolVersion,
        RALLAR_CRDT_PROTOCOL_VERSION,
        `${path}.protocolVersion`,
        'unknown-protocol-version',
        issues,
    );
    requireNonEmptyString(value.updateId, `${path}.updateId`, issues);
    requireNonEmptyString(value.replicaId, `${path}.replicaId`, issues);
    requireOptionalNonEmptyString(value.actorId, `${path}.actorId`, issues);
    requireOptionalNonEmptyString(value.sessionId, `${path}.sessionId`, issues);
    requireNonNegativeInteger(value.lamport, `${path}.lamport`, issues);
    requireNonNegativeInteger(
        value.createdAtEpochMs,
        `${path}.createdAtEpochMs`,
        issues,
    );
    requireNonNegativeInteger(
        value.schemaVersion,
        `${path}.schemaVersion`,
        issues,
    );
    requireAllowedVersion(
        value.schemaVersion,
        options.allowedSchemaVersions,
        `${path}.schemaVersion`,
        'schema-version-not-allowed',
        issues,
    );
    requireAllowedVersion(
        value.operationVersion,
        options.allowedOperationVersions ?? [RALLAR_CRDT_OPERATION_VERSION],
        `${path}.operationVersion`,
        'unknown-operation-version',
        issues,
    );
    validateStringArray(value.parents, `${path}.parents`, issues);
    if (
        options.maxParentCount !== undefined &&
        Array.isArray(value.parents) &&
        value.parents.length > options.maxParentCount
    ) {
        issues.push({
            path: `${path}.parents`,
            code: 'parent-count-too-large',
            message: `CRDT update exceeds ${options.maxParentCount} parents.`,
        });
    }
    if (value.causalFrontier !== undefined) {
        validateCausalFrontier(
            value.causalFrontier,
            `${path}.causalFrontier`,
            issues,
        );
    }
    issues.push(
        ...validateRallarCrdtDocumentRef(
            value.document,
            `${path}.document`,
            options,
        ).issues,
    );
    issues.push(
        ...validateRallarCrdtOperationBatch(
            value.payload,
            `${path}.payload`,
            options,
        ).issues,
    );

    if (options.maxPayloadBytes !== undefined && issues.length === 0) {
        try {
            const payloadBytes = byteLengthOfRallarCrdtJson(value.payload);
            if (payloadBytes > options.maxPayloadBytes) {
                issues.push({
                    path: `${path}.payload`,
                    code: 'payload-too-large',
                    message: `CRDT update payload exceeds ${options.maxPayloadBytes} bytes.`,
                });
            }
        } catch (error) {
            issues.push({
                path: `${path}.payload`,
                code: 'payload-not-json',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    if (typeof value.hash === 'string' && issues.length === 0) {
        const expected = hashRallarCrdtUpdateEnvelope(
            value as RallarCrdtUpdateEnvelope,
        );
        if (value.hash !== expected) {
            issues.push({
                path: `${path}.hash`,
                code: 'hash-mismatch',
                message:
                    'CRDT update hash does not match its canonical payload.',
            });
        }
    } else if (value.hash !== undefined) {
        issues.push({
            path: `${path}.hash`,
            code: 'invalid-hash',
            message: 'CRDT update hash must be a string when present.',
        });
    }

    return failRallarCrdtValidation(issues);
}

export function validateRallarCrdtSnapshotEnvelope(
    value: unknown,
    path = '$',
    options: RallarCrdtValidationOptions = {},
): RallarCrdtValidationResult {
    const issues: RallarCrdtValidationIssue[] = [];

    if (!isRecord(value)) {
        return failRallarCrdtValidation([
            {
                path,
                code: 'invalid-snapshot-envelope',
                message: 'CRDT snapshot envelope must be an object.',
            },
        ]);
    }

    requireExactNumber(
        value.protocolVersion,
        RALLAR_CRDT_PROTOCOL_VERSION,
        `${path}.protocolVersion`,
        'unknown-protocol-version',
        issues,
    );
    requireNonEmptyString(value.snapshotId, `${path}.snapshotId`, issues);
    requireNonNegativeInteger(
        value.schemaVersion,
        `${path}.schemaVersion`,
        issues,
    );
    requireAllowedVersion(
        value.schemaVersion,
        options.allowedSchemaVersions,
        `${path}.schemaVersion`,
        'schema-version-not-allowed',
        issues,
    );
    requireNonNegativeInteger(
        value.createdAtEpochMs,
        `${path}.createdAtEpochMs`,
        issues,
    );
    requireNonNegativeInteger(value.maxLamport, `${path}.maxLamport`, issues);
    validateStringArray(
        value.includedUpdateIds,
        `${path}.includedUpdateIds`,
        issues,
    );
    issues.push(
        ...validateRallarCrdtDocumentRef(
            value.document,
            `${path}.document`,
            options,
        ).issues,
    );
    issues.push(...validateRallarCrdtJsonValue(value.value, `${path}.value`));
    if (isRecord(value.value) && value.value.kind === 'encrypted-json') {
        validateEncryptedJsonEnvelope(
            value.value,
            `${path}.value`,
            'snapshot-body',
            issues,
        );
    }
    validateSnapshotMetadata(value.metadata, `${path}.metadata`, issues);

    if (typeof value.hash === 'string' && issues.length === 0) {
        const expected = hashRallarCrdtSnapshotEnvelope(
            value as RallarCrdtSnapshotEnvelope,
        );
        if (value.hash !== expected) {
            issues.push({
                path: `${path}.hash`,
                code: 'hash-mismatch',
                message:
                    'CRDT snapshot hash does not match its canonical payload.',
            });
        }
    } else if (value.hash !== undefined) {
        issues.push({
            path: `${path}.hash`,
            code: 'invalid-hash',
            message: 'CRDT snapshot hash must be a string when present.',
        });
    }

    return failRallarCrdtValidation(issues);
}

export function validateRallarCrdtSyncRequestEnvelope(
    value: unknown,
    path = '$',
    options: RallarCrdtValidationOptions = {},
): RallarCrdtValidationResult {
    const issues: RallarCrdtValidationIssue[] = [];

    if (!isRecord(value)) {
        return failRallarCrdtValidation([
            {
                path,
                code: 'invalid-sync-request-envelope',
                message: 'CRDT sync request envelope must be an object.',
            },
        ]);
    }

    requireExactNumber(
        value.protocolVersion,
        RALLAR_CRDT_PROTOCOL_VERSION,
        `${path}.protocolVersion`,
        'unknown-protocol-version',
        issues,
    );
    issues.push(
        ...validateRallarCrdtDocumentRef(
            value.document,
            `${path}.document`,
            options,
        ).issues,
    );
    requireNonEmptyString(value.requestId, `${path}.requestId`, issues);
    requireNonEmptyString(value.replicaId, `${path}.replicaId`, issues);
    requireNonNegativeInteger(
        value.createdAtEpochMs,
        `${path}.createdAtEpochMs`,
        issues,
    );
    validateStringArray(value.knownUpdateIds, `${path}.knownUpdateIds`, issues);
    if (value.missingUpdateIds !== undefined) {
        validateStringArray(
            value.missingUpdateIds,
            `${path}.missingUpdateIds`,
            issues,
        );
    }
    if (value.maxUpdateCount !== undefined) {
        requireNonNegativeInteger(
            value.maxUpdateCount,
            `${path}.maxUpdateCount`,
            issues,
        );
    }

    return failRallarCrdtValidation(issues);
}

export function validateRallarCrdtSyncResponseEnvelope(
    value: unknown,
    path = '$',
    options: RallarCrdtValidationOptions = {},
): RallarCrdtValidationResult {
    const issues: RallarCrdtValidationIssue[] = [];

    if (!isRecord(value)) {
        return failRallarCrdtValidation([
            {
                path,
                code: 'invalid-sync-response-envelope',
                message: 'CRDT sync response envelope must be an object.',
            },
        ]);
    }

    requireExactNumber(
        value.protocolVersion,
        RALLAR_CRDT_PROTOCOL_VERSION,
        `${path}.protocolVersion`,
        'unknown-protocol-version',
        issues,
    );
    issues.push(
        ...validateRallarCrdtDocumentRef(
            value.document,
            `${path}.document`,
            options,
        ).issues,
    );
    requireNonEmptyString(value.requestId, `${path}.requestId`, issues);
    requireNonEmptyString(value.responseId, `${path}.responseId`, issues);
    requireNonEmptyString(value.replicaId, `${path}.replicaId`, issues);
    requireNonNegativeInteger(
        value.createdAtEpochMs,
        `${path}.createdAtEpochMs`,
        issues,
    );
    if (value.snapshot !== undefined) {
        issues.push(
            ...validateRallarCrdtSnapshotEnvelope(
                value.snapshot,
                `${path}.snapshot`,
                options,
            ).issues,
        );
    }
    if (!Array.isArray(value.updates)) {
        issues.push({
            path: `${path}.updates`,
            code: 'invalid-sync-response-updates',
            message: 'CRDT sync response updates must be an array.',
        });
    } else {
        value.updates.forEach((update, index) => {
            issues.push(
                ...validateRallarCrdtUpdateEnvelope(
                    update,
                    `${path}.updates[${index}]`,
                    options,
                ).issues,
            );
        });
    }
    if (value.hasMore !== undefined && typeof value.hasMore !== 'boolean') {
        issues.push({
            path: `${path}.hasMore`,
            code: 'invalid-has-more',
            message: 'CRDT sync response hasMore must be boolean when present.',
        });
    }
    requireOptionalNonEmptyString(value.reason, `${path}.reason`, issues);

    return failRallarCrdtValidation(issues);
}

export function assertValidRallarCrdtUpdateEnvelope(
    value: unknown,
    options: RallarCrdtValidationOptions = {},
): asserts value is RallarCrdtUpdateEnvelope {
    const result = validateRallarCrdtUpdateEnvelope(value, '$', options);
    if (!result.valid) {
        throw new Error(formatRallarCrdtValidation(result));
    }
}

export function assertValidRallarCrdtSnapshotEnvelope(
    value: unknown,
    options: RallarCrdtValidationOptions = {},
): asserts value is RallarCrdtSnapshotEnvelope {
    const result = validateRallarCrdtSnapshotEnvelope(value, '$', options);
    if (!result.valid) {
        throw new Error(formatRallarCrdtValidation(result));
    }
}

export function assertValidRallarCrdtSyncRequestEnvelope(
    value: unknown,
    options: RallarCrdtValidationOptions = {},
): asserts value is RallarCrdtSyncRequestEnvelope {
    const result = validateRallarCrdtSyncRequestEnvelope(value, '$', options);
    if (!result.valid) {
        throw new Error(formatRallarCrdtValidation(result));
    }
}

export function assertValidRallarCrdtSyncResponseEnvelope(
    value: unknown,
    options: RallarCrdtValidationOptions = {},
): asserts value is RallarCrdtSyncResponseEnvelope {
    const result = validateRallarCrdtSyncResponseEnvelope(value, '$', options);
    if (!result.valid) {
        throw new Error(formatRallarCrdtValidation(result));
    }
}

export function isRallarCrdtUpdateEnvelope(
    value: unknown,
    options: RallarCrdtValidationOptions = {},
): value is RallarCrdtUpdateEnvelope {
    return validateRallarCrdtUpdateEnvelope(value, '$', options).valid;
}

export function isRallarCrdtSnapshotEnvelope(
    value: unknown,
    options: RallarCrdtValidationOptions = {},
): value is RallarCrdtSnapshotEnvelope {
    return validateRallarCrdtSnapshotEnvelope(value, '$', options).valid;
}

export function isRallarCrdtSyncRequestEnvelope(
    value: unknown,
    options: RallarCrdtValidationOptions = {},
): value is RallarCrdtSyncRequestEnvelope {
    return validateRallarCrdtSyncRequestEnvelope(value, '$', options).valid;
}

export function isRallarCrdtSyncResponseEnvelope(
    value: unknown,
    options: RallarCrdtValidationOptions = {},
): value is RallarCrdtSyncResponseEnvelope {
    return validateRallarCrdtSyncResponseEnvelope(value, '$', options).valid;
}

export function encodeRallarCrdtUpdateEnvelope(
    envelope: RallarCrdtUpdateEnvelope,
): string {
    assertValidRallarCrdtUpdateEnvelope(envelope);
    return JSON.stringify(envelope);
}

export function decodeRallarCrdtUpdateEnvelope(
    encoded: string,
    options: RallarCrdtValidationOptions = {},
): RallarCrdtUpdateEnvelope {
    const parsed = JSON.parse(encoded) as unknown;
    assertValidRallarCrdtUpdateEnvelope(parsed, options);
    return parsed;
}

export function formatRallarCrdtValidation(
    result: RallarCrdtValidationResult,
): string {
    if (result.valid) {
        return 'CRDT payload is valid.';
    }

    return result.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('\n');
}

function validateRoomDocumentRef(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (!isRecord(value.roomRef)) {
        issues.push({
            path: `${path}.roomRef`,
            code: 'missing-room-ref',
            message: 'Room-scoped CRDT documents require roomRef.',
        });
        return;
    }

    const roomRef = value.roomRef;
    requireNonEmptyString(
        roomRef.applicationId,
        `${path}.roomRef.applicationId`,
        issues,
    );
    requireOptionalNonEmptyString(
        roomRef.workspaceId,
        `${path}.roomRef.workspaceId`,
        issues,
    );
    requireNonEmptyString(roomRef.groupId, `${path}.roomRef.groupId`, issues);

    if (
        typeof value.applicationId === 'string' &&
        typeof roomRef.applicationId === 'string' &&
        value.applicationId !== roomRef.applicationId
    ) {
        issues.push({
            path: `${path}.roomRef.applicationId`,
            code: 'room-application-mismatch',
            message:
                'Room ref applicationId must match document applicationId.',
        });
    }

    if (
        typeof value.workspaceId === 'string' &&
        typeof roomRef.workspaceId === 'string' &&
        value.workspaceId !== roomRef.workspaceId
    ) {
        issues.push({
            path: `${path}.roomRef.workspaceId`,
            code: 'room-workspace-mismatch',
            message: 'Room ref workspaceId must match document workspaceId.',
        });
    }
}

function validateOrSetAddOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtOrSetAddOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireNonEmptyString(value.elementId, `${path}.elementId`, issues);
    requireMaxStringLength(
        value.elementId,
        `${path}.elementId`,
        options.maxElementIdLength,
        'element-id-too-large',
        'CRDT elementId',
        issues,
    );
    issues.push(...validateRallarCrdtJsonValue(value.value, `${path}.value`));
}

function validateOrSetRemoveOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtOrSetRemoveOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireNonEmptyString(value.elementId, `${path}.elementId`, issues);
    requireMaxStringLength(
        value.elementId,
        `${path}.elementId`,
        options.maxElementIdLength,
        'element-id-too-large',
        'CRDT elementId',
        issues,
    );
    validateStringArray(
        value.observedAddUpdateIds,
        `${path}.observedAddUpdateIds`,
        issues,
    );
}

function validateRegisterSetOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtRegisterSetOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    if (value.policy !== 'lww' && value.policy !== 'multi') {
        issues.push({
            path: `${path}.policy`,
            code: 'invalid-register-policy',
            message: 'CRDT register policy must be lww or multi.',
        });
    }
    issues.push(...validateRallarCrdtJsonValue(value.value, `${path}.value`));
}

function validateMapSetOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtMapSetOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireNonEmptyString(value.key, `${path}.key`, issues);
    requireMaxStringLength(
        value.key,
        `${path}.key`,
        options.maxKeyLength,
        'key-too-large',
        'CRDT map key',
        issues,
    );
    issues.push(...validateRallarCrdtJsonValue(value.value, `${path}.value`));
}

function validateMapDeleteOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtMapDeleteOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireNonEmptyString(value.key, `${path}.key`, issues);
    requireMaxStringLength(
        value.key,
        `${path}.key`,
        options.maxKeyLength,
        'key-too-large',
        'CRDT map key',
        issues,
    );
    validateStringArray(
        value.observedUpdateIds,
        `${path}.observedUpdateIds`,
        issues,
    );
}

function validateSequenceInsertOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtSequenceInsertOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireNonEmptyString(value.elementId, `${path}.elementId`, issues);
    requireMaxStringLength(
        value.elementId,
        `${path}.elementId`,
        options.maxElementIdLength,
        'element-id-too-large',
        'CRDT elementId',
        issues,
    );
    requireNonEmptyString(value.positionId, `${path}.positionId`, issues);
    requireMaxStringLength(
        value.positionId,
        `${path}.positionId`,
        options.maxElementIdLength,
        'position-id-too-large',
        'CRDT positionId',
        issues,
    );
    issues.push(...validateRallarCrdtJsonValue(value.value, `${path}.value`));
}

function validateSequenceDeleteOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtSequenceDeleteOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireNonEmptyString(value.elementId, `${path}.elementId`, issues);
    requireMaxStringLength(
        value.elementId,
        `${path}.elementId`,
        options.maxElementIdLength,
        'element-id-too-large',
        'CRDT elementId',
        issues,
    );
    validateStringArray(
        value.observedUpdateIds,
        `${path}.observedUpdateIds`,
        issues,
    );
}

function validateSequenceMoveOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtSequenceMoveOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireNonEmptyString(value.elementId, `${path}.elementId`, issues);
    requireMaxStringLength(
        value.elementId,
        `${path}.elementId`,
        options.maxElementIdLength,
        'element-id-too-large',
        'CRDT elementId',
        issues,
    );
    requireNonEmptyString(value.positionId, `${path}.positionId`, issues);
    requireMaxStringLength(
        value.positionId,
        `${path}.positionId`,
        options.maxElementIdLength,
        'position-id-too-large',
        'CRDT positionId',
        issues,
    );
    validateStringArray(
        value.observedUpdateIds,
        `${path}.observedUpdateIds`,
        issues,
    );
}

function validateCounterAddOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtCounterAddOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireFiniteNumber(value.delta, `${path}.delta`, issues);
}

function validateNumberMinOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtNumberMinOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireFiniteNumber(value.value, `${path}.value`, issues);
}

function validateNumberMaxOperation(
    value: Record<string, unknown>,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions,
): asserts value is RallarCrdtNumberMaxOperation {
    validatePath(value.path, `${path}.path`, issues, options);
    requireFiniteNumber(value.value, `${path}.value`, issues);
}

function validateUndoRedoMetadata(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (!isRecord(value)) {
        issues.push({
            path,
            code: 'invalid-undo-redo-metadata',
            message: 'CRDT undo/redo metadata must be an object.',
        });
        return;
    }
    requireNonEmptyString(value.actorId, `${path}.actorId`, issues);
    requireNonEmptyString(
        value.targetOperationGroupId,
        `${path}.targetOperationGroupId`,
        issues,
    );
    validateStringArray(
        value.targetUpdateIds,
        `${path}.targetUpdateIds`,
        issues,
    );
}

function validateEncryptedJsonEnvelope(
    value: unknown,
    path: string,
    plaintextType: RallarCrdtEncryptedJsonEnvelope['plaintextType'],
    issues: RallarCrdtValidationIssue[],
): void {
    if (!isRecord(value)) {
        issues.push({
            path,
            code: 'invalid-encrypted-json',
            message: 'CRDT encrypted JSON envelope must be an object.',
        });
        return;
    }

    if (value.kind !== 'encrypted-json') {
        issues.push({
            path: `${path}.kind`,
            code: 'invalid-encrypted-json-kind',
            message:
                'CRDT encrypted JSON envelope kind must be encrypted-json.',
        });
    }
    if (value.format !== 'rallar.crdt.encrypted-json.v1') {
        issues.push({
            path: `${path}.format`,
            code: 'invalid-encrypted-json-format',
            message:
                'CRDT encrypted JSON envelope format must be rallar.crdt.encrypted-json.v1.',
        });
    }
    if (value.algorithm !== 'AES-GCM-256') {
        issues.push({
            path: `${path}.algorithm`,
            code: 'invalid-encryption-algorithm',
            message: 'CRDT encrypted JSON algorithm must be AES-GCM-256.',
        });
    }
    if (value.plaintextType !== plaintextType) {
        issues.push({
            path: `${path}.plaintextType`,
            code: 'invalid-encrypted-plaintext-type',
            message: `CRDT encrypted JSON plaintextType must be ${plaintextType}.`,
        });
    }
    requireNonEmptyString(value.keyId, `${path}.keyId`, issues);
    requireNonEmptyString(value.nonce, `${path}.nonce`, issues);
    requireNonEmptyString(value.ciphertext, `${path}.ciphertext`, issues);
    requireNonEmptyString(value.plaintextHash, `${path}.plaintextHash`, issues);
    requireNonEmptyString(value.aadHash, `${path}.aadHash`, issues);
    requireNonNegativeInteger(
        value.encryptedAtEpochMs,
        `${path}.encryptedAtEpochMs`,
        issues,
    );
    if (value.visibleMetadataFields !== undefined) {
        validateStringArray(
            value.visibleMetadataFields,
            `${path}.visibleMetadataFields`,
            issues,
        );
    }
}

function validatePath(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
    options: RallarCrdtValidationOptions = {},
): asserts value is RallarCrdtPath {
    if (!Array.isArray(value)) {
        issues.push({
            path,
            code: 'invalid-path',
            message: 'CRDT operation path must be an array of strings.',
        });
        return;
    }

    if (
        options.maxPathDepth !== undefined &&
        value.length > options.maxPathDepth
    ) {
        issues.push({
            path,
            code: 'path-too-deep',
            message: `CRDT operation path exceeds ${options.maxPathDepth} segments.`,
        });
    }

    value.forEach((entry, index) => {
        if (typeof entry !== 'string' || entry.length === 0) {
            issues.push({
                path: `${path}[${index}]`,
                code: 'invalid-path-segment',
                message:
                    'CRDT operation path segments must be non-empty strings.',
            });
        } else if (
            options.maxPathSegmentLength !== undefined &&
            entry.length > options.maxPathSegmentLength
        ) {
            issues.push({
                path: `${path}[${index}]`,
                code: 'path-segment-too-large',
                message: `CRDT operation path segment exceeds ${options.maxPathSegmentLength} characters.`,
            });
        }
    });
}

function validateStringArray(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): asserts value is readonly string[] {
    if (!Array.isArray(value)) {
        issues.push({
            path,
            code: 'invalid-string-array',
            message: 'Expected an array of strings.',
        });
        return;
    }

    value.forEach((entry, index) =>
        requireNonEmptyString(entry, `${path}[${index}]`, issues),
    );
}

function validateSnapshotMetadata(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (!isRecord(value)) {
        issues.push({
            path,
            code: 'invalid-snapshot-metadata',
            message: 'CRDT snapshot metadata must be an object.',
        });
        return;
    }

    requireOptionalNonEmptyString(
        value.createdByReplicaId,
        `${path}.createdByReplicaId`,
        issues,
    );
    requireNonNegativeInteger(value.updateCount, `${path}.updateCount`, issues);
    requireOptionalNonNegativeInteger(
        value.tombstoneCount,
        `${path}.tombstoneCount`,
        issues,
    );
    requireOptionalNonNegativeInteger(
        value.conflictCount,
        `${path}.conflictCount`,
        issues,
    );
    requireOptionalNonEmptyString(value.reason, `${path}.reason`, issues);
    if (value.crdtState !== undefined) {
        validateCrdtStateSnapshot(value.crdtState, `${path}.crdtState`, issues);
    }
}

function validateCausalFrontier(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (!isRecord(value)) {
        issues.push({
            path,
            code: 'invalid-causal-frontier',
            message: 'CRDT causalFrontier must be an object.',
        });
        return;
    }
    validateStringArray(
        value.frontierUpdateIds,
        `${path}.frontierUpdateIds`,
        issues,
    );
    if (value.replicaClocks !== undefined && !isRecord(value.replicaClocks)) {
        issues.push({
            path: `${path}.replicaClocks`,
            code: 'invalid-replica-clocks',
            message: 'CRDT causalFrontier replicaClocks must be an object.',
        });
    } else if (isRecord(value.replicaClocks)) {
        for (const [replicaId, lamport] of Object.entries(
            value.replicaClocks,
        )) {
            requireNonEmptyString(
                replicaId,
                `${path}.replicaClocks.${replicaId}.replicaId`,
                issues,
            );
            requireNonNegativeInteger(
                lamport,
                `${path}.replicaClocks.${replicaId}`,
                issues,
            );
        }
    }
}

function validateCrdtStateSnapshot(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (!isRecord(value)) {
        issues.push({
            path,
            code: 'invalid-crdt-state',
            message: 'CRDT snapshot state sidecar must be an object.',
        });
        return;
    }
    if (value.format !== 'rallar.crdt.state.v1') {
        issues.push({
            path: `${path}.format`,
            code: 'invalid-crdt-state-format',
            message:
                'CRDT snapshot state sidecar format must be rallar.crdt.state.v1.',
        });
    }
    for (const key of ['registers', 'sets', 'maps', 'sequences']) {
        if (!isRecord(value[key])) {
            issues.push({
                path: `${path}.${key}`,
                code: 'invalid-crdt-state-section',
                message: `CRDT snapshot state ${key} must be an object.`,
            });
        }
    }
    for (const key of ['counters', 'numbers']) {
        if (value[key] !== undefined && !isRecord(value[key])) {
            issues.push({
                path: `${path}.${key}`,
                code: 'invalid-crdt-state-section',
                message: `CRDT snapshot state ${key} must be an object when present.`,
            });
        }
    }
}

function validateOperationPathOwnership(
    operation: RallarCrdtOperation,
    path: string,
    options: RallarCrdtValidationOptions,
    issues: RallarCrdtValidationIssue[],
): void {
    const schema = options.pathSchema;
    if (!schema || schema.mode !== 'strict') {
        return;
    }

    const declaredPathKeys = new Set<string>();
    for (const [index, entry] of schema.paths.entries()) {
        const entryPath = `${path}.pathSchema.paths[${index}]`;
        if (
            entry.kind !== 'register' &&
            entry.kind !== 'map' &&
            entry.kind !== 'orset' &&
            entry.kind !== 'sequence' &&
            entry.kind !== 'counter' &&
            entry.kind !== 'number'
        ) {
            issues.push({
                path: `${entryPath}.kind`,
                code: 'invalid-path-kind',
                message:
                    'CRDT strict path schema kind must be register, map, orset, sequence, counter, or number.',
            });
        }
        if (!Array.isArray(entry.path)) {
            issues.push({
                path: `${entryPath}.path`,
                code: 'invalid-path',
                message: 'CRDT strict path schema path must be an array.',
            });
            continue;
        }
        const pathKey = toPathKey(entry.path);
        if (declaredPathKeys.has(pathKey)) {
            issues.push({
                path: `${entryPath}.path`,
                code: 'duplicate-path-owner',
                message:
                    'CRDT strict path schema declares the same path twice.',
            });
        }
        declaredPathKeys.add(pathKey);
    }

    const requiredKind = operationPathKind(operation.kind);
    const exact = schema.paths.find(
        (entry) => toPathKey(entry.path) === toPathKey(operation.path),
    );
    if (!exact) {
        issues.push({
            path: `${path}.path`,
            code: 'crdt-path-not-declared',
            message:
                'CRDT operation path is not declared in the strict path schema.',
        });
        return;
    }
    if (exact.kind !== requiredKind) {
        issues.push({
            path: `${path}.path`,
            code: 'crdt-path-kind-mismatch',
            message: `CRDT operation requires a ${requiredKind} path but schema declares ${exact.kind}.`,
        });
    }

    for (const entry of schema.paths) {
        if (
            toPathKey(entry.path) !== toPathKey(exact.path) &&
            pathsOverlap(entry.path, exact.path)
        ) {
            issues.push({
                path: `${path}.path`,
                code: 'overlapping-path-owner',
                message:
                    'CRDT strict path schema must not declare overlapping parent/child paths.',
            });
            return;
        }
    }
}

function operationPathKind(kind: RallarCrdtOperationKind): RallarCrdtPathKind {
    switch (kind) {
        case 'register.set':
            return 'register';
        case 'map.set':
        case 'map.delete':
            return 'map';
        case 'orset.add':
        case 'orset.remove':
            return 'orset';
        case 'sequence.insert':
        case 'sequence.delete':
        case 'sequence.move':
            return 'sequence';
        case 'counter.add':
            return 'counter';
        case 'number.min':
        case 'number.max':
            return 'number';
    }
}

function pathsOverlap(left: RallarCrdtPath, right: RallarCrdtPath): boolean {
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length <= right.length ? right : left;
    return shorter.every((segment, index) => longer[index] === segment);
}

function toPathKey(path: RallarCrdtPath): string {
    return JSON.stringify(path);
}

function requireExactNumber(
    value: unknown,
    expected: number,
    path: string,
    code: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (value !== expected) {
        issues.push({
            path,
            code,
            message: `Expected ${expected}.`,
        });
    }
}

function requireAllowedVersion(
    value: unknown,
    allowed: readonly number[] | undefined,
    path: string,
    code: string,
    issues: RallarCrdtValidationIssue[],
): void {
    requireNonNegativeInteger(value, path, issues);
    if (
        allowed &&
        typeof value === 'number' &&
        Number.isInteger(value) &&
        !allowed.includes(value)
    ) {
        issues.push({
            path,
            code,
            message: `Version is not supported: ${value}.`,
        });
    }
}

function requireNonNegativeInteger(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (!Number.isInteger(value) || (value as number) < 0) {
        issues.push({
            path,
            code: 'invalid-non-negative-integer',
            message: 'Expected a non-negative integer.',
        });
    }
}

function requireFiniteNumber(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({
            path,
            code: 'invalid-finite-number',
            message: 'Expected a finite number.',
        });
    }
}

function requireOptionalNonNegativeInteger(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (value !== undefined) {
        requireNonNegativeInteger(value, path, issues);
    }
}

function requireNonEmptyString(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
        issues.push({
            path,
            code: 'invalid-non-empty-string',
            message: 'Expected a non-empty string.',
        });
    }
}

function requireMaxStringLength(
    value: unknown,
    path: string,
    maxLength: number | undefined,
    code: string,
    label: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (
        maxLength !== undefined &&
        typeof value === 'string' &&
        value.length > maxLength
    ) {
        issues.push({
            path,
            code,
            message: `${label} exceeds ${maxLength} characters.`,
        });
    }
}

function requireOptionalNonEmptyString(
    value: unknown,
    path: string,
    issues: RallarCrdtValidationIssue[],
): void {
    if (value !== undefined) {
        requireNonEmptyString(value, path, issues);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isRallarCrdtOperationBatch(
    value: unknown,
): value is RallarCrdtOperationBatch {
    return validateRallarCrdtOperationBatch(value).valid;
}

export function isRallarCrdtOperation(
    value: unknown,
): value is RallarCrdtOperation {
    return validateRallarCrdtOperation(value).valid;
}

export function isRallarCrdtDocumentRef(
    value: unknown,
): value is RallarCrdtDocumentRef {
    return validateRallarCrdtDocumentRef(value).valid;
}
