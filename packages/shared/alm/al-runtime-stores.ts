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
import { DEFAULT_AL_REPOSITORY_TTL_MS, normalizeALRuntimeStoreRetention } from './ALStoreRetention.ts';
import type { ALCheckpointWriter } from './checkpoint/al-checkpoint-writer.ts';
import { ALCheckpoint, type ALCheckpointStorage } from './checkpoint/al-checkpoint.ts';
import {
    createALInboundAdmissionStore,
    createVolatileALInboundAdmissionStore,
    type CreateALInboundAdmissionStoreInput
} from './inbound/al-inbound-admission-store.ts';
import type {
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from './inbound/al-inbound-message-runtime.ts';
import { IndexedDbAdmissionBackend } from './indexed-db-admission-backend.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    ALStorageResetListeners,
    createPassThroughALStorageResetSink,
    type ALStorageResetEvent
} from './open-indexed-db-admission-database.ts';

import {
    createALOutboundAdmissionStore,
    createVolatileALOutboundAdmissionStore,
    type ALOutboundPreparedMessageDecoder,
    type CreateALOutboundAdmissionStoreInput
} from './outbound/admission/al-outbound-admission-store.ts';
import type {
    ALCheckpointOutboundRuntimeStores,
    ALOutboundRuntimeStores,
    ALVolatileOutboundRuntimeStores
} from './outbound/al-outbound-message-runtime.ts';
import type { ALStorageConnectOpenings } from './storage/al-storage-connect-openings.ts';
import { createPassThroughALStorageEventSink } from './storage/al-storage-event.ts';
import { ALStorageHealth } from './storage/al-storage-health.ts';
import {
    createALStorageRecoveryReporter,
    type ALStorageRecoveryLane,
    type ALStorageRecoveryReporter
} from './storage/al-storage-recovery-reporter.ts';
import type { ALVolatileSessionBudget } from './volatile-budget/al-volatile-session-budget.ts';
import type { ALDurableWorkOwnership } from './work/al-durable-work-ownership.ts';

/**
 * Which store pair of a runtime a lane runs over: the IndexedDB pair (`durable`), the session's memory
 * pair (`volatile`), or a memory pair whose rows a checkpoint copies to IndexedDB (`checkpoint`). A lane
 * names it on every diagnostic it states, so a reader of storage timings can keep them apart; the WS
 * server's single-lane runtime is always `durable`.
 */
export type ALStoreDurability = 'volatile' | 'checkpoint' | 'durable';

export interface CreateInMemoryALRuntimeStoresInput {
    readonly nowMs: () => number;
    readonly namespace: string;
    readonly canonicalScope?: string;
    /** Absent, each inbound resolve builds its own backend; present, every resolve shares it. */
    readonly inboundBackend?: ALAdmissionWorkBackend;
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
    /** The health the pair's lanes record into; `undefined` when no one reads it. */
    readonly storageHealth: ALStorageHealth | undefined;
    /** The openings of the connect whose stores share the database; `undefined` for a pair of no connect. */
    readonly connectOpenings: ALStorageConnectOpenings | undefined;
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
    /** Absent, each inbound resolve builds its own backend; present, every resolve shares it. */
    readonly inboundBackend?: ALAdmissionWorkBackend;
    readonly outboundBackend?: ALAdmissionWorkBackend;
    readonly dbName?: string;
    readonly orderingTrackTtlMs?: number;
    readonly supersedenceTrackTtlMs?: number;
    readonly retention?: ALRuntimeStoreRetentionConfig;
    readonly observer?: IndexedDbOperationObserver;
    readonly schemaId?: string;
    readonly onStorageReset?: (event: ALStorageResetEvent) => void;
    readonly storageHealth?: ALStorageHealth;
    readonly connectOpenings?: ALStorageConnectOpenings;
}

const DEFAULT_NAMESPACE = 'al-runtime';
const DEFAULT_INDEXED_DB_NAME = 'rallar-al-runtime';

export function createInMemoryALInboundRuntimeStores(
    input: CreateInMemoryALRuntimeStoresInput
): ALInboundRuntimeStores {
    const backend = input.inboundBackend ??
        new InMemoryAdmissionBackend(
            createInMemoryALAdmissionState(
                new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(input.nowMs()))
            ),
            input.nowMs
        );
    return {
        admissionStore: createALInboundAdmissionStore(toInMemoryALInboundAdmissionStoreInput(input, backend)),
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
        admissionStore: createALOutboundAdmissionStore(toInMemoryALOutboundAdmissionStoreInput(input, backend)),
        workQueue: backend.workQueue
    };
}

