import type {
    GroupRef,
    GroupScope,
    GroupSnapshot
} from '@shared/api/group-types.ts';

import type { RuntimeStateReadBatchLiveSelection } from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeGroupStateGroupStorageKey } from './aggregate/group-aggregate-storage-keys.ts';
import { decodeRetiredGroupIdentity } from './aggregate/retired-group-identity.ts';
import { GROUPS_NAMESPACE } from './group-state-runtime-namespaces.ts';

export interface GroupStateAuthorityGuard {
    readonly groupRef: GroupRef;
    readonly entry: RuntimeStateEntry;
    readonly causalGroupRevision: number;
}

export interface GroupStateAuthoritativeSnapshot {
    readonly snapshot: GroupSnapshot;
    readonly authorityGuard: GroupStateAuthorityGuard;
}

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

export function toLiveGroupStateEntryValue(
    namespace: string,
    entry: RuntimeStateEntry,
    observedAtEpochMs: number
): RuntimeStateEntryValue<JsonWireValue> | undefined {
    try {
        const value: JsonWireValue = JSON.parse(entry.value);
        if (
            namespace === GROUPS_NAMESPACE && value !== null && typeof value === 'object' &&
            'kind' in value && value.kind === 'retired-group'
        ) {
            decodeRetiredGroupIdentity({ entry, value }, decodeGroupStateGroupStorageKey(entry.key));
        }
        return entry.expireAtTimestamp <= observedAtEpochMs ? undefined : { entry, value };
    }
    catch (error) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            entry.key,
            `Stored group-state JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/** Decode one selected snapshot at its captured time without rereading or removing expired rows. */
export function toGroupStateReadBatchLiveSelections(
    selectors: readonly RuntimeStateReadBatchSelector[],
    selections: readonly RuntimeStateReadBatchSelection[],
    observedAtEpochMs: number
): readonly RuntimeStateReadBatchLiveSelection<JsonWireValue>[] {
    return selections.map((selection, index) => {
        const entries: RuntimeStateEntryValue<JsonWireValue>[] = [];
        const expiredEntries: RuntimeStateEntry[] = [];
        for (const entry of selection.entries) {
            const live = toLiveGroupStateEntryValue(selectors[index].namespace, entry, observedAtEpochMs);
            if (live === undefined) {
                expiredEntries.push(entry);
            }
            else {
                entries.push(live);
            }
        }
        return { selectorId: selection.selectorId, entries, expiredEntries };
    });
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

export interface StoredGroupStateValueInput<T> {
    readonly value: JsonWireValue;
    readonly ref: GroupRef;
    readonly storageKey: string;
    readonly decode: (value: JsonWireValue, ref: GroupRef) => T;
    readonly invalidValueMessage: string;
}

export function decodeStoredGroupStateValue<T>({
    value,
    ref,
    storageKey,
    decode,
    invalidValueMessage
}: StoredGroupStateValueInput<T>): T {
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
