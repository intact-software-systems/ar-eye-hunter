import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    decodeJsonWireText,
    type JsonWireObject,
    type JsonWireValue
} from '../protocol/json-wire-identity.ts';
import { AppInboxTypeUnavailableError, decodeAppInboxEnqueue } from './app-inbox-command-decoding.ts';
import { AppInboxType, type AppInboxEnqueueInput } from './app-inbox-contracts.ts';

interface ValidAppInboxCommandIdentity {
    readonly valid: true;
    readonly identity: Readonly<{
        operation: AppInboxType;
        operationSource: 'command';
    }>;
    readonly command: AppInboxEnqueueInput;
}

interface InvalidAppInboxCommandIdentity {
    readonly valid: false;
    readonly identity: Readonly<{
        operation: AppInboxUnavailableOperation;
        operationSource: 'corrupt' | 'unavailable';
    }>;
}

export type AppInboxCommandIdentityValidation =
    | ValidAppInboxCommandIdentity
    | InvalidAppInboxCommandIdentity;

type AppInboxUnavailableOperation =
    | 'APP_INBOX_CLIENT_OPERATION_UNAVAILABLE'
    | 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE'
    | 'APP_INBOX_OPERATION_UNAVAILABLE';

const APP_INBOX_CLIENT_TOPIC = 'app-inbox.client-state';
const APP_INBOX_GROUP_TOPIC = 'app-inbox.group-state';
const APP_INBOX_AUTH_TOPIC = 'app-inbox.auth-state';
const APP_INBOX_CRDT_TOPIC = 'app-inbox.crdt-state';
const APP_INBOX_ADMIN_TOPIC = 'app-inbox.admin-operations';
const APP_INBOX_OPERATIONS = new Set<string>(Object.values(AppInboxType));
const APP_INBOX_GROUP_OPERATIONS = new Set<AppInboxType>([
    ...Object.values(AppInboxType).filter((operation) => operation.startsWith('GROUP_')),
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    AppInboxType.TOPOLOGY_RECONFIGURE,
    AppInboxType.RTC_RTT_SUBMIT
]);
const APP_INBOX_OPERATION_SPECIFIC_TOPIC_BY_OPERATION: Readonly<Partial<Record<AppInboxType, string>>> = {
    [AppInboxType.CLIENT_EXPIRED_SESSIONS]: AppInboxType.CLIENT_EXPIRED_SESSIONS,
    [AppInboxType.AUTH_USER_REGISTER]: APP_INBOX_AUTH_TOPIC,
    [AppInboxType.AUTH_SESSION_ISSUE]: APP_INBOX_AUTH_TOPIC,
    [AppInboxType.AUTH_SESSION_LOGOUT]: APP_INBOX_AUTH_TOPIC,
    [AppInboxType.AUTH_WS_TICKET_ISSUE]: APP_INBOX_AUTH_TOPIC,
    [AppInboxType.AUTH_WS_TICKET_CONSUME]: APP_INBOX_AUTH_TOPIC,
    [AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE]: APP_INBOX_AUTH_TOPIC,
    [AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME]: APP_INBOX_AUTH_TOPIC,
    [AppInboxType.CRDT_UPDATE_APPEND]: APP_INBOX_CRDT_TOPIC,
    [AppInboxType.CRDT_PROJECTION_REBUILD]: APP_INBOX_CRDT_TOPIC,
    [AppInboxType.CRDT_SNAPSHOT_COMPACT]: APP_INBOX_CRDT_TOPIC,
    [AppInboxType.CRDT_LIFECYCLE_UPDATE]: APP_INBOX_CRDT_TOPIC,
    [AppInboxType.CRDT_ERASE]: APP_INBOX_CRDT_TOPIC,
    [AppInboxType.ADMIN_PRUNE_EXPIRED]: APP_INBOX_ADMIN_TOPIC
};

