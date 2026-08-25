import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';

export const AppInboxType = {
    AUTH_USER_REGISTER: 'AUTH_USER_REGISTER',
    AUTH_SESSION_ISSUE: 'AUTH_SESSION_ISSUE',
    AUTH_SESSION_LOGOUT: 'AUTH_SESSION_LOGOUT',
    AUTH_WS_TICKET_ISSUE: 'AUTH_WS_TICKET_ISSUE',
    AUTH_WS_TICKET_CONSUME: 'AUTH_WS_TICKET_CONSUME',
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
    GROUP_ESTABLISHMENT_START: 'GROUP_ESTABLISHMENT_START',
    GROUP_ACTIVATE: 'GROUP_ACTIVATE',
    GROUP_ESTABLISHMENT_REOPEN: 'GROUP_ESTABLISHMENT_REOPEN',
    GROUP_JOIN: 'GROUP_JOIN',
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
    GROUP_OWNERSHIP_TRANSFER: 'GROUP_OWNERSHIP_TRANSFER',
    GROUP_MEMBER_UPSERT: 'GROUP_MEMBER_UPSERT',
    GROUP_PRESENCE_CONNECT: 'GROUP_PRESENCE_CONNECT',
    GROUP_PRESENCE_HEARTBEAT: 'GROUP_PRESENCE_HEARTBEAT',
    GROUP_PRESENCE_DISCONNECT: 'GROUP_PRESENCE_DISCONNECT',
    GROUP_PRESENCE_EXPIRE: 'GROUP_PRESENCE_EXPIRE',
    GROUP_FORMATION_CRITERION: 'GROUP_FORMATION_CRITERION',
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

export type AppInboxType = (typeof AppInboxType)[keyof typeof AppInboxType];

export type AppInboxAuthorityInput = JsonWireValue | object;

export interface AppInboxEnqueueInput<V, Authority = AppInboxAuthorityInput> {
    readonly type: AppInboxType;
    readonly topicId?: string;
    readonly resourceId?: string;
    readonly contextId?: string;
    readonly senderId?: string;
    readonly authority?: Authority;
    readonly data: V;
}

export type AppInboxExecutionMetadata = Readonly<{
    enqueue: AppInboxEnqueueInput<JsonWireValue, JsonWireValue>;
    message: ALMessage;
    entry: ResourceEntry;
}>;

export type AppInboxMessageContext<Result = JsonWireValue> =
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

export class AppInboxReservationConflictError extends Error {
    readonly code = 'app-inbox-reservation-conflict';
    readonly status = 409;

    readonly key: Key;

    constructor(key: Key) {
        super(`App inbox reservation changed before completion: ${JSON.stringify(key)}`);
        this.key = key;
        this.name = 'AppInboxReservationConflictError';
    }
}
