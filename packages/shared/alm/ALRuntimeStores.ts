import type { ALSupersedencePersistenceValue } from '../al-contracts/al-runtime.ts';
import { InMemoryALSupersedenceStore, PersistentALSupersedenceStore, } from '../al-contracts/al-runtime.ts';
import { IndexedDbStringPersistenceProvider } from '../persistence/IndexedDbStringPersistenceProvider.ts';
import type { ALInboundRuntimeStores } from './ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from './ALOutboundMessageRuntime.ts';
import { createALInboundAdmissionStore, createInMemoryALInboundAdmissionState, } from './ALInboundAdmissionStore.ts';
import { createALOutboundAdmissionStore, createInMemoryALOutboundAdmissionState, } from './ALOutboundAdmissionStore.ts';
import type { ALRuntimeStoreRetentionConfig } from './ALStoreRetention.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot,
} from './ALRuntimeStateStores.ts';
import { InMemoryALOutboundRuntimeStateStore, PersistentALOutboundRuntimeStateStore, } from './ALRuntimeStateStores.ts';

export type ALRuntimeStoreFactoryOptions = Readonly<{
    namespace?: string;
    dbName?: string;
    orderingTrackTtlMs?: number;
    supersedenceTrackTtlMs?: number;
    retention?: ALRuntimeStoreRetentionConfig;
}>;

const DEFAULT_NAMESPACE = 'al-runtime';

export function createInMemoryALInboundRuntimeStores(
    options: ALRuntimeStoreFactoryOptions = {},
): ALInboundRuntimeStores {
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    return {
        admissionStore: createALInboundAdmissionStore({
            kind: 'memory',
            namespace: `${namespace}:inbound:admission`,
            orderingTrackTtlMs: options.orderingTrackTtlMs ?? 5 * 60_000,
            supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
            retention: options.retention,
            state: createInMemoryALInboundAdmissionState(),
        }),
    };
}

export function createInMemoryALOutboundRuntimeStores(
    options: ALRuntimeStoreFactoryOptions = {},
): ALOutboundRuntimeStores {
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    return {
        admissionStore: createALOutboundAdmissionStore({
            kind: 'memory',
            namespace: `${namespace}:outbound:admission`,
            supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
            retention: options.retention,
            state: createInMemoryALOutboundAdmissionState(),
        }),
        supersedenceStore: new InMemoryALSupersedenceStore(options.supersedenceTrackTtlMs),
        stateStore: new InMemoryALOutboundRuntimeStateStore(),
    };
}

export function createIndexedDbALInboundRuntimeStores(
    options: ALRuntimeStoreFactoryOptions = {},
): ALInboundRuntimeStores {
    const prefix = options.namespace ?? DEFAULT_NAMESPACE;
    const dbName = options.dbName;

    return {
        admissionStore: createALInboundAdmissionStore({
            kind: 'indexeddb',
            namespace: `${prefix}:inbound:admission`,
            dbName,
            orderingTrackTtlMs: options.orderingTrackTtlMs ?? 5 * 60_000,
            supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
            retention: options.retention,
        }),
    };
}

export function createIndexedDbALOutboundRuntimeStores(
    options: ALRuntimeStoreFactoryOptions = {},
): ALOutboundRuntimeStores {
    const prefix = options.namespace ?? DEFAULT_NAMESPACE;
    const dbName = options.dbName;

    return {
        admissionStore: createALOutboundAdmissionStore({
            kind: 'indexeddb',
            namespace: `${prefix}:outbound:admission`,
            dbName,
            supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
            retention: options.retention,
        }),
        supersedenceStore: new PersistentALSupersedenceStore(
            new IndexedDbStringPersistenceProvider<ALSupersedencePersistenceValue>({
                dbName,
                keyPrefix: `${prefix}:outbound:supersedence`,
            }),
            options.supersedenceTrackTtlMs,
        ),
        stateStore: new PersistentALOutboundRuntimeStateStore(
            new IndexedDbStringPersistenceProvider<ALOutboundSentMessageSnapshot>({
                dbName,
                keyPrefix: `${prefix}:outbound:sent`,
            }),
            new IndexedDbStringPersistenceProvider<ALOutboundPendingAckSnapshot>({
                dbName,
                keyPrefix: `${prefix}:outbound:pending-acks`,
            }),
            new IndexedDbStringPersistenceProvider<ALOutboundRepairAttemptSnapshot>({
                dbName,
                keyPrefix: `${prefix}:outbound:repair-attempts`,
            }),
            options.retention,
        ),
    };
}

export function isIndexedDbALRuntimeStoreSupported(): boolean {
    return IndexedDbStringPersistenceProvider.isSupported();
}