export function createIndexedDbALInboundRuntimeStores(
    input: CreateIndexedDbALRuntimeStoresInput
): ALInboundRuntimeStores {
    if (input.inboundBackend !== undefined) {
        return toIndexedDbALInboundRuntimeStores(input, input.inboundBackend, undefined);
    }
    const backend = createIndexedDbAdmissionBackend(input, `${input.namespace}:inbound`, input.onStorageReset);
    const storageHealth = input.storageHealth;
    const createStorageRecovery = storageHealth === undefined
        ? undefined
        : (lane: ALStorageRecoveryLane) =>
            createALStorageRecoveryReporter({
                getStorageOpening: () => backend.getStorageOpening(),
                getReservationExpiredDeleteCount: () =>
                    backend.workQueue.getReservationExpiredDeleteCount(lane.workTypeId),
                storageHealth,
                lane: lane.name
            });
    return toIndexedDbALInboundRuntimeStores(input, backend, createStorageRecovery);
}

export function createIndexedDbALOutboundRuntimeStores<TPrepared>(
    input: CreateIndexedDbALOutboundRuntimeStoresInput<TPrepared>
): ALOutboundRuntimeStores<TPrepared> {
    // Only a backend this factory opens reports its resets and its recovery here; a supplied one reports to its opener.
    if (input.outboundBackend !== undefined) {
        return toIndexedDbALOutboundRuntimeStores(input, input.outboundBackend, {
            storageResets: undefined,
            storageRecovery: undefined
        });
    }
    const storageResets = new ALStorageResetListeners();
    const backend = createIndexedDbAdmissionBackend(input, `${input.namespace}:outbound`, (event) => {
        storageResets.notify(event);
        input.onStorageReset(event);
    });
    const storageHealth = input.storageHealth;
    const storageRecovery = storageHealth === undefined ? undefined : createALStorageRecoveryReporter({
        getStorageOpening: () => backend.getStorageOpening(),
        getReservationExpiredDeleteCount: () => backend.workQueue.getReservationExpiredDeleteCount(undefined),
        storageHealth,
        lane: undefined
    });
    return toIndexedDbALOutboundRuntimeStores(input, backend, { storageResets, storageRecovery });
}

function createIndexedDbAdmissionBackend(
    input: CreateIndexedDbALRuntimeStoresInput,
    storeNamespace: string,
    onStorageReset: (event: ALStorageResetEvent) => void
): IndexedDbAdmissionBackend {
    return new IndexedDbAdmissionBackend({
        dbName: input.dbName ?? DEFAULT_INDEXED_DB_NAME,
        storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
        nowMs: input.nowMs,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: input.observer,
        schemaId: input.schemaId,
        onStorageReset,
        connectOpening: input.connectOpenings === undefined
            ? undefined
            : { openings: input.connectOpenings, storeNamespace }
    });
}

