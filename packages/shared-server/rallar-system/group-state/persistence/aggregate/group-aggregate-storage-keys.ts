import type { GroupRef } from '@shared/api/group-types.ts';

// URI component coding leaves exactly these characters unchanged, so a value made of them is its own encoding.
const uriComponentUnreservedPattern = /^[A-Za-z0-9\-_.!~*'()]+$/;

function groupStateStorageKeyPart(name: string, value: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Group-state storage key ${name} must be a non-empty string`);
    }
    return `${name}=${toEncodedGroupStateStorageKeyValue(value)}`;
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
    return decodeGroupStateGroupStorageKeyParts(parts);
}

export function groupStateChildStorageKey(
    ref: GroupRef,
    partName: string,
    value: string
): string {
    return `${groupStateGroupStorageKey(ref)}${groupStateChildStorageKeySuffix(partName, value)}`;
}

export function groupStateChildStorageKeySuffix(partName: string, value: string): string {
    return `:${groupStateStorageKeyPart(partName, value)}`;
}

export function decodeGroupStateChildStorageKey<Name extends string>(
    storageKey: string,
    partName: string,
    propertyName: Name
): GroupRef & Readonly<Record<Name, string>> {
    const { ref, values } = decodeGroupStateChildStorageKeyValues(storageKey, [partName]);
    return { ...ref, [propertyName]: values[0] } as GroupRef & Readonly<Record<Name, string>>;
}

/** The group and the canonical value of each named child part, in key order, of a key with exactly those parts. */
export function decodeGroupStateChildStorageKeyValues(
    storageKey: string,
    partNames: readonly string[]
): Readonly<{ ref: GroupRef; values: readonly string[]; }> {
    const label = partNames.join(' ');
    const parts = storageKey.split(':');
    if (parts.length !== 3 + partNames.length) {
        throw new TypeError(`Group-state ${label} storage key has invalid arity`);
    }
    const ref = decodeGroupStateGroupStorageKeyParts(parts);
    const values = partNames.map((partName, index) => decodeGroupStateStorageKeyPart(parts[3 + index], partName));
    if (
        !values.every((value, index) => isCanonicalGroupStateStorageKeyPart(parts[3 + index], partNames[index], value))
    ) {
        throw new TypeError(`Group-state ${label} storage key is not canonical`);
    }
    return { ref, values };
}

function decodeGroupStateGroupStorageKeyParts(parts: readonly string[]): GroupRef {
    const applicationId = decodeGroupStateStorageKeyPart(parts[0], 'app');
    const workspaceId = decodeGroupStateStorageKeyPart(parts[1], 'ws');
    const groupId = decodeGroupStateStorageKeyPart(parts[2], 'group');
    const canonical = isCanonicalGroupStateStorageKeyPart(parts[0], 'app', applicationId) &&
        isCanonicalGroupStateStorageKeyPart(parts[1], 'ws', workspaceId) &&
        isCanonicalGroupStateStorageKeyPart(parts[2], 'group', groupId);
    if (!canonical) {
        throw new TypeError('Group-state group storage key is not canonical');
    }
    return { applicationId, workspaceId, groupId };
}

function decodeGroupStateStorageKeyPart(part: string, name: string): string {
    if (!part.startsWith(`${name}=`)) {
        throw new TypeError(`Group-state storage key is missing ${name}`);
    }
    const value = toDecodedGroupStateStorageKeyValue(part.slice(name.length + 1));
    if (value === null || value.length === 0) {
        throw new TypeError(`Group-state storage key has invalid ${name} encoding`);
    }
    return value;
}

function toEncodedGroupStateStorageKeyValue(value: string): string {
    return uriComponentUnreservedPattern.test(value) ? value : encodeURIComponent(value);
}

function toDecodedGroupStateStorageKeyValue(encoded: string): string | null {
    if (uriComponentUnreservedPattern.test(encoded)) {
        return encoded;
    }
    try {
        return decodeURIComponent(encoded);
    }
    catch {
        return null;
    }
}

function isCanonicalGroupStateStorageKeyPart(part: string, name: string, value: string): boolean {
    return part === groupStateStorageKeyPart(name, value);
}
