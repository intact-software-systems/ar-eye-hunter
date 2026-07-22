import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export enum AppInboxType {
    CLIENT_PRINCIPAL_UPSERT = 'CLIENT_PRINCIPAL_UPSERT',
    CLIENT_INSTANCE_UPSERT = 'CLIENT_INSTANCE_UPSERT',
    CLIENT_SESSION_CONNECT = 'CLIENT_SESSION_CONNECT',
    CLIENT_SESSION_HEARTBEAT = 'CLIENT_SESSION_HEARTBEAT',
    CLIENT_SESSION_DISCONNECT = 'CLIENT_SESSION_DISCONNECT',
    CLIENT_AUTHORISED_WS_CONNECT = 'CLIENT_AUTHORISED_WS_CONNECT',
    CLIENT_AUTHORISED_WS_DISCONNECT = 'CLIENT_AUTHORISED_WS_DISCONNECT',
    CLIENT_EXPIRED_SESSIONS = 'CLIENT_EXPIRED_SESSIONS',
    GROUP_CREATE = 'GROUP_CREATE',
    GROUP_UPDATE = 'GROUP_UPDATE',
    GROUP_DIRECTOR_APPOINT = 'GROUP_DIRECTOR_APPOINT',
    GROUP_JOIN = 'GROUP_JOIN',
    GROUP_INVITE_CREATE = 'GROUP_INVITE_CREATE',
    GROUP_INVITE_REVOKE = 'GROUP_INVITE_REVOKE',
    GROUP_INVITE_ACCEPT = 'GROUP_INVITE_ACCEPT',
    GROUP_JOIN_CODE_ROTATE = 'GROUP_JOIN_CODE_ROTATE',
    GROUP_MEMBER_REMOVE = 'GROUP_MEMBER_REMOVE',
    GROUP_MEMBER_BAN = 'GROUP_MEMBER_BAN',
    GROUP_MEMBER_UNBAN = 'GROUP_MEMBER_UNBAN',
    GROUP_MEMBER_ROLE_SET = 'GROUP_MEMBER_ROLE_SET',
    GROUP_OWNERSHIP_TRANSFER = 'GROUP_OWNERSHIP_TRANSFER',
    GROUP_MEMBER_UPSERT = 'GROUP_MEMBER_UPSERT',
    GROUP_PRESENCE_CONNECT = 'GROUP_PRESENCE_CONNECT',
    GROUP_PRESENCE_HEARTBEAT = 'GROUP_PRESENCE_HEARTBEAT',
    GROUP_PRESENCE_DISCONNECT = 'GROUP_PRESENCE_DISCONNECT',
}

export type AppInboxEnqueueInput<V> = {
    type: AppInboxType;
    topicId?: string;
    resourceId?: string;
    contextId?: string;
    senderId?: string;
    authority?: unknown;
    data: V;
};

export type AppInboxMessageContext = Readonly<{
    enqueue: AppInboxEnqueueInput<unknown>;
    message: ALMessage;
    entry: ResourceEntry;
}>;

export class AppInboxIdempotencyConflictError extends Error {
    readonly code = 'app-inbox-idempotency-conflict';
    readonly status = 409;

    constructor(
        readonly resourceId: string,
        readonly existingCommandHash: string,
        readonly receivedCommandHash: string,
    ) {
        super(`App inbox idempotency conflict for resource ${resourceId}`);
        this.name = 'AppInboxIdempotencyConflictError';
    }
}

export class AppInboxReservationConflictError extends Error {
    readonly code = 'app-inbox-reservation-conflict';
    readonly status = 409;

    constructor(readonly key: Key) {
        super(`App inbox reservation changed before completion: ${JSON.stringify(key)}`);
        this.name = 'AppInboxReservationConflictError';
    }
}
