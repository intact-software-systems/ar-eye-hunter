import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { serializeCanonicalJson } from '../../protocol/canonical-json.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { toExactJsonWireObject } from '../../protocol/to-json-wire-object.ts';
import { groupStateGroupStorageKey } from './aggregate/group-aggregate-storage-keys.ts';

export const GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE = 'group-state:connect-trigger-latches';

export interface GroupConnectTriggerIdentity {
    readonly groupRef: GroupRef;
    readonly formationEpoch: number;
    readonly triggerGeneration: string;
}

export interface GroupConnectTriggerLatch extends GroupConnectTriggerIdentity {
    readonly state: 'awaiting-publication' | 'consumed';
}

export interface GroupConnectTriggerLatchRow {
    readonly latch: GroupConnectTriggerLatch;
    readonly revision: number;
}

export class GroupConnectTriggerLatchCorruptionError extends Error {
    constructor(key: string) {
        super(`Group connect trigger latch is corrupt at ${key}`);
        this.name = 'GroupConnectTriggerLatchCorruptionError';
    }
}

export class GroupConnectTriggerLatchRepository {
    readonly #runtime: RuntimeStateRepositoryLike;

    constructor(runtime: RuntimeStateRepositoryLike) {
        this.#runtime = runtime;
    }

    async read(identity: GroupConnectTriggerIdentity): Promise<GroupConnectTriggerLatchRow | null> {
        const key = toGroupConnectTriggerStorageKey(identity);
        const entry = await this.#runtime.findEntry(GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE, key);
        return entry === undefined ? null : decodeGroupConnectTriggerLatchRow(entry, identity);
    }

    async listAwaiting(groupRef: GroupRef, formationEpoch: number): Promise<readonly GroupConnectTriggerLatchRow[]> {
        const prefix = toGroupConnectTriggerEpochPrefix(groupRef, formationEpoch);
        const rows: GroupConnectTriggerLatchRow[] = [];
        let afterKey: string | undefined;
        for (;;) {
            const entries = await this.#runtime.findEntriesByPrefixPage(
                GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
                prefix,
                { afterKey, limit: 100 }
            );
            for (const entry of entries) {
                if (!entry.key.startsWith(prefix)) {
                    throw new GroupConnectTriggerLatchCorruptionError(entry.key);
                }
                const triggerGeneration = decodeTriggerGeneration(entry.key, prefix);
                const row = decodeGroupConnectTriggerLatchRow(entry, { groupRef, formationEpoch, triggerGeneration });
                if (row.latch.state === 'awaiting-publication') {
                    rows.push(row);
                }
            }
            if (entries.length < 100) {
                return rows;
            }
            afterKey = entries.at(-1)!.key;
        }
    }
}

export function toGroupConnectTriggerStorageKey(identity: GroupConnectTriggerIdentity): string {
    if (identity.triggerGeneration.length === 0) {
        throw new TypeError('Connect trigger generation must be non-empty');
    }
    return toGroupConnectTriggerEpochPrefix(identity.groupRef, identity.formationEpoch) +
        encodeURIComponent(identity.triggerGeneration);
}

function toGroupConnectTriggerEpochPrefix(groupRef: GroupRef, formationEpoch: number): string {
    if (!Number.isSafeInteger(formationEpoch) || formationEpoch < 0) {
        throw new TypeError('Connect trigger epoch must be a non-negative safe integer');
    }
    return `${groupStateGroupStorageKey(groupRef)}:epoch=${formationEpoch}:generation=`;
}

export function decodeGroupConnectTriggerLatchRow(
    entry: RuntimeStateEntry,
    identity: GroupConnectTriggerIdentity
): GroupConnectTriggerLatchRow {
    try {
        const value = toExactJsonWireObject(decodeJsonWireValue(JSON.parse(entry.value), 'Connect trigger latch'), [
            'groupRef',
            'formationEpoch',
            'triggerGeneration',
            'state'
        ], 'Connect trigger latch');
        const groupRef = toExactJsonWireObject(
            value.groupRef,
            ['applicationId', 'workspaceId', 'groupId'],
            'Connect trigger scope'
        );
        if (
            entry.key !== toGroupConnectTriggerStorageKey(identity) ||
            serializeCanonicalJson(groupRef) !== serializeCanonicalJson(identity.groupRef) ||
            value.formationEpoch !== identity.formationEpoch ||
            value.triggerGeneration !== identity.triggerGeneration ||
            (value.state !== 'awaiting-publication' && value.state !== 'consumed') ||
            !Number.isSafeInteger(entry.revision) || entry.revision < 0
        ) {
            throw new GroupConnectTriggerLatchCorruptionError(entry.key);
        }
        return { latch: { ...identity, state: value.state }, revision: entry.revision };
    }
    catch {
        throw new GroupConnectTriggerLatchCorruptionError(entry.key);
    }
}

export function toGroupConnectTriggerLatchEffect(
    latch: GroupConnectTriggerLatch,
    expectedRevision: number | null
): RuntimeStateGuardedBatchEffect {
    const value = {
        effectId: 'connect-trigger-latch',
        namespace: GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
        key: toGroupConnectTriggerStorageKey(latch),
        value: serializeCanonicalJson(latch),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
    return expectedRevision === null
        ? { ...value, operation: 'insert' }
        : { ...value, operation: 'update', expectedRevision };
}

function decodeTriggerGeneration(key: string, prefix: string): string {
    try {
        return decodeURIComponent(key.slice(prefix.length));
    }
    catch {
        throw new GroupConnectTriggerLatchCorruptionError(key);
    }
}
