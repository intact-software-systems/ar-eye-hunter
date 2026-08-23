import type { GroupRef } from '@shared/api/group-types.ts';

type GroupMemberStorageRef = GroupRef & Readonly<{ principalId: string; }>;
type GroupSessionStorageRef = GroupRef & Readonly<{ sessionId: string; }>;

function keyPart(name: string, value: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Group-state storage key ${name} must be a non-empty string`);
    }
    return `${name}=${encodeURIComponent(value)}`;
}

export function groupStateScopeStorageKey(
    scope: Pick<GroupRef, 'applicationId' | 'workspaceId'>
): string {
    return [keyPart('app', scope.applicationId), keyPart('ws', scope.workspaceId)].join(':');
}

export function groupStateGroupStorageKey(ref: GroupRef): string {
    return [groupStateScopeStorageKey(ref), keyPart('group', ref.groupId)].join(':');
}

export function decodeGroupStateGroupStorageKey(storageKey: string): GroupRef {
    const parts = storageKey.split(':');
    if (parts.length !== 3) {
        throw new TypeError('Group-state group storage key has invalid arity');
    }
    const applicationId = decodeKeyPart(parts[0], 'app');
    const workspaceId = decodeKeyPart(parts[1], 'ws');
    const groupId = decodeKeyPart(parts[2], 'group');
    const ref: GroupRef = {
        applicationId,
        workspaceId,
        groupId
    };
    const canonicalStorageKey = groupStateGroupStorageKey(ref);
    if (canonicalStorageKey !== storageKey) {
        throw new TypeError('Group-state group storage key is not canonical');
    }
    return ref;
}

export function groupStateMemberStorageKey(ref: GroupMemberStorageRef): string {
    return [groupStateGroupStorageKey(ref), keyPart('member', ref.principalId)].join(':');
}

export function decodeGroupStateMemberStorageKey(storageKey: string): GroupMemberStorageRef {
    return decodeChildStorageKey(storageKey, 'member', 'principalId', groupStateMemberStorageKey);
}

export function groupStatePresenceSessionStorageKey(ref: GroupSessionStorageRef): string {
    return [groupStateGroupStorageKey(ref), keyPart('session', ref.sessionId)].join(':');
}

export function decodeGroupStatePresenceSessionStorageKey(
    storageKey: string
): GroupSessionStorageRef {
    return decodeChildStorageKey(
        storageKey,
        'session',
        'sessionId',
        groupStatePresenceSessionStorageKey
    );
}

export function groupStatePresenceAdmissionStorageKey(ref: GroupMemberStorageRef): string {
    return [groupStateGroupStorageKey(ref), keyPart('principal', ref.principalId)].join(':');
}

export function decodeGroupStatePresenceAdmissionStorageKey(
    storageKey: string
): GroupMemberStorageRef {
    return decodeChildStorageKey(
        storageKey,
        'principal',
        'principalId',
        groupStatePresenceAdmissionStorageKey
    );
}

export function groupStatePresenceSummaryStorageKey(ref: GroupRef): string {
    return groupStateGroupStorageKey(ref);
}

export function groupStateIdempotencyStorageKey(ref: GroupRef, requestId: string): string {
    return [groupStateGroupStorageKey(ref), keyPart('request', requestId)].join(':');
}

export function decodeGroupStateIdempotencyStorageKey(
    storageKey: string
): GroupRef & Readonly<{ requestId: string; }> {
    return decodeChildStorageKey(
        storageKey,
        'request',
        'requestId',
        (ref) => groupStateIdempotencyStorageKey(ref, ref.requestId)
    );
}

function decodeChildStorageKey<Name extends string>(
    storageKey: string,
    partName: string,
    propertyName: Name,
    canonicalKeyFor: (ref: GroupRef & Readonly<Record<Name, string>>) => string
): GroupRef & Readonly<Record<Name, string>> {
    const parts = storageKey.split(':');
    if (parts.length !== 4) {
        throw new TypeError(`Group-state ${partName} storage key has invalid arity`);
    }
    const ref = decodeGroupStateGroupStorageKey(parts.slice(0, 3).join(':'));
    const value = decodeKeyPart(parts[3], partName);
    const decoded = { ...ref, [propertyName]: value } as GroupRef & Readonly<Record<Name, string>>;
    if (canonicalKeyFor(decoded) !== storageKey) {
        throw new TypeError(`Group-state ${partName} storage key is not canonical`);
    }
    return decoded;
}

function decodeKeyPart(part: string | undefined, name: string): string {
    const prefix = `${name}=`;
    if (!part?.startsWith(prefix)) {
        throw new TypeError(`Group-state storage key is missing ${name}`);
    }
    try {
        const value = decodeURIComponent(part.slice(prefix.length));
        if (value.length === 0) {
            throw new TypeError(`Group-state storage key ${name} must be a non-empty string`);
        }
        return value;
    }
    catch {
        throw new TypeError(`Group-state storage key has invalid ${name} encoding`);
    }
}
