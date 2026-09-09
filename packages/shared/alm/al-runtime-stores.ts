import { Temporal } from '@js-temporal/polyfill';
import {
    createPassThroughIndexedDbOperationObserver,
    type IndexedDbOperationObserver
} from '../persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '../persistence/indexed-db-string-persistence-provider.ts';
import { InMemoryQueueBox } from '../queuebox/in-memory-queue-box.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend
} from './al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from './al-admission-work-backend.ts';
import type { ALRuntimeStoreRetentionConfig } from './ALStoreRetention.ts';
import { normalizeALRuntimeStoreRetention } from './ALStoreRetention.ts';
import { createALInboundAdmissionStore } from './inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from './inbound/al-inbound-message-runtime.ts';
import { IndexedDbAdmissionBackend } from './indexed-db-admission-backend.ts';

import { createALOutboundAdmissionStore } from './outbound/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from './outbound/al-outbound-message-runtime.ts';

export interface CreateInMemoryALRuntimeStoresInput {
    readonly nowMs: () => number;
    readonly namespace: string;
    readonly canonicalScope?: string;
    readonly outboundBackend?: ALAdmissionWorkBackend;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: ALRuntimeStoreRetentionConfig | undefined;
}

export interface CreateIndexedDbALRuntimeStoresInput extends CreateInMemoryALRuntimeStoresInput {
    readonly dbName: string | undefined;
    readonly observer: IndexedDbOperationObserver;
}

export interface CreateDefaultALRuntimeStoresInput {
    readonly nowMs?: () => number;
    readonly namespace?: string;
    readonly canonicalScope?: string;
    readonly outboundBackend?: ALAdmissionWorkBackend;
    readonly dbName?: string;
    readonly orderingTrackTtlMs?: number;
    readonly supersedenceTrackTtlMs?: number;
    readonly retention?: ALRuntimeStoreRetentionConfig;
    readonly observer?: IndexedDbOperationObserver;
}

const DEFAULT_NAMESPACE = 'al-runtime';
const DEFAULT_INDEXED_DB_NAME = 'rallar-al-runtime';

export function createInMemoryALInboundRuntimeStores(
    input: CreateInMemoryALRuntimeStoresInput
): ALInboundRuntimeStores {
    return {
        admissionStore: createALInboundAdmissionStore({
            nowMs: input.nowMs,
            namespace: `${input.namespace}:inbound:admission`,
            backend: new InMemoryAdmissionBackend(
                createInMemoryALAdmissionState(
                    new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(input.nowMs()))
                ),
                input.nowMs
            ),
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
            nowMs: input.nowMs,
            namespace: `${input.namespace}:outbound:admission`,
            canonicalScope: input.canonicalScope ?? input.namespace,
            backend: input.outboundBackend ??
                new InMemoryAdmissionBackend(
                    createInMemoryALAdmissionState(
                        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(input.nowMs()))
                    ),
                    input.nowMs
                ),
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
            nowMs: input.nowMs,
            namespace: `${input.namespace}:inbound:admission`,
            backend: new IndexedDbAdmissionBackend({
                dbName: input.dbName ?? DEFAULT_INDEXED_DB_NAME,
                storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
                nowMs: input.nowMs,
                newWriteToken: crypto.randomUUID.bind(crypto),
                observer: input.observer
            }),
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
            nowMs: input.nowMs,
            namespace: `${input.namespace}:outbound:admission`,
            canonicalScope: input.canonicalScope ?? input.namespace,
            backend: input.outboundBackend ??
                new IndexedDbAdmissionBackend({
                    dbName: input.dbName ?? DEFAULT_INDEXED_DB_NAME,
                    storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
                    nowMs: input.nowMs,
                    newWriteToken: crypto.randomUUID.bind(crypto),
                    observer: input.observer
                }),
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
        nowMs: options.nowMs ?? Date.now,
        namespace: options.namespace ?? DEFAULT_NAMESPACE,
        canonicalScope: options.canonicalScope,
        outboundBackend: options.outboundBackend,
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
        dbName: options.dbName,
        observer: options.observer ?? createPassThroughIndexedDbOperationObserver()
    };
}
