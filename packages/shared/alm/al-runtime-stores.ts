import { IndexedDbStringPersistenceProvider } from '../persistence/IndexedDbStringPersistenceProvider.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend
} from './al-admission-backend.ts';
import type { ALRuntimeStoreRetentionConfig } from './ALStoreRetention.ts';
import { normalizeALRuntimeStoreRetention } from './ALStoreRetention.ts';
import { createALInboundAdmissionStore } from './inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from './inbound/al-inbound-message-runtime.ts';
import { IndexedDbAdmissionBackend } from './indexed-db-admission-backend.ts';

import { createALOutboundAdmissionStore } from './outbound/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from './outbound/al-outbound-message-runtime.ts';

export interface CreateInMemoryALRuntimeStoresInput {
    readonly namespace: string;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: ALRuntimeStoreRetentionConfig | undefined;
}

export interface CreateIndexedDbALRuntimeStoresInput extends CreateInMemoryALRuntimeStoresInput {
    readonly dbName: string | undefined;
}

export interface CreateDefaultALRuntimeStoresInput {
    readonly namespace?: string;
    readonly dbName?: string;
    readonly orderingTrackTtlMs?: number;
    readonly supersedenceTrackTtlMs?: number;
    readonly retention?: ALRuntimeStoreRetentionConfig;
}

const DEFAULT_NAMESPACE = 'al-runtime';

export function createInMemoryALInboundRuntimeStores(
    input: CreateInMemoryALRuntimeStoresInput
): ALInboundRuntimeStores {
    return {
        admissionStore: createALInboundAdmissionStore({
            namespace: `${input.namespace}:inbound:admission`,
            backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now),
            orderingTrackTtlMs: input.orderingTrackTtlMs,
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention)
        })
    };
}

export function createInMemoryALOutboundRuntimeStores(
    input: CreateInMemoryALRuntimeStoresInput
): ALOutboundRuntimeStores {
    return {
        admissionStore: createALOutboundAdmissionStore({
            namespace: `${input.namespace}:outbound:admission`,
            backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now),
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention)
        })
    };
}

export function createIndexedDbALInboundRuntimeStores(
    input: CreateIndexedDbALRuntimeStoresInput
): ALInboundRuntimeStores {
    return {
        admissionStore: createALInboundAdmissionStore({
            namespace: `${input.namespace}:inbound:admission`,
            backend: new IndexedDbAdmissionBackend(
                input.dbName ?? IndexedDbStringPersistenceProvider.DEFAULT_DB_NAME,
                IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
                Date.now
            ),
            orderingTrackTtlMs: input.orderingTrackTtlMs,
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention)
        })
    };
}

export function createIndexedDbALOutboundRuntimeStores(
    input: CreateIndexedDbALRuntimeStoresInput
): ALOutboundRuntimeStores {
    return {
        admissionStore: createALOutboundAdmissionStore({
            namespace: `${input.namespace}:outbound:admission`,
            backend: new IndexedDbAdmissionBackend(
                input.dbName ?? IndexedDbStringPersistenceProvider.DEFAULT_DB_NAME,
                IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
                Date.now
            ),
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention)
        })
    };
}

export function createDefaultInMemoryALInboundRuntimeStores(
    options: CreateDefaultALRuntimeStoresInput = {}
): ALInboundRuntimeStores {
    return createInMemoryALInboundRuntimeStores(toDefaultInMemoryInput(options));
}

export function createDefaultInMemoryALOutboundRuntimeStores(
    options: CreateDefaultALRuntimeStoresInput = {}
): ALOutboundRuntimeStores {
    return createInMemoryALOutboundRuntimeStores(toDefaultInMemoryInput(options));
}

export function createDefaultIndexedDbALInboundRuntimeStores(
    options: CreateDefaultALRuntimeStoresInput = {}
): ALInboundRuntimeStores {
    return createIndexedDbALInboundRuntimeStores(toDefaultIndexedDbInput(options));
}

export function createDefaultIndexedDbALOutboundRuntimeStores(
    options: CreateDefaultALRuntimeStoresInput = {}
): ALOutboundRuntimeStores {
    return createIndexedDbALOutboundRuntimeStores(toDefaultIndexedDbInput(options));
}

export function isIndexedDbALRuntimeStoreSupported(): boolean {
    return IndexedDbStringPersistenceProvider.isSupported();
}

function toDefaultInMemoryInput(
    options: CreateDefaultALRuntimeStoresInput
): CreateInMemoryALRuntimeStoresInput {
    return {
        namespace: options.namespace ?? DEFAULT_NAMESPACE,
        orderingTrackTtlMs: options.orderingTrackTtlMs ?? 5 * 60_000,
        supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
        retention: options.retention
    };
}

function toDefaultIndexedDbInput(
    options: CreateDefaultALRuntimeStoresInput
): CreateIndexedDbALRuntimeStoresInput {
    return {
        ...toDefaultInMemoryInput(options),
        dbName: options.dbName
    };
}
