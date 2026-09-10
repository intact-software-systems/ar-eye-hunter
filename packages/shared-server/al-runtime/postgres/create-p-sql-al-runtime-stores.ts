import {
    configureALRuntimeStoreScopes,
    resolveALInboundRuntimeStores,
    resolveALOutboundRuntimeStores,
    type ALRuntimeStoreFactories
} from '@shared/alm/ALRuntimeStoreRegistry.ts';
import type { ALRuntimeStoreRetentionConfig } from '@shared/alm/ALStoreRetention.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundPreparedMessageDecoder
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import type { PSqlRuntimeStateRepository } from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { PSqlAdmissionWorkBackend } from './p-sql-admission-work-backend.ts';

export interface CreatePSqlALRuntimeStoresInput {
    readonly repository: PSqlRuntimeStateRepository;
    readonly namespace: string;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: ALRuntimeStoreRetentionConfig | undefined;
}

export interface CreatePSqlALOutboundRuntimeStoresInput<TPrepared> extends CreatePSqlALRuntimeStoresInput {
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
}

export interface CreateDefaultPSqlALRuntimeStoresInput {
    readonly repository: PSqlRuntimeStateRepository;
    readonly namespace?: string;
    readonly orderingTrackTtlMs?: number;
    readonly supersedenceTrackTtlMs?: number;
    readonly retention?: ALRuntimeStoreRetentionConfig;
}

export interface CreateDefaultPSqlALOutboundRuntimeStoresInput<TPrepared>
    extends CreateDefaultPSqlALRuntimeStoresInput {
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
}

const DEFAULT_NAMESPACE = 'al-runtime';

export function toServerWsQBoxALRuntimeStoreId(name: string): string {
    return `server-ws-qbox:${name}`;
}

function createPSqlRuntimeStoreFactories(
    runtimeStoreId: string,
    options: CreateDefaultPSqlALOutboundRuntimeStoresInput<WsQueueBoxServerPreparedMessage>
): ALRuntimeStoreFactories<WsQueueBoxServerPreparedMessage> {
    const scopedOptions = {
        ...options,
        namespace: options.namespace ?? runtimeStoreId
    };

    return {
        createInboundStores: () => createDefaultPSqlALInboundRuntimeStores(scopedOptions),
        createOutboundStores: () => createDefaultPSqlALOutboundRuntimeStores(scopedOptions)
    };
}

export function createPSqlALInboundRuntimeStores(
    input: CreatePSqlALRuntimeStoresInput
): ALInboundRuntimeStores {
    const namespace = `${input.namespace}:inbound:admission`;
    const backend = new PSqlAdmissionWorkBackend(input.repository.sql, namespace);
    return {
        admissionStore: createALInboundAdmissionStore({
            nowMs: Date.now,
            namespace,
            backend,
            orderingTrackTtlMs: input.orderingTrackTtlMs,
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention)
        }),
        workQueue: backend.workQueue
    };
}

export function createPSqlALOutboundRuntimeStores<TPrepared>(
    input: CreatePSqlALOutboundRuntimeStoresInput<TPrepared>
): ALOutboundRuntimeStores<TPrepared> {
    const namespace = `${input.namespace}:outbound:admission`;
    const backend = new PSqlAdmissionWorkBackend(input.repository.sql, namespace);
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: Date.now,
            namespace,
            canonicalScope: namespace,
            backend,
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention),
            decodePrepared: input.decodePrepared
        }),
        workQueue: backend.workQueue
    };
}

export function createDefaultPSqlALInboundRuntimeStores(
    options: CreateDefaultPSqlALRuntimeStoresInput
): ALInboundRuntimeStores {
    return createPSqlALInboundRuntimeStores(toDefaultPSqlALRuntimeStoresInput(options));
}

export function createDefaultPSqlALOutboundRuntimeStores<TPrepared>(
    options: CreateDefaultPSqlALOutboundRuntimeStoresInput<TPrepared>
): ALOutboundRuntimeStores<TPrepared> {
    return createPSqlALOutboundRuntimeStores({
        ...toDefaultPSqlALRuntimeStoresInput(options),
        decodePrepared: options.decodePrepared
    });
}

export function configureServerWsQBoxALRuntimeStores(
    name: string,
    options: CreateDefaultPSqlALRuntimeStoresInput
): void {
    const runtimeStoreId = toServerWsQBoxALRuntimeStoreId(name);
    configureALRuntimeStoreScopes([
        {
            id: runtimeStoreId,
            factories: createPSqlRuntimeStoreFactories(runtimeStoreId, {
                ...options,
                decodePrepared: decodeWsQueueBoxServerPreparedMessage
            })
        }
    ]);
}

export function resolveServerWsQBoxALInboundRuntimeStores(name: string): ALInboundRuntimeStores {
    return resolveALInboundRuntimeStores(toServerWsQBoxALRuntimeStoreId(name));
}

export function resolveServerWsQBoxALOutboundRuntimeStores(
    name: string
): ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage> {
    return resolveALOutboundRuntimeStores(toServerWsQBoxALRuntimeStoreId(name));
}

function toDefaultPSqlALRuntimeStoresInput(
    options: CreateDefaultPSqlALRuntimeStoresInput
): CreatePSqlALRuntimeStoresInput {
    return {
        repository: options.repository,
        namespace: options.namespace ?? DEFAULT_NAMESPACE,
        orderingTrackTtlMs: options.orderingTrackTtlMs ?? 5 * 60_000,
        supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
        retention: options.retention
    };
}
