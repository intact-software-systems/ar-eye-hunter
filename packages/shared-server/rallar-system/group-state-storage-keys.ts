import type { GroupRef } from '@shared/api/group-types.ts';

type GroupMemberStorageRef = GroupRef & Readonly<{ principalId: string }>;
type GroupSessionStorageRef = GroupRef & Readonly<{ sessionId: string }>;

function keyPart(name: string, value: string): string {
    return `${name}=${encodeURIComponent(value)}`;
}

function workspaceKeyPart(workspaceId: string | undefined): string {
    if (workspaceId === undefined) return 'ws=_';
    // Keep the historical absent-workspace namespace while ensuring that the
    // valid explicit identifier "_" cannot alias it. Percent is itself escaped
    // by encodeURIComponent, so "%5F" and the explicit sentinel remain distinct.
    const encoded = workspaceId === '_' ? '%5F' : encodeURIComponent(workspaceId);
    return `ws=${encoded}`;
}

export function groupStateScopeStorageKey(
    scope: Pick<GroupRef, 'applicationId' | 'workspaceId'>,
): string {
    return [
        keyPart('app', scope.applicationId),
        workspaceKeyPart(scope.workspaceId),
    ].join(':');
}

export function groupStateGroupStorageKey(ref: GroupRef): string {
    return [
        groupStateScopeStorageKey(ref),
        keyPart('group', ref.groupId),
    ].join(':');
}

export function decodeGroupStateGroupStorageKey(storageKey: string): GroupRef {
    const parts = storageKey.split(':');
    if (parts.length !== 3) {
        throw new TypeError('Group-state group storage key has invalid arity');
    }
    const applicationId = decodeKeyPart(parts[0], 'app');
    const workspaceId = decodeWorkspaceKeyPart(parts[1]);
    const groupId = decodeKeyPart(parts[2], 'group');
    const ref: GroupRef = {
        applicationId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        groupId,
    };
    if (groupStateGroupStorageKey(ref) !== storageKey) {
        throw new TypeError('Group-state group storage key is not canonical');
    }
    return ref;
}

export function groupStateMemberStorageKey(ref: GroupMemberStorageRef): string {
    return [
        groupStateGroupStorageKey(ref),
        keyPart('member', ref.principalId),
    ].join(':');
}

export function decodeGroupStateMemberStorageKey(
    storageKey: string,
): GroupMemberStorageRef {
    return decodeChildStorageKey(storageKey, 'member', 'principalId');
}

export function groupStatePresenceSessionStorageKey(
    ref: GroupSessionStorageRef,
): string {
    return [
        groupStateGroupStorageKey(ref),
        keyPart('session', ref.sessionId),
    ].join(':');
}

export function decodeGroupStatePresenceSessionStorageKey(
    storageKey: string,
): GroupSessionStorageRef {
    return decodeChildStorageKey(storageKey, 'session', 'sessionId');
}

export function groupStatePresenceAdmissionStorageKey(
    ref: GroupMemberStorageRef,
): string {
    return [
        groupStateGroupStorageKey(ref),
        keyPart('principal', ref.principalId),
    ].join(':');
}

export function decodeGroupStatePresenceAdmissionStorageKey(
    storageKey: string,
): GroupMemberStorageRef {
    return decodeChildStorageKey(storageKey, 'principal', 'principalId');
}

export function groupStatePresenceSummaryStorageKey(ref: GroupRef): string {
    return groupStateGroupStorageKey(ref);
}

export function groupStateIdempotencyStorageKey(
    ref: GroupRef,
    requestId: string,
): string {
    return [
        groupStateGroupStorageKey(ref),
        keyPart('request', requestId),
    ].join(':');
}

export function decodeGroupStateIdempotencyStorageKey(
    storageKey: string,
): GroupRef & Readonly<{ requestId: string }> {
    return decodeChildStorageKey(storageKey, 'request', 'requestId');
}

function decodeChildStorageKey<Name extends string>(
    storageKey: string,
    partName: string,
    propertyName: Name,
): GroupRef & Readonly<Record<Name, string>> {
    const parts = storageKey.split(':');
    if (parts.length !== 4) {
        throw new TypeError(`Group-state ${partName} storage key has invalid arity`);
    }
    const ref = decodeGroupStateGroupStorageKey(parts.slice(0, 3).join(':'));
    const value = decodeKeyPart(parts[3], partName);
    return { ...ref, [propertyName]: value } as GroupRef &
        Readonly<Record<Name, string>>;
}

function decodeKeyPart(part: string | undefined, name: string): string {
    const prefix = `${name}=`;
    if (!part?.startsWith(prefix)) {
        throw new TypeError(`Group-state storage key is missing ${name}`);
    }
    try {
        return decodeURIComponent(part.slice(prefix.length));
    } catch {
        throw new TypeError(`Group-state storage key has invalid ${name} encoding`);
    }
}

function decodeWorkspaceKeyPart(part: string | undefined): string | undefined {
    if (part === 'ws=_') return undefined;
    const workspaceId = decodeKeyPart(part, 'ws');
    return workspaceId;
}
