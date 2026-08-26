import type { GroupRef } from '@shared/api/group-types.ts';

function groupStateStorageKeyPart(name: string, value: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Group-state storage key ${name} must be a non-empty string`);
    }
    return `${name}=${encodeURIComponent(value)}`;
}

export function groupStateScopeStorageKey(
    scope: Pick<GroupRef, 'applicationId' | 'workspaceId'>
): string {
    return [
        groupStateStorageKeyPart('app', scope.applicationId),
        groupStateStorageKeyPart('ws', scope.workspaceId)
    ].join(':');
}

export function groupStateGroupStorageKey(ref: GroupRef): string {
    return [groupStateScopeStorageKey(ref), groupStateStorageKeyPart('group', ref.groupId)].join(
        ':'
    );
}

export function decodeGroupStateGroupStorageKey(storageKey: string): GroupRef {
    const parts = storageKey.split(':');
    if (parts.length !== 3) {
        throw new TypeError('Group-state group storage key has invalid arity');
    }
    const ref: GroupRef = {
        applicationId: decodeGroupStateStorageKeyPart(parts[0], 'app'),
        workspaceId: decodeGroupStateStorageKeyPart(parts[1], 'ws'),
        groupId: decodeGroupStateStorageKeyPart(parts[2], 'group')
    };
    if (groupStateGroupStorageKey(ref) !== storageKey) {
        throw new TypeError('Group-state group storage key is not canonical');
    }
    return ref;
}

export function groupStateChildStorageKey(
    ref: GroupRef,
    partName: string,
    value: string
): string {
    return [groupStateGroupStorageKey(ref), groupStateStorageKeyPart(partName, value)].join(':');
}

export function decodeGroupStateChildStorageKey<Name extends string>(
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
    const value = decodeGroupStateStorageKeyPart(parts[3], partName);
    const decoded = { ...ref, [propertyName]: value } as
        & GroupRef
        & Readonly<Record<Name, string>>;
    if (canonicalKeyFor(decoded) !== storageKey) {
        throw new TypeError(`Group-state ${partName} storage key is not canonical`);
    }
    return decoded;
}

function decodeGroupStateStorageKeyPart(part: string | undefined, name: string): string {
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
