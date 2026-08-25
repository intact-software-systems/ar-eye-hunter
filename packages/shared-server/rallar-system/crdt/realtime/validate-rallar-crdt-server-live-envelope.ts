import type { GroupRef } from '@shared/api/group-types.ts';
import {
    validateRallarCrdtSyncRequestEnvelope,
    validateRallarCrdtSyncResponseEnvelope,
    validateRallarCrdtUpdateEnvelope,
    type RallarCrdtDocumentRef,
    type RallarCrdtValidationIssue,
    type RallarCrdtValidationOptions,
    type RallarCrdtValidationResult
} from '@shared/crdt/mod.ts';

import type {
    RallarCrdtServerEnvelopeKind,
    RallarCrdtServerLiveValidationContext,
    RallarCrdtServerTopicBridgeOptions,
    RallarCrdtServerTopicScope
} from './rallar-crdt-server-contracts.ts';
import {
    validateRallarCrdtCatchUpRequestEnvelope,
    validateRallarCrdtCatchUpResponseEnvelope
} from './validate-rallar-crdt-catch-up-envelope.ts';

export interface ValidateRallarCrdtServerLiveEnvelopeInput {
    readonly kind: RallarCrdtServerEnvelopeKind;
    readonly topicScope: RallarCrdtServerTopicScope;
    readonly value: unknown;
    readonly context: RallarCrdtServerLiveValidationContext;
    readonly options?: RallarCrdtServerTopicBridgeOptions;
}

export function validateRallarCrdtServerLiveEnvelope(
    input: ValidateRallarCrdtServerLiveEnvelopeInput
): RallarCrdtValidationResult {
    const options = input.options ?? {};
    const base = validateEnvelopeByKind(input.kind, input.value, toSharedValidationOptions(options));
    const issues = [...base.issues];

    if (input.kind === 'update' && !options.mutationIngress) {
        issues.push({
            path: '$',
            code: 'mutation-ingress-required',
            message: 'CRDT updates require durable mutation ingress.'
        });
    }

    if (base.valid) {
        const document = input.value && typeof input.value === 'object'
            ? readEnvelopeDocument(input.value)
            : undefined;
        if (!document) {
            issues.push({
                path: '$.document',
                code: 'missing-document-ref',
                message: 'CRDT live envelope must contain a document ref.'
            });
        }
        else {
            issues.push(
                ...validateLiveDocumentScope({
                    document,
                    topicScope: input.topicScope,
                    context: input.context,
                    options
                })
            );
        }
    }

    issues.push(...validateKnownBinaryJsonShapes(input.value));

    return {
        valid: issues.length === 0,
        issues
    };
}

interface ValidateLiveDocumentScopeInput {
    readonly document: RallarCrdtDocumentRef;
    readonly topicScope: RallarCrdtServerTopicScope;
    readonly context: RallarCrdtServerLiveValidationContext;
    readonly options: RallarCrdtServerTopicBridgeOptions;
}

function validateLiveDocumentScope(
    input: ValidateLiveDocumentScopeInput
): readonly RallarCrdtValidationIssue[] {
    const issues: RallarCrdtValidationIssue[] = [];

    if (input.topicScope === 'room') {
        return validateRoomDocumentScope(input.document, input.context);
    }

    if (input.document.scope === 'app' && input.options.allowAppDocuments === true) {
        return issues;
    }

    if (
        input.document.scope === 'principal' &&
        input.options.allowPrincipalDocuments === true &&
        input.options.mutationIngress
    ) {
        return issues;
    }

    if (input.document.scope === 'principal') {
        issues.push({
            path: '$.document.scope',
            code: 'unsupported-live-document-scope',
            message: 'app.crdt principal live messages require durable AppInbox mutation ingress.'
        });
        return issues;
    }

    if (input.document.scope !== 'app' || input.options.allowAppDocuments !== true) {
        issues.push({
            path: '$.document.scope',
            code: 'unsupported-live-document-scope',
            message: 'app.crdt live messages only support explicitly enabled app-scoped documents.'
        });
    }

    return issues;
}

