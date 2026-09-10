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
import {
    AL_ADMISSION_SCHEMA_ID,
    createPassThroughALStorageResetSink,
    type ALStorageResetEvent
} from './open-indexed-db-admission-database.ts';

import {
    createALOutboundAdmissionStore,
    type ALOutboundPreparedMessageDecoder
} from './outbound/al-outbound-admission-store.ts';
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

export interface CreateInMemoryALOutboundRuntimeStoresInput<TPrepared> extends CreateInMemoryALRuntimeStoresInput {
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
}

export interface CreateIndexedDbALRuntimeStoresInput extends CreateInMemoryALRuntimeStoresInput {
    readonly dbName: string | undefined;
    readonly observer: IndexedDbOperationObserver;
    readonly schemaId: string;
    readonly onStorageReset: (event: ALStorageResetEvent) => void;
}

export interface CreateIndexedDbALOutboundRuntimeStoresInput<TPrepared> extends CreateIndexedDbALRuntimeStoresInput {
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
}

export interface CreateDefaultALOutboundRuntimeStoresInput<TPrepared> extends CreateDefaultALRuntimeStoresInput {
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
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
    readonly schemaId?: string;
    readonly onStorageReset?: (event: ALStorageResetEvent) => void;
}

const DEFAULT_NAMESPACE = 'al-runtime';
const DEFAULT_INDEXED_DB_NAME = 'rallar-al-runtime';

export function createInMemoryALInboundRuntimeStores(
    input: CreateInMemoryALRuntimeStoresInput
): ALInboundRuntimeStores {
    const backend = new InMemoryAdmissionBackend(
        createInMemoryALAdmissionState(
            new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(input.nowMs()))
        ),
        input.nowMs
    );
    return {
        admissionStore: createALInboundAdmissionStore({
            nowMs: input.nowMs,
            namespace: `${input.namespace}:inbound:admission`,
            backend,
            orderingTrackTtlMs: input.orderingTrackTtlMs,
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention)
        }),
        workQueue: backend.workQueue
    };
}

export function createInMemoryALOutboundRuntimeStores<TPrepared>(
    input: CreateInMemoryALOutboundRuntimeStoresInput<TPrepared>
): ALOutboundRuntimeStores<TPrepared> {
    const backend = input.outboundBackend ??
        new InMemoryAdmissionBackend(
            createInMemoryALAdmissionState(
                new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(input.nowMs()))
            ),
            input.nowMs
        );
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: input.nowMs,
            namespace: `${input.namespace}:outbound:admission`,
            canonicalScope: input.canonicalScope ?? input.namespace,
            backend,
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention),
            decodePrepared: input.decodePrepared
        }),
        workQueue: backend.workQueue
    };
}

export function createIndexedDbALInboundRuntimeStores(
    input: CreateIndexedDbALRuntimeStoresInput
): ALInboundRuntimeStores {
    const backend = new IndexedDbAdmissionBackend({
        dbName: input.dbName ?? DEFAULT_INDEXED_DB_NAME,
        storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
        nowMs: input.nowMs,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: input.observer,
        schemaId: input.schemaId,
        onStorageReset: input.onStorageReset
    });
    return {
        admissionStore: createALInboundAdmissionStore({
            nowMs: input.nowMs,
            namespace: `${input.namespace}:inbound:admission`,
            backend,
            orderingTrackTtlMs: input.orderingTrackTtlMs,
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention)
        }),
        workQueue: backend.workQueue
    };
}

export function createIndexedDbALOutboundRuntimeStores<TPrepared>(
    input: CreateIndexedDbALOutboundRuntimeStoresInput<TPrepared>
): ALOutboundRuntimeStores<TPrepared> {
    const backend = input.outboundBackend ??
        new IndexedDbAdmissionBackend({
            dbName: input.dbName ?? DEFAULT_INDEXED_DB_NAME,
            storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
            nowMs: input.nowMs,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: input.observer,
            schemaId: input.schemaId,
            onStorageReset: input.onStorageReset
        });
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: input.nowMs,
            namespace: `${input.namespace}:outbound:admission`,
            canonicalScope: input.canonicalScope ?? input.namespace,
            backend,
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention),
            decodePrepared: input.decodePrepared
        }),
        workQueue: backend.workQueue
    };
}

export function createDefaultInMemoryALInboundRuntimeStores(
    options: CreateDefaultALRuntimeStoresInput = {}
): ALInboundRuntimeStores {
    return createInMemoryALInboundRuntimeStores(toDefaultInMemoryInput(options));
}

export function createDefaultInMemoryALOutboundRuntimeStores<TPrepared>(
    options: CreateDefaultALOutboundRuntimeStoresInput<TPrepared>
): ALOutboundRuntimeStores<TPrepared> {
    return createInMemoryALOutboundRuntimeStores({
        ...toDefaultInMemoryInput(options),
        decodePrepared: options.decodePrepared
    });
}

export function createDefaultIndexedDbALInboundRuntimeStores(
    options: CreateDefaultALRuntimeStoresInput = {}
): ALInboundRuntimeStores {
    return createIndexedDbALInboundRuntimeStores(toDefaultIndexedDbInput(options));
}

export function createDefaultIndexedDbALOutboundRuntimeStores<TPrepared>(
    options: CreateDefaultALOutboundRuntimeStoresInput<TPrepared>
): ALOutboundRuntimeStores<TPrepared> {
    return createIndexedDbALOutboundRuntimeStores({
        ...toDefaultIndexedDbInput(options),
        decodePrepared: options.decodePrepared
    });
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
        observer: options.observer ?? createPassThroughIndexedDbOperationObserver(),
        schemaId: options.schemaId ?? AL_ADMISSION_SCHEMA_ID,
        onStorageReset: options.onStorageReset ?? createPassThroughALStorageResetSink()
    };
}
