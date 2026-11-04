import type { ALMessage } from '../al-contracts/al-contract.ts';
import { AppTopics } from './api-config.ts';
import { requireExactKeys, requireOneOf, requireRecord, requireString } from './exact-object-decoding.ts';
import { decodeStateScope, type StateScope } from './state-types.ts';

export interface ViewInvalidation {
    readonly version: 1;
    readonly resource: 'party' | 'matchmaking';
    readonly scope: StateScope;
    readonly principalId: string;
    readonly changeId: string;
}

/** A hint to read authority again, never a replacement snapshot or permission to access a resource. */
export function decodeViewInvalidation(value: unknown): ViewInvalidation {
    const record = requireRecord(value, 'View invalidation');
    requireExactKeys(record, ['version', 'resource', 'scope', 'principalId', 'changeId'], 'View invalidation');
    if (record.version !== 1) {
        throw new TypeError('Unsupported view invalidation version');
    }
    requireString(record.principalId, 'View principal');
    requireString(record.changeId, 'View change identity');
    return {
        version: 1,
        resource: requireOneOf(record.resource, ['party', 'matchmaking'], 'View resource'),
        scope: decodeStateScope(record.scope),
        principalId: record.principalId,
        changeId: record.changeId
    };
}

export interface ViewResync {
    readonly version: 1;
}

export function decodeViewResync(value: unknown): ViewResync {
    const record = requireRecord(value, 'View resync');
    requireExactKeys(record, ['version'], 'View resync');
    if (record.version !== 1) {
        throw new TypeError('Unsupported view resync version');
    }
    return { version: 1 };
}

/** Validates both the untrusted payload and the exact own-account transport target. */
export function decodeViewInvalidationMessage(message: ALMessage): ViewInvalidation {
    if (message.route.topicId !== AppTopics.viewInvalidated || message.payload.typeId !== AppTopics.viewInvalidated) {
        throw new TypeError('View invalidation topic and type differ');
    }
    const targets = requireRecord(message.targets, 'View targets');
    requireExactKeys(targets, ['mode', 'scope', 'principalRef'], 'View targets');
    const principalRef = requireRecord(targets.principalRef, 'View target principal');
    requireExactKeys(principalRef, ['applicationId', 'workspaceId', 'principalId'], 'View target principal');
    const notice = decodeViewInvalidation(JSON.parse(message.payload.resource));
    if (
        targets.mode !== 'broadcast' || targets.scope !== 'principal' ||
        principalRef.applicationId !== notice.scope.applicationId ||
        principalRef.workspaceId !== notice.scope.workspaceId ||
        principalRef.principalId !== notice.principalId
    ) {
        throw new TypeError('View invalidation differs from its exact account target');
    }
    return notice;
}
