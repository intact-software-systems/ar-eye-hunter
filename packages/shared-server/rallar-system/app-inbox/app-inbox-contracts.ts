import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ResourceInboxAttemptTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import type { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';

export const AppInboxType = {
    AUTH_USER_REGISTER: 'AUTH_USER_REGISTER',
    AUTH_SESSION_ISSUE: 'AUTH_SESSION_ISSUE',
    AUTH_SESSION_LOGOUT: 'AUTH_SESSION_LOGOUT',
    AUTH_WS_TICKET_ISSUE: 'AUTH_WS_TICKET_ISSUE',
    AUTH_AGENT_SESSION_TICKETS_ISSUE: 'AUTH_AGENT_SESSION_TICKETS_ISSUE',
    AUTH_AGENT_SESSION_TICKET_CONSUME: 'AUTH_AGENT_SESSION_TICKET_CONSUME',
    CLIENT_PRINCIPAL_UPSERT: 'CLIENT_PRINCIPAL_UPSERT',
    CLIENT_INSTANCE_UPSERT: 'CLIENT_INSTANCE_UPSERT',
    CLIENT_SESSION_CONNECT: 'CLIENT_SESSION_CONNECT',
    CLIENT_SESSION_HEARTBEAT: 'CLIENT_SESSION_HEARTBEAT',
    CLIENT_SESSION_DISCONNECT: 'CLIENT_SESSION_DISCONNECT',
    CLIENT_AUTHORISED_WS_CONNECT: 'CLIENT_AUTHORISED_WS_CONNECT',
    CLIENT_AUTHORISED_WS_DISCONNECT: 'CLIENT_AUTHORISED_WS_DISCONNECT',
    CLIENT_EXPIRED_SESSIONS: 'CLIENT_EXPIRED_SESSIONS',
    GROUP_CREATE: 'GROUP_CREATE',
    GROUP_UPDATE: 'GROUP_UPDATE',
    GROUP_DIRECTOR_APPOINT: 'GROUP_DIRECTOR_APPOINT',
    GROUP_PLAN: 'GROUP_PLAN',
    GROUP_CONNECT: 'GROUP_CONNECT',
    GROUP_ACTIVATE: 'GROUP_ACTIVATE',
    GROUP_RECONFIGURE: 'GROUP_RECONFIGURE',
    GROUP_JOIN: 'GROUP_JOIN',
    GROUP_QUICK_JOIN: 'GROUP_QUICK_JOIN',
    GROUP_RETENTION_RECONCILE: 'GROUP_RETENTION_RECONCILE',
    GROUP_INVITE_CREATE: 'GROUP_INVITE_CREATE',
    GROUP_INVITE_REVOKE: 'GROUP_INVITE_REVOKE',
    GROUP_INVITE_ACCEPT: 'GROUP_INVITE_ACCEPT',
    GROUP_ADMISSION_GRANT: 'GROUP_ADMISSION_GRANT',
    GROUP_ADMISSION_DECLINE: 'GROUP_ADMISSION_DECLINE',
    GROUP_JOIN_CODE_ROTATE: 'GROUP_JOIN_CODE_ROTATE',
    GROUP_MEMBER_REMOVE: 'GROUP_MEMBER_REMOVE',
    GROUP_MEMBER_BAN: 'GROUP_MEMBER_BAN',
    GROUP_MEMBER_UNBAN: 'GROUP_MEMBER_UNBAN',
    GROUP_MEMBER_ROLE_SET: 'GROUP_MEMBER_ROLE_SET',
    GROUP_PUBLICATION_GRANT: 'GROUP_PUBLICATION_GRANT',
    GROUP_PUBLICATION_REVOKE: 'GROUP_PUBLICATION_REVOKE',
    GROUP_TOPIC_SUBSCRIBE: 'GROUP_TOPIC_SUBSCRIBE',
    GROUP_TOPIC_UNSUBSCRIBE: 'GROUP_TOPIC_UNSUBSCRIBE',
    GROUP_OWNERSHIP_TRANSFER: 'GROUP_OWNERSHIP_TRANSFER',
    GROUP_MEMBER_UPSERT: 'GROUP_MEMBER_UPSERT',
    GROUP_PRESENCE_CONNECT: 'GROUP_PRESENCE_CONNECT',
    GROUP_PRESENCE_HEARTBEAT: 'GROUP_PRESENCE_HEARTBEAT',
    GROUP_PRESENCE_DISCONNECT: 'GROUP_PRESENCE_DISCONNECT',
    GROUP_TRANSPORT_PAUSE: 'GROUP_TRANSPORT_PAUSE',
    GROUP_TRANSPORT_RESUME: 'GROUP_TRANSPORT_RESUME',
    GROUP_FORMATION_START: 'GROUP_FORMATION_START',
    GROUP_FORMATION_RESET: 'GROUP_FORMATION_RESET',
    GROUP_PRESENCE_EXPIRE: 'GROUP_PRESENCE_EXPIRE',
    GROUP_FORMATION_AUTOMATION: 'GROUP_FORMATION_AUTOMATION',
    GROUP_FORMATION_CRITERION: 'GROUP_FORMATION_CRITERION',
    GROUP_TOPOLOGY_PUBLICATION: 'GROUP_TOPOLOGY_PUBLICATION',
    GROUP_ACTIVATION_STATUS: 'GROUP_ACTIVATION_STATUS',
    GROUP_PRESENCE_SESSION_CLEANUP: 'GROUP_PRESENCE_SESSION_CLEANUP',
    TOPOLOGY_CONFIG_PUT: 'TOPOLOGY_CONFIG_PUT',
    TOPOLOGY_CONFIG_DELETE: 'TOPOLOGY_CONFIG_DELETE',
    TOPOLOGY_OVERRIDE_PUT: 'TOPOLOGY_OVERRIDE_PUT',
    TOPOLOGY_OVERRIDE_DELETE: 'TOPOLOGY_OVERRIDE_DELETE',
    TOPOLOGY_RECONFIGURE: 'TOPOLOGY_RECONFIGURE',
    RTC_RTT_SUBMIT: 'RTC_RTT_SUBMIT',
    CRDT_UPDATE_APPEND: 'CRDT_UPDATE_APPEND',
    CRDT_PROJECTION_REBUILD: 'CRDT_PROJECTION_REBUILD',
    CRDT_SNAPSHOT_COMPACT: 'CRDT_SNAPSHOT_COMPACT',
    CRDT_LIFECYCLE_UPDATE: 'CRDT_LIFECYCLE_UPDATE',
    CRDT_ERASE: 'CRDT_ERASE',
    ADMIN_PRUNE_EXPIRED: 'ADMIN_PRUNE_EXPIRED'
} as const;

/** App-owned operations use their own namespace and an exact operation-named topic. */
export type AppInboxType = (typeof AppInboxType)[keyof typeof AppInboxType] | `app:${string}:${string}`;

const PLATFORM_APP_INBOX_TYPES = new Set<string>(Object.values(AppInboxType));

export function isAppInboxType(value: string): value is AppInboxType {
    return PLATFORM_APP_INBOX_TYPES.has(value) || /^app:[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.-]*$/u.test(value);
}

/** Enqueued by no request path that waits for the result, so no instance can hold a waiter for its completion. */
const FIRE_AND_FORGET_APP_INBOX_TYPES: ReadonlySet<AppInboxType> = new Set([
    AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
    AppInboxType.CLIENT_EXPIRED_SESSIONS,
    AppInboxType.GROUP_PRESENCE_EXPIRE,
    AppInboxType.GROUP_RETENTION_RECONCILE,
    AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
    AppInboxType.GROUP_FORMATION_AUTOMATION,
    AppInboxType.GROUP_FORMATION_CRITERION,
    AppInboxType.GROUP_TOPOLOGY_PUBLICATION,
    AppInboxType.GROUP_ACTIVATION_STATUS,
    AppInboxType.RTC_RTT_SUBMIT
]);

export function toAppInboxCompletionAwaitability(
    type: AppInboxType
): ResourceInboxCompletionNotifications.Awaitability {
    return FIRE_AND_FORGET_APP_INBOX_TYPES.has(type) ? 'fire-and-forget' : 'awaitable';
}

/** The command an AppInbox entry stores. Its trace rides on the entry's envelope, never inside the command. */
export interface AppInboxEnqueue {
    readonly type: AppInboxType;
    readonly topicId?: string;
    readonly resourceId?: string;
    /** The claim unit: a context's rows are claimed oldest-first; that is no mutual exclusion and no serial order. */
    readonly contextId: string;
    readonly senderId?: string;
    readonly authority?: JsonWireValue;
    readonly data: JsonWireValue;
}

export interface AppInboxEnqueueInput extends AppInboxEnqueue {
    readonly traceId: string;
}

export interface AppInboxExecutionMetadata {
    readonly enqueue: AppInboxEnqueue;
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly attemptTelemetry: ResourceInboxAttemptTelemetry;
}

/**
 * One attempt of a queued command, read once by its handler from the entry and the stored envelope. The trace enters
 * the compute facts, never the logical command, so it stays out of every idempotency identity.
 */
export interface AppInboxCommandAttempt {
    readonly attemptCount: number;
    readonly traceId: string;
}

export function toAppInboxCommandAttempt(context: AppInboxExecutionMetadata): AppInboxCommandAttempt {
    return { attemptCount: context.entry.dequeueAudit.attempts, traceId: context.message.id.traceId };
}

export type AppInboxMessageContext<Result> =
    & AppInboxExecutionMetadata
    & Readonly<{
        encodeResult: (result: Result) => JsonWireValue;
    }>;

export class AppInboxIdempotencyConflictError extends Error {
    readonly code = 'app-inbox-idempotency-conflict';
    readonly status = 409;

    readonly resourceId: string;
    readonly existingCommandHash: string;
    readonly receivedCommandHash: string;

    constructor(
        resourceId: string,
        existingCommandHash: string,
        receivedCommandHash: string
    ) {
        super(`App inbox idempotency conflict for resource ${resourceId}`);
        this.resourceId = resourceId;
        this.existingCommandHash = existingCommandHash;
        this.receivedCommandHash = receivedCommandHash;
        this.name = 'AppInboxIdempotencyConflictError';
    }
}

/** The attempt was abandoned at its deadline below the reservation lease; the entry follows the retry path. */
export class AppInboxAttemptDeadlineExceededError extends Error {
    readonly code = 'app-inbox-attempt-deadline-exceeded';

    readonly key: Key;

    constructor(key: Key) {
        super('App inbox attempt did not settle before its deadline');
        this.key = key;
        this.name = 'AppInboxAttemptDeadlineExceededError';
    }
}

export class AppInboxReservationConflictError extends Error {
    readonly code = 'app-inbox-reservation-conflict';
    readonly status = 409;

    readonly key: Key;

    constructor(key: Key) {
        super('App inbox reservation changed before completion');
        this.key = key;
        this.name = 'AppInboxReservationConflictError';
    }
}