function validateRoomDocumentScope(
    document: RallarCrdtDocumentRef,
    context: RallarCrdtServerLiveValidationContext
): readonly RallarCrdtValidationIssue[] {
    const issues: RallarCrdtValidationIssue[] = [];
    if (document.scope !== 'room') {
        issues.push({
            path: '$.document.scope',
            code: 'unsupported-live-document-scope',
            message: 'room.crdt only supports room-scoped CRDT documents.'
        });
        return issues;
    }

    if (!context.roomRef) {
        issues.push({
            path: '$.document.roomRef',
            code: 'missing-message-room-ref',
            message: 'Room CRDT live messages must carry a scoped AL target groupRef.'
        });
        return issues;
    }

    if (!document.roomRef) {
        issues.push({
            path: '$.document.roomRef',
            code: 'missing-room-ref',
            message: 'Room-scoped CRDT documents require roomRef.'
        });
        return issues;
    }

    if (!sameGroupRef(document.roomRef, context.roomRef)) {
        issues.push({
            path: '$.document.roomRef',
            code: 'message-room-ref-mismatch',
            message: 'CRDT document roomRef must match the AL message target groupRef.'
        });
    }

    if (context.roomId !== undefined && context.roomId !== document.roomRef.groupId) {
        issues.push({
            path: '$.document.roomRef.groupId',
            code: 'message-room-id-mismatch',
            message: 'CRDT document room groupId must match the AL message room context.'
        });
    }

    return issues;
}

function validateEnvelopeByKind(
    kind: RallarCrdtServerEnvelopeKind,
    value: unknown,
    options: RallarCrdtValidationOptions
): RallarCrdtValidationResult {
    switch (kind) {
        case 'update':
            return validateRallarCrdtUpdateEnvelope(value, '$', options);
        case 'sync-request':
            return validateRallarCrdtSyncRequestEnvelope(value, '$', options);
        case 'sync-response':
            return validateRallarCrdtSyncResponseEnvelope(value, '$', options);
        case 'catch-up-request':
            return validateRallarCrdtCatchUpRequestEnvelope(value, '$', options);
        case 'catch-up-response':
            return validateRallarCrdtCatchUpResponseEnvelope(value, '$', options);
    }
}

function toSharedValidationOptions(
    options: RallarCrdtServerTopicBridgeOptions
): RallarCrdtValidationOptions {
    return {
        ...options.validation,
        ...(options.allowedDocumentTypes ? { allowedDocumentTypes: options.allowedDocumentTypes } : {}),
        ...(options.allowedSchemaVersions
            ? { allowedSchemaVersions: options.allowedSchemaVersions }
            : {}),
        ...(options.allowedOperationKinds
            ? { allowedOperationKinds: options.allowedOperationKinds }
            : {}),
        maxPayloadBytes: options.maxUpdateBytes ?? options.validation?.maxPayloadBytes
    };
}

function validateKnownBinaryJsonShapes(value: unknown): readonly RallarCrdtValidationIssue[] {
    const issues: RallarCrdtValidationIssue[] = [];
    if (value && typeof value === 'object') {
        validateKnownBinaryJsonShapesAt(value, '$', issues);
    }
    return issues;
}

function validateKnownBinaryJsonShapesAt(
    value: object,
    path: string,
    issues: RallarCrdtValidationIssue[]
): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            if (entry && typeof entry === 'object') {
                validateKnownBinaryJsonShapesAt(entry, `${path}[${index}]`, issues);
            }
        });
        return;
    }

    const type = Reflect.get(value, 'type');
    const data = Reflect.get(value, 'data');
    if (type === 'Buffer' && Array.isArray(data) && data.every((entry) => Number.isInteger(entry))) {
        issues.push({
            path,
            code: 'raw-binary-payload',
            message: 'CRDT live payloads must not include raw Buffer/Blob-like values.'
        });
        return;
    }

    Object.keys(value).forEach((key) => {
        const entry = Reflect.get(value, key);
        if (entry && typeof entry === 'object') {
            validateKnownBinaryJsonShapesAt(entry, `${path}.${key}`, issues);
        }
    });
}

function readEnvelopeDocument(value: object): RallarCrdtDocumentRef | undefined {
    const document = Reflect.get(value, 'document');
    return document && typeof document === 'object' ? (document as RallarCrdtDocumentRef) : undefined;
}

function sameGroupRef(left: GroupRef, right: GroupRef): boolean {
    return (
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId
    );
}
