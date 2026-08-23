import type { GroupRef, GroupScope, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
export type GroupStateAuthorityGuard = Readonly<{
    groupRef: GroupRef;
    entry: RuntimeStateEntry;
    causalGroupRevision: number;
}>;

export type GroupStateAuthoritativeSnapshot = Readonly<{
    snapshot: GroupSnapshot;
    authorityGuard: GroupStateAuthorityGuard;
}>;

export class GroupStateRepositoryInvariantCorruptionError extends Error {
    readonly code = 'group-state-repository-invariant-corruption';

    readonly storageKey: string;

    constructor(
        storageKey: string,
        message: string
    ) {
        super(`${message}: ${storageKey}`);
        this.storageKey = storageKey;
        this.name = 'GroupStateRepositoryInvariantCorruptionError';
    }
}

export async function toLiveGroupStateEntryValue<T>(
    entry: RuntimeStateEntry
): Promise<RuntimeStateEntryValue<T> | undefined> {
    if (entry.expireAtTimestamp <= Date.now()) {
        return undefined;
    }
    try {
        return { entry, value: JSON.parse(entry.value) as T };
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw new GroupStateRepositoryInvariantCorruptionError(
                entry.key,
                `Stored group-state JSON is invalid: ${error.message}`
            );
        }
        throw error;
    }
}

export function assertGroupRefIdentity(
    value: GroupRef,
    expected: GroupRef,
    storageKey: string
): void {
    if (
        value.applicationId !== expected.applicationId ||
        value.workspaceId !== expected.workspaceId ||
        value.groupId !== expected.groupId
    ) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            storageKey,
            'Stored group-state identity differs from the requested slot'
        );
    }
}

export function assertDecodedGroupScope(
    decoded: GroupRef,
    expected: GroupScope,
    storageKey: string
): void {
    if (
        decoded.applicationId !== expected.applicationId ||
        decoded.workspaceId !== expected.workspaceId
    ) {
        throwGroupStateIdentityCorruption(storageKey, 'scope');
    }
}

export function assertTrustedGroupRef(
    decoded: GroupRef,
    expected: GroupRef | undefined,
    storageKey: string
): void {
    if (expected) {
        assertGroupRefIdentity(decoded, expected, storageKey);
    }
}

export function decodeStoredGroupStateKey<T>(
    storageKey: string,
    decode: (storageKey: string) => T
): T {
    try {
        return decode(storageKey);
    }
    catch (error) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            storageKey,
            error instanceof Error ? error.message : 'Stored group-state key is invalid'
        );
    }
}

export function decodeStoredGroupStateValue<T>(
    value: unknown,
    ref: GroupRef,
    storageKey: string,
    decode: (value: unknown, ref: GroupRef) => T,
    invalidValueMessage: string
): T {
    try {
        return decode(value, ref);
    }
    catch (error) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            storageKey,
            error instanceof Error ? error.message : invalidValueMessage
        );
    }
}

export function throwGroupStateIdentityCorruption(storageKey: string, slot: string): never {
    throw new GroupStateRepositoryInvariantCorruptionError(
        storageKey,
        `Stored group-state ${slot} differs from the decoded slot`
    );
}