export class AppInboxCommandIdentityError extends Error {
    readonly code = 'app-inbox-malformed-command';
    readonly status = 400;

    readonly operationSource: 'corrupt' | 'unavailable';

    constructor(operationSource: 'corrupt' | 'unavailable') {
        super(
            operationSource === 'corrupt'
                ? 'App inbox command identity is corrupt'
                : 'App inbox command identity is unavailable'
        );
        this.operationSource = operationSource;
        this.name = 'AppInboxCommandIdentityError';
    }
}

export function validateAppInboxCommandIdentity(
    entry: ResourceEntry
): AppInboxCommandIdentityValidation {
    return validatePersistedAppInboxCommandIdentity({
        topicId: entry.key.topicId,
        resource: entry.resource
    });
}

export function validatePersistedAppInboxCommandIdentity(
    input: Readonly<{ topicId: string; resource: string; }>
): AppInboxCommandIdentityValidation {
    let outer: JsonWireValue;
    try {
        outer = decodeJsonWireText(input.resource, 'Persisted AppInbox queue entry');
    }
    catch {
        return toInvalidIdentity(input.topicId, 'corrupt');
    }
    if (
        !isJsonWireObject(outer) ||
        !isJsonWireObject(outer.payload) ||
        typeof outer.payload.typeId !== 'string' ||
        typeof outer.payload.resource !== 'string'
    ) {
        return toInvalidIdentity(input.topicId, 'corrupt');
    }
    const dispatchedOperation = outer.payload.typeId;

    let command: AppInboxEnqueueInput;
    try {
        command = decodeAppInboxEnqueue(
            decodeJsonWireText(outer.payload.resource, 'Persisted AppInbox command')
        );
    }
    catch (error) {
        return toInvalidIdentity(
            input.topicId,
            error instanceof AppInboxTypeUnavailableError ? 'unavailable' : 'corrupt'
        );
    }
    if (
        !isAppInboxType(dispatchedOperation) ||
        !isAppInboxType(command.type)
    ) {
        return toInvalidIdentity(input.topicId, 'unavailable');
    }
    if (
        dispatchedOperation !== command.type ||
        !isOperationForTopic(dispatchedOperation, input.topicId)
    ) {
        return toInvalidIdentity(input.topicId, 'corrupt');
    }
    return {
        valid: true,
        identity: {
            operation: dispatchedOperation,
            operationSource: 'command'
        },
        command
    };
}

function toInvalidIdentity(
    topicId: string,
    operationSource: 'corrupt' | 'unavailable'
): InvalidAppInboxCommandIdentity {
    const operation = topicId === APP_INBOX_GROUP_TOPIC
        ? 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE'
        : topicId === APP_INBOX_CLIENT_TOPIC
        ? 'APP_INBOX_CLIENT_OPERATION_UNAVAILABLE'
        : 'APP_INBOX_OPERATION_UNAVAILABLE';
    return {
        valid: false,
        identity: { operation, operationSource }
    };
}

function isOperationForTopic(
    operation: AppInboxType,
    topicId: string
): boolean {
    if (operation === topicId) {
        return true;
    }
    if (APP_INBOX_OPERATION_SPECIFIC_TOPIC_BY_OPERATION[operation] === topicId) {
        return true;
    }
    return topicId === APP_INBOX_GROUP_TOPIC
        ? APP_INBOX_GROUP_OPERATIONS.has(operation)
        : topicId === APP_INBOX_CLIENT_TOPIC && operation.startsWith('CLIENT_');
}

function isAppInboxType(value: string): value is AppInboxType {
    return APP_INBOX_OPERATIONS.has(value);
}

function isJsonWireObject(value: JsonWireValue | undefined): value is JsonWireObject {
    return value !== undefined && value !== null && typeof value === 'object' && !isJsonWireArray(value);
}

function isJsonWireArray(value: JsonWireValue): value is readonly JsonWireValue[] {
    return Array.isArray(value);
}
