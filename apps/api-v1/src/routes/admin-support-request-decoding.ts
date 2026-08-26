import { decodeExactDocumentRef } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-document-ref.ts';
import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type {
    AdminSupportExplainClientRequest,
    AdminSupportExplainCrdtDocumentRequest,
    AdminSupportExplainGroupRequest,
    AdminSupportExplainQueueItemRequest,
    AdminSupportExplainRequestRequest,
    AdminSupportJsonObject
} from '@shared/api/admin-support/admin-support-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

export function decodeAdminSupportExplainClientRequest(
    value: JsonWireValue
): AdminSupportExplainClientRequest {
    const request = requireObject(value, 'Admin support client request');
    requireExactKeys(
        request,
        ['scope', 'principalId', 'clientInstanceId', 'sessionId', 'limitRecentEvents'],
        'Admin support client request'
    );
    return {
        scope: decodeStateScope(request.scope),
        principalId: requireNonEmptyString(
            request.principalId,
            'Admin support principalId'
        ),
        clientInstanceId: readOptionalNonEmptyString(
            request.clientInstanceId,
            'Admin support clientInstanceId'
        ),
        sessionId: readOptionalNonEmptyString(
            request.sessionId,
            'Admin support sessionId'
        ),
        limitRecentEvents: readOptionalRecentEventLimit(request.limitRecentEvents)
    };
}

export function decodeAdminSupportExplainGroupRequest(
    value: JsonWireValue
): AdminSupportExplainGroupRequest {
    const request = requireObject(value, 'Admin support group request');
    requireExactKeys(
        request,
        ['groupRef', 'principalId', 'sessionId', 'limitRecentEvents'],
        'Admin support group request'
    );
    return {
        groupRef: decodeGroupRef(request.groupRef),
        principalId: readOptionalNonEmptyString(
            request.principalId,
            'Admin support principalId'
        ),
        sessionId: readOptionalNonEmptyString(
            request.sessionId,
            'Admin support sessionId'
        ),
        limitRecentEvents: readOptionalRecentEventLimit(request.limitRecentEvents)
    };
}

export function decodeAdminSupportExplainRequestRequest(
    value: JsonWireValue
): AdminSupportExplainRequestRequest {
    const request = requireObject(value, 'Admin support request explanation');
    requireExactKeys(
        request,
        ['requestId', 'idempotencyKey', 'queueKey', 'target'],
        'Admin support request explanation'
    );
    return {
        requestId: readOptionalNonEmptyString(request.requestId, 'Admin support requestId'),
        idempotencyKey: readOptionalNonEmptyString(
            request.idempotencyKey,
            'Admin support idempotencyKey'
        ),
        queueKey: request.queueKey === undefined
            ? undefined
            : decodeQueueKey(request.queueKey),
        target: request.target === undefined
            ? undefined
            : toAdminSupportJsonObject(request.target)
    };
}

export function decodeAdminSupportExplainCrdtDocumentRequest(
    value: JsonWireValue
): AdminSupportExplainCrdtDocumentRequest {
    const request = requireObject(value, 'Admin support CRDT document request');
    requireExactKeys(
        request,
        ['document', 'includeIntegrity', 'includeRedactedDebugBundle'],
        'Admin support CRDT document request'
    );
    return {
        document: decodeExactDocumentRef(
            request.document,
            'Admin support CRDT document'
        ),
        includeIntegrity: readOptionalBoolean(
            request.includeIntegrity,
            'Admin support includeIntegrity'
        ),
        includeRedactedDebugBundle: readOptionalBoolean(
            request.includeRedactedDebugBundle,
            'Admin support includeRedactedDebugBundle'
        )
    };
}

export function decodeAdminSupportExplainQueueItemRequest(
    value: JsonWireValue
): AdminSupportExplainQueueItemRequest {
    const request = requireObject(value, 'Admin support queue item request');
    requireExactKeys(
        request,
        ['queueKey', 'includeExpired'],
        'Admin support queue item request'
    );
    return {
        queueKey: decodeQueueKey(request.queueKey),
        includeExpired: readOptionalBoolean(
            request.includeExpired,
            'Admin support includeExpired'
        )
    };
}

function decodeStateScope(value: JsonWireValue | undefined): StateScope {
    const scope = requireObject(value, 'Admin support scope');
    requireExactKeys(scope, ['applicationId', 'workspaceId'], 'Admin support scope');
    return {
        applicationId: requireNonEmptyString(
            scope.applicationId,
            'Admin support scope.applicationId'
        ),
        workspaceId: requireNonEmptyString(
            scope.workspaceId,
            'Admin support scope.workspaceId'
        )
    };
}

function decodeGroupRef(value: JsonWireValue | undefined): GroupRef {
    const groupRef = requireObject(value, 'Admin support groupRef');
    requireExactKeys(
        groupRef,
        ['applicationId', 'workspaceId', 'groupId'],
        'Admin support groupRef'
    );
    return {
        applicationId: requireNonEmptyString(
            groupRef.applicationId,
            'Admin support groupRef.applicationId'
        ),
        workspaceId: requireNonEmptyString(
            groupRef.workspaceId,
            'Admin support groupRef.workspaceId'
        ),
        groupId: requireNonEmptyString(
            groupRef.groupId,
            'Admin support groupRef.groupId'
        )
    };
}

function decodeQueueKey(value: JsonWireValue | undefined): Key {
    const queueKey = requireObject(value, 'Admin support queueKey');
    requireExactKeys(
        queueKey,
        ['topicId', 'resourceId', 'contextId'],
        'Admin support queueKey'
    );
    return {
        topicId: requireNonEmptyString(
            queueKey.topicId,
            'Admin support queueKey.topicId'
        ),
        resourceId: requireNonEmptyString(
            queueKey.resourceId,
            'Admin support queueKey.resourceId'
        ),
        contextId: requireNonEmptyString(
            queueKey.contextId,
            'Admin support queueKey.contextId'
        )
    };
}

function requireObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value as JsonWireObject;
}

function toAdminSupportJsonObject(value: JsonWireValue): AdminSupportJsonObject {
    return requireObject(value, 'Admin support target') as AdminSupportJsonObject;
}

function requireExactKeys(
    value: JsonWireObject,
    expectedKeys: readonly string[],
    label: string
): void {
    const expected = new Set(expectedKeys);
    const unexpected = Object.keys(value).find((key) => !expected.has(key));
    if (unexpected !== undefined) {
        throw new TypeError(`${label} contains unexpected field ${unexpected}.`);
    }
}

function requireNonEmptyString(
    value: JsonWireValue | undefined,
    label: string
): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    return value;
}

function readOptionalNonEmptyString(
    value: JsonWireValue | undefined,
    label: string
): string | undefined {
    return value === undefined ? undefined : requireNonEmptyString(value, label);
}

function readOptionalBoolean(
    value: JsonWireValue | undefined,
    label: string
): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new TypeError(`${label} must be a boolean.`);
    }
    return value;
}

function readOptionalRecentEventLimit(
    value: JsonWireValue | undefined
): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) {
        throw new TypeError('Admin support limitRecentEvents must be an integer from 1 to 50.');
    }
    return value;
}
