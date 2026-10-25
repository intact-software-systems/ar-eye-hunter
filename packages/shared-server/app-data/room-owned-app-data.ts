import type { GroupRef, GroupScope } from '@shared/api/group-types.ts';

import type { PSqlSql } from '../postgres/p-sql-sql.ts';
import {
    requireEpoch,
    requireExactKeys,
    requirePositiveInteger,
    requireRecord,
    requireString
} from '../rallar-system/protocol/exact-object-decoding.ts';
import {
    serializeCanonicalMutationCommand,
    type JsonWireValue
} from '../rallar-system/protocol/json-wire-identity.ts';
import { RuntimeStateWriteConflictError } from '../runtime-state/optimistic-runtime-state-write.ts';
import type {
    AppDataEntry,
    AppDataKey,
    AppDataRepository
} from './app-data-repository.ts';

export namespace RoomOwnedAppData {
    /** One scope owns one store whose exact keys are room IDs. Stores cannot be shared between scopes. */
    export interface Binding extends GroupScope {
        readonly namespace: string;
        readonly storeName: string;
    }

    export interface Read {
        readonly key: AppDataKey;
        readonly entry: AppDataEntry | null;
    }

    export interface SaveInput {
        readonly read: Read;
        readonly value: JsonWireValue;
        readonly schemaVersion: number;
        readonly expireAtTimestamp: number;
    }

    /** Persistence-ready values; serialization and expiry validation happen before transaction entry. */
    export type Write =
        | Readonly<{ operation: 'delete'; key: AppDataKey; expectedRevision: number; }>
        | Readonly<{
            operation: 'save';
            key: AppDataKey;
            expectedRevision: number | null;
            valueJson: string;
            schemaVersion: number;
            expireAtIso: string;
        }>;
}

/** Exact, uncached room-owned save reads. The caller's group CAS fences both saving and deletion. */
export class RoomOwnedAppData {
    private readonly repository: Pick<AppDataRepository, 'findEntry'>;
    private readonly bindings: readonly RoomOwnedAppData.Binding[];

    constructor(repository: Pick<AppDataRepository, 'findEntry'>, bindings: readonly RoomOwnedAppData.Binding[]) {
        this.bindings = decodeRoomOwnedAppDataBindings(bindings);
        this.repository = repository;
    }

    async read(ref: GroupRef): Promise<readonly RoomOwnedAppData.Read[]> {
        requireString(ref.groupId, 'Room-owned data room');
        return await Promise.all(
            this.bindings.filter((binding) =>
                binding.applicationId === ref.applicationId && binding.workspaceId === ref.workspaceId
            ).map(async (binding) => {
                const key = { namespace: binding.namespace, storeName: binding.storeName, key: ref.groupId };
                const observed = { key, entry: await this.repository.findEntry(key) ?? null };
                assertObservedSave(observed);
                return observed;
            })
        );
    }
}

export function decodeRoomOwnedAppDataBindings(value: unknown): readonly RoomOwnedAppData.Binding[] {
    if (!Array.isArray(value)) {
        throw new TypeError('Room-owned data requires an explicit complete binding array');
    }
    const stores = new Set<string>();
    return Object.freeze(value.map((raw) => {
        const binding = requireRecord(raw, 'Room-owned data binding');
        requireExactKeys(
            binding,
            ['applicationId', 'workspaceId', 'namespace', 'storeName'],
            'Room-owned data binding'
        );
        requireString(binding.applicationId, 'Room-owned data application');
        requireString(binding.workspaceId, 'Room-owned data workspace');
        requireString(binding.namespace, 'Room-owned data namespace');
        requireString(binding.storeName, 'Room-owned data store');
        const store = JSON.stringify([binding.namespace, binding.storeName]);
        if (stores.has(store)) {
            throw new TypeError('A room-owned data store must have exactly one scope owner');
        }
        stores.add(store);
        const decoded = {
            applicationId: binding.applicationId,
            workspaceId: binding.workspaceId,
            namespace: binding.namespace,
            storeName: binding.storeName
        };
        if (Object.values(decoded).some((part) => part.trim() !== part)) {
            throw new TypeError('Room-owned data identities must not have surrounding whitespace');
        }
        return Object.freeze(decoded);
    }));
}

