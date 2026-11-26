import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { AppTopics } from '../api-config.ts';
import { requireExactKeys, requireOneOf, requireRecord, requireString } from '../exact-object-decoding.ts';
import { decodeStateScope, type StateScope } from '../state-types.ts';
import { assertRoomDeadlineName } from '../group-deadlines/room-deadline.ts';
import { hasServerRoomSnapshotTopic } from './server-room-snapshot.ts';

export namespace ViewInvalidation {
    export interface ScopedAccount {
        readonly version: 1;
        readonly resource:
            | 'party'
            | 'matchmaking'
            | 'room-lobby'
            | 'friends'
            | 'sessions'
            | 'tournament-catalog'
            | 'tournament'
            | 'room-move';
        readonly scope: StateScope;
        readonly principalId: string;
        readonly changeId: string;
    }
    interface RoomAccount {
        readonly version: 1;
        readonly scope: StateScope;
        readonly principalId: string;
        readonly groupId: string;
        readonly changeId: string;
    }
    export interface RoomAccess extends RoomAccount {
        readonly resource: 'room-access';
    }
    export interface RoomEvent extends RoomAccount {
        readonly resource: 'room-event' | 'room-event-organizer';
    }
    export interface RoomProgram extends RoomAccount {
        readonly resource: 'room-program';
        readonly name: string;
    }

    export interface PublicCatalog {
        readonly version: 1;
        readonly resource: 'tournament-catalog';
        readonly scope: StateScope;
        readonly principalId: null;
        readonly changeId: string;
    }
    export interface Account {
        readonly version: 1;
        readonly resource: 'friends';
        readonly scope: null;
        readonly principalId: string;
        readonly changeId: string;
    }
}

export type ViewInvalidation =
    | ViewInvalidation.RoomAccess
    | ViewInvalidation.RoomEvent
    | ViewInvalidation.RoomProgram
    | ViewInvalidation.ScopedAccount
    | ViewInvalidation.Account
    | ViewInvalidation.PublicCatalog;

/** A hint to read authority again, never a replacement snapshot or permission to access a resource. */
export function decodeViewInvalidation(value: unknown): ViewInvalidation {
    const record = requireRecord(value, 'View invalidation');
    const keys = ['version', 'resource', 'scope', 'principalId', 'changeId'];
    if (record.resource === 'room-access' || record.resource === 'room-event' || record.resource === 'room-event-organizer' || record.resource === 'room-program') {
        keys.push('groupId');
    }
    if (record.resource === 'room-program') {
        keys.push('name');
    }
    requireExactKeys(record, keys, 'View invalidation');
    if (record.version !== 1) {
        throw new TypeError('Unsupported view invalidation version');
    }
    requireString(record.changeId, 'View change identity');
    if (record.principalId === null) {
        if (record.resource !== 'tournament-catalog') {
            throw new TypeError('Only public tournament catalogs permit scope-wide invalidations');
        }
        return {
            version: 1,
            resource: 'tournament-catalog',
            scope: decodeStateScope(record.scope),
            principalId: null,
            changeId: record.changeId
        };
    }
    requireString(record.principalId, 'View principal');
    if (record.scope === null) {
        if (record.resource !== 'friends') {
            throw new TypeError('Only friends list invalidations can be account-wide');
        }
        return {
            version: 1,
            resource: 'friends',
            scope: null,
            principalId: record.principalId,
            changeId: record.changeId
        };
    }
    const account = {
        version: 1 as const,
        scope: decodeStateScope(record.scope),
        principalId: record.principalId,
        changeId: record.changeId
    };
    if (record.resource === 'room-access' || record.resource === 'room-event' || record.resource === 'room-event-organizer' || record.resource === 'room-program') {
        requireString(record.groupId, 'View room');
        if (record.resource !== 'room-program') {
            return { ...account, resource: record.resource, groupId: record.groupId };
        }
        assertRoomDeadlineName(record.name);
        return { ...account, resource: record.resource, groupId: record.groupId, name: record.name };
    }
    return {
        ...account,
        resource: requireOneOf(record.resource, [
            'party', 'matchmaking', 'room-lobby', 'friends', 'sessions', 'tournament-catalog', 'tournament', 'room-move'
        ], 'View resource')
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

/** Either half naming the topic routes the envelope to the view owner, whose decoder then requires both. */
export function hasViewInvalidatedTopic(message: ALMessage): boolean {
    return message.route.topicId === AppTopics.viewInvalidated || message.payload.typeId === AppTopics.viewInvalidated;
}

/** Only the server publishes these, to sockets it selects itself: no client ingress and no relay to a resolved peer. */
export function hasServerPushedViewTopic(message: ALMessage): boolean {
    return hasViewInvalidatedTopic(message) || hasServerRoomSnapshotTopic(message) ||
        message.route.topicId === AppTopics.viewResync || message.payload.typeId === AppTopics.viewResync;
}

/** Validates both the untrusted payload and the exact own-account transport target. */
export function decodeViewInvalidationMessage(message: ALMessage): ViewInvalidation {
    if (message.route.topicId !== AppTopics.viewInvalidated || message.payload.typeId !== AppTopics.viewInvalidated) {
        throw new TypeError('View invalidation topic and type differ');
    }
    const notice = decodeViewInvalidation(JSON.parse(message.payload.resource));
    const targets = requireRecord(message.targets, 'View targets');
    if (notice.principalId === null) {
        requireExactKeys(targets, ['mode', 'scope'], 'Public catalog targets');
        if (
            targets.mode !== 'broadcast' || targets.scope !== 'world' ||
            message.route.contextId !== notice.scope.applicationId
        ) {
            throw new TypeError('Public catalog differs from its scoped world target');
        }
        return notice;
    }
    if (notice.scope === null) {
        requireExactKeys(targets, ['mode', 'toPeerId'], 'Account view targets');
        if (targets.mode !== 'unicast' || targets.toPeerId !== notice.principalId) {
            throw new TypeError('Account view differs from its exact account target');
        }
        return notice;
    }
    requireExactKeys(targets, ['mode', 'scope', 'principalRef'], 'View targets');
    const principalRef = requireRecord(targets.principalRef, 'View target principal');
    requireExactKeys(principalRef, ['applicationId', 'workspaceId', 'principalId'], 'View target principal');
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