function toIndexedDbALInboundRuntimeStores(
    input: CreateIndexedDbALRuntimeStoresInput,
    backend: ALAdmissionWorkBackend,
    createStorageRecovery: ((lane: ALStorageRecoveryLane) => ALStorageRecoveryReporter) | undefined
): ALInboundRuntimeStores {
    return {
        storageHealth: input.storageHealth,
        createStorageRecovery,
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

/** The relays a factory-opened pair carries; both absent for a backend its caller opened. */
interface IndexedDbALOutboundRelays {
    readonly storageResets: ALStorageResetListeners | undefined;
    readonly storageRecovery: ALStorageRecoveryReporter | undefined;
}

function toIndexedDbALOutboundRuntimeStores<TPrepared>(
    input: CreateIndexedDbALOutboundRuntimeStoresInput<TPrepared>,
    backend: ALAdmissionWorkBackend,
    relays: IndexedDbALOutboundRelays
): ALOutboundRuntimeStores<TPrepared> {
    return {
        ...relays,
        storageHealth: input.storageHealth,
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

/** The memory pair a browser carrier routes volatile admissions to; it persists nothing. */
export function createVolatileALOutboundRuntimeStores<TPrepared>(
    options: CreateDefaultALOutboundRuntimeStoresInput<TPrepared>,
    budget: ALVolatileSessionBudget | undefined
): ALVolatileOutboundRuntimeStores<TPrepared> {
    const input = { ...toDefaultInMemoryInput(options), decodePrepared: options.decodePrepared };
    const backend = createVolatileALAdmissionBackend(input.nowMs);
    return {
        admissionStore: createVolatileALOutboundAdmissionStore(
            toInMemoryALOutboundAdmissionStoreInput(input, backend),
            'volatile'
        ),
        workQueue: backend.workQueue,
        evictExpired: () => backend.evictExpired(),
        budget
    };
}

export interface CreateCheckpointALOutboundRuntimeStoresInput<TPrepared>
    extends CreateDefaultALOutboundRuntimeStoresInput<TPrepared>, ALCheckpointWriter.Settings {
    /** The connect's claim: only the runtime that owns the session's durable work saves and restores. */
    readonly ownership: ALDurableWorkOwnership;
    readonly timers: ALCheckpointWriter.Timers;
}

/**
 * The memory pair a browser carrier routes checkpointed admissions to, and its checkpoint: the rows a
 * durable pair writes, saved under this pair's own namespace, which is also its canonical scope (two
 * memory pairs never save one row), in the session's database. Built once per connect, under its claim.
 */
export function createCheckpointALOutboundRuntimeStores<TPrepared>(
    options: CreateCheckpointALOutboundRuntimeStoresInput<TPrepared>
): ALCheckpointOutboundRuntimeStores<TPrepared> {
    const defaults = toDefaultInMemoryInput(options);
    const input = { ...defaults, canonicalScope: defaults.namespace, decodePrepared: options.decodePrepared };
    const memory = createVolatileALAdmissionBackend(input.nowMs);
    const admissionStore = createVolatileALOutboundAdmissionStore(
        toInMemoryALOutboundAdmissionStoreInput(input, memory),
        'checkpoint'
    );
    const checkpoint = new ALCheckpoint({
        storage: toALCheckpointStorage(options, memory, admissionStore.namespace),
        ownership: options.ownership,
        nowMs: input.nowMs
    });
    return {
        admissionStore,
        workQueue: memory.workQueue,
        storageRecovery: checkpoint,
        evictExpired: () => memory.evictExpired(),
        checkpoint
    };
}

function toALCheckpointStorage<TPrepared>(
    options: CreateCheckpointALOutboundRuntimeStoresInput<TPrepared>,
    memory: InMemoryAdmissionBackend,
    workNamespace: string
): ALCheckpointStorage {
    const indexedDb = toDefaultIndexedDbInput(options);
    const { namespace } = indexedDb;
    return {
        memory,
        saved: createIndexedDbAdmissionBackend(indexedDb, `${namespace}:checkpoint`, indexedDb.onStorageReset),
        selection: {
            keyPrefix: `${namespace}:`,
            workRanges: { namespacePrefixes: [workNamespace], canonicalScopes: [namespace] }
        },
        health: options.storageHealth ??
            new ALStorageHealth({ storeId: namespace, storage: createPassThroughALStorageEventSink() }),
        settings: { intervalMs: options.intervalMs, lagBoundMs: options.lagBoundMs },
        newWriteToken: crypto.randomUUID.bind(crypto),
        timers: options.timers
    };
}

/** The session's inbound memory pair, shared by both carriers' volatile lanes; it persists nothing. */
export function createVolatileALInboundRuntimeStores(
    options: CreateDefaultALRuntimeStoresInput,
    budget: ALVolatileSessionBudget | undefined
): ALVolatileInboundRuntimeStores {
    const input = toDefaultInMemoryInput(options);
    const backend = createVolatileALAdmissionBackend(input.nowMs);
    return {
        admissionStore: createVolatileALInboundAdmissionStore(toInMemoryALInboundAdmissionStoreInput(input, backend)),
        workQueue: backend.workQueue,
        evictExpired: () => backend.evictExpired(),
        budget
    };
}

function createVolatileALAdmissionBackend(nowMs: () => number): InMemoryAdmissionBackend {
    return new InMemoryAdmissionBackend(
        createInMemoryALAdmissionState(
            new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs()))
        ),
        nowMs
    );
}

function toInMemoryALOutboundAdmissionStoreInput<TPrepared>(
    input: CreateInMemoryALOutboundRuntimeStoresInput<TPrepared>,
    backend: ALAdmissionWorkBackend
): CreateALOutboundAdmissionStoreInput<TPrepared> {
    return {
        nowMs: input.nowMs,
        namespace: `${input.namespace}:outbound:admission`,
        canonicalScope: input.canonicalScope ?? input.namespace,
        backend,
        supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
        retention: normalizeALRuntimeStoreRetention(input.retention),
        decodePrepared: input.decodePrepared
    };
}

function toInMemoryALInboundAdmissionStoreInput(
    input: CreateInMemoryALRuntimeStoresInput,
    backend: ALAdmissionWorkBackend
): CreateALInboundAdmissionStoreInput {
    return {
        nowMs: input.nowMs,
        namespace: `${input.namespace}:inbound:admission`,
        backend,
        orderingTrackTtlMs: input.orderingTrackTtlMs,
        supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
        retention: normalizeALRuntimeStoreRetention(input.retention)
    };
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

function toDefaultInMemoryInput(
    options: CreateDefaultALRuntimeStoresInput
): CreateInMemoryALRuntimeStoresInput {
    return {
        nowMs: options.nowMs ?? Date.now,
        namespace: options.namespace ?? DEFAULT_NAMESPACE,
        canonicalScope: options.canonicalScope,
        inboundBackend: options.inboundBackend,
        outboundBackend: options.outboundBackend,
        // A receiver remembers a track at least as long as its sender keeps the head, or a silence past it reads as
        // a gap the sender can no longer repair.
        orderingTrackTtlMs: options.orderingTrackTtlMs ?? DEFAULT_AL_REPOSITORY_TTL_MS,
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
        onStorageReset: options.onStorageReset ?? createPassThroughALStorageResetSink(),
        storageHealth: options.storageHealth,
        connectOpenings: options.connectOpenings
    };
}
