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
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { PSqlRuntimeStateRepository } from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { PSqlInboundAdmissionBackend } from './p-sql-inbound-admission-backend.ts';
import { PSqlOutboundAdmissionBackend } from './p-sql-outbound-admission-backend.ts';

export interface CreatePSqlALRuntimeStoresInput {
    readonly repository: PSqlRuntimeStateRepository;
    readonly namespace: string;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: ALRuntimeStoreRetentionConfig | undefined;
}

export interface CreateDefaultPSqlALRuntimeStoresInput {
    readonly repository: PSqlRuntimeStateRepository;
    readonly namespace?: string;
    readonly orderingTrackTtlMs?: number;
    readonly supersedenceTrackTtlMs?: number;
    readonly retention?: ALRuntimeStoreRetentionConfig;
}

const DEFAULT_NAMESPACE = 'al-runtime';

type RuntimeStoreDirection = 'inbound' | 'outbound';

export function toServerWsQBoxALRuntimeStoreId(name: string): string {
    return `server-ws-qbox:${name}`;
}

function createPSqlALRuntimeStores(
    direction: 'inbound',
    input: CreatePSqlALRuntimeStoresInput
): ALInboundRuntimeStores;
function createPSqlALRuntimeStores(
    direction: 'outbound',
    input: CreatePSqlALRuntimeStoresInput
): ALOutboundRuntimeStores;
function createPSqlALRuntimeStores(
    direction: RuntimeStoreDirection,
    input: CreatePSqlALRuntimeStoresInput
): ALInboundRuntimeStores | ALOutboundRuntimeStores {
    const { repository, namespace } = input;

    if (direction === 'inbound') {
        return {
            admissionStore: createALInboundAdmissionStore({
                namespace: `${namespace}:inbound:admission`,
                backend: new PSqlInboundAdmissionBackend(
                    repository,
                    `${namespace}:inbound:admission`
                ),
                orderingTrackTtlMs: input.orderingTrackTtlMs,
                supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
                retention: normalizeALRuntimeStoreRetention(input.retention)
            })
        };
    }

    return {
        admissionStore: createALOutboundAdmissionStore({
            namespace: `${namespace}:outbound:admission`,
            backend: new PSqlOutboundAdmissionBackend(
                repository.sql,
                `${namespace}:outbound:admission`
            ),
            supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
            retention: normalizeALRuntimeStoreRetention(input.retention)
        })
    };
}

function createPSqlRuntimeStoreFactories(
    runtimeStoreId: string,
    options: CreateDefaultPSqlALRuntimeStoresInput
): ALRuntimeStoreFactories {
    const scopedOptions = {
        ...options,
        namespace: options.namespace ?? runtimeStoreId
    };

    return {
        createInboundStores: () => createDefaultPSqlALInboundRuntimeStores(scopedOptions),
        createOutboundStores: () => createDefaultPSqlALOutboundRuntimeStores(scopedOptions)
    };
}

function resolveServerWsQBoxALRuntimeStores(
    direction: 'inbound',
    name: string
): ALInboundRuntimeStores;
function resolveServerWsQBoxALRuntimeStores(
    direction: 'outbound',
    name: string
): ALOutboundRuntimeStores;
function resolveServerWsQBoxALRuntimeStores(
    direction: RuntimeStoreDirection,
    name: string
): ALInboundRuntimeStores | ALOutboundRuntimeStores {
    const runtimeStoreId = toServerWsQBoxALRuntimeStoreId(name);

    return direction === 'inbound'
        ? resolveALInboundRuntimeStores(runtimeStoreId)
        : resolveALOutboundRuntimeStores(runtimeStoreId);
}

export function createPSqlALInboundRuntimeStores(
    input: CreatePSqlALRuntimeStoresInput
): ALInboundRuntimeStores {
    return createPSqlALRuntimeStores('inbound', input);
}

export function createPSqlALOutboundRuntimeStores(
    input: CreatePSqlALRuntimeStoresInput
): ALOutboundRuntimeStores {
    return createPSqlALRuntimeStores('outbound', input);
}

export function createDefaultPSqlALInboundRuntimeStores(
    options: CreateDefaultPSqlALRuntimeStoresInput
): ALInboundRuntimeStores {
    return createPSqlALInboundRuntimeStores(toDefaultPSqlALRuntimeStoresInput(options));
}

export function createDefaultPSqlALOutboundRuntimeStores(
    options: CreateDefaultPSqlALRuntimeStoresInput
): ALOutboundRuntimeStores {
    return createPSqlALOutboundRuntimeStores(toDefaultPSqlALRuntimeStoresInput(options));
}

export function configureServerWsQBoxALRuntimeStores(
    name: string,
    options: CreateDefaultPSqlALRuntimeStoresInput
): void {
    const runtimeStoreId = toServerWsQBoxALRuntimeStoreId(name);
    configureALRuntimeStoreScopes([
        {
            id: runtimeStoreId,
            factories: createPSqlRuntimeStoreFactories(runtimeStoreId, options)
        }
    ]);
}

export function resolveServerWsQBoxALInboundRuntimeStores(name: string): ALInboundRuntimeStores {
    return resolveServerWsQBoxALRuntimeStores('inbound', name);
}

export function resolveServerWsQBoxALOutboundRuntimeStores(name: string): ALOutboundRuntimeStores {
    return resolveServerWsQBoxALRuntimeStores('outbound', name);
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