export function computeRoomOwnedAppDataSave({
    read,
    value,
    schemaVersion,
    expireAtTimestamp
}: RoomOwnedAppData.SaveInput): RoomOwnedAppData.Write {
    assertObservedSave(read);
    requirePositiveInteger(schemaVersion, 'Room-owned data schema version');
    requireEpoch(expireAtTimestamp, 'Room-owned data expiry');
    return {
        operation: 'save',
        key: { ...read.key },
        expectedRevision: read.entry?.revision ?? null,
        valueJson: serializeCanonicalMutationCommand(value),
        schemaVersion,
        expireAtIso: new Date(expireAtTimestamp).toISOString()
    };
}

export function computeRoomOwnedAppDataDelete(read: RoomOwnedAppData.Read): RoomOwnedAppData.Write | null {
    assertObservedSave(read);
    return read.entry === null ? null : {
        operation: 'delete',
        key: { ...read.key },
        expectedRevision: read.entry.revision
    };
}

/** The owner must first win its group revision fence in this same transaction. Conflicts are retried by AppInbox. */
export async function writeRoomOwnedAppData(transaction: PSqlSql, write: RoomOwnedAppData.Write): Promise<void> {
    const key = write.key;
    if (write.operation === 'delete') {
        const deleted = await transaction<{ data_key: string; }[]>`
            delete from app_data_store
            where app_namespace = ${key.namespace} and store_name = ${key.storeName}
              and data_key = ${key.key} and revision = ${write.expectedRevision}
            returning data_key
        `;
        if (deleted.length !== 1) {
            throw new RuntimeStateWriteConflictError();
        }
        return;
    }
    if (write.expectedRevision === null) {
        const inserted = await transaction<{ data_key: string; }[]>`
            insert into app_data_store
                (app_namespace, store_name, data_key, data_value, schema_version, expire_at_ts, updated_ts, revision)
            values (${key.namespace}, ${key.storeName}, ${key.key}, ${write.valueJson}, ${write.schemaVersion},
                    ${write.expireAtIso}::timestamptz, now(), 0)
            on conflict (app_namespace, store_name, data_key) do nothing
            returning data_key
        `;
        if (inserted.length !== 1) {
            throw new RuntimeStateWriteConflictError();
        }
        return;
    }
    const updated = await transaction<{ data_key: string; }[]>`
        update app_data_store
        set data_value = ${write.valueJson}, schema_version = ${write.schemaVersion},
            expire_at_ts = ${write.expireAtIso}::timestamptz, updated_ts = now(), revision = revision + 1
        where app_namespace = ${key.namespace} and store_name = ${key.storeName}
          and data_key = ${key.key} and revision = ${write.expectedRevision}
        returning data_key
    `;
    if (updated.length !== 1) {
        throw new RuntimeStateWriteConflictError();
    }
}

function assertObservedSave(read: RoomOwnedAppData.Read): void {
    requireString(read.key.namespace, 'Room-owned data namespace');
    requireString(read.key.storeName, 'Room-owned data store');
    requireString(read.key.key, 'Room-owned data key');
    const stored = read.entry;
    if (stored === null) {
        return;
    }
    if (
        stored.namespace !== read.key.namespace || stored.storeName !== read.key.storeName ||
        stored.key !== read.key.key
    ) {
        throw new TypeError('Room-owned data identity differs from its requested slot');
    }
    if (!Number.isSafeInteger(stored.revision) || stored.revision < 0) {
        throw new TypeError('Room-owned data revision must be a nonnegative safe integer');
    }
}
