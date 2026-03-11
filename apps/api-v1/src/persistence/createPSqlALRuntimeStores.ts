import type { Sql } from 'postgres';
import type { ALSupersedencePersistenceValue } from '@shared/al-contracts/al-runtime.ts';
import { PersistentALSupersedenceStore, } from '@shared/al-contracts/al-runtime.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot,
} from '@shared/alm/ALRuntimeStateStores.ts';
import { PersistentALOutboundRuntimeStateStore, } from '@shared/alm/ALRuntimeStateStores.ts';
import { createALInboundAdmissionStore } from '@shared/alm/ALInboundAdmissionStore.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/ALOutboundAdmissionStore.ts';
import type { ALRuntimeStoreRetentionConfig } from '@shared/alm/ALStoreRetention.ts';
import {
    type ALRuntimeStoreFactories,
    configureALRuntimeStoreScopes,
    resolveALInboundRuntimeStores,
    resolveALOutboundRuntimeStores,
} from '@shared/alm/ALRuntimeStoreRegistry.ts';
import { sql as defaultSql } from '../db/db.ts';
import {
    isRuntimeStateTransactionalRepositoryLike,
    RuntimeStateRepository,
    type RuntimeStateRepositoryLike,
    type RuntimeStateTransactionalRepositoryLike,
} from '../repository/RuntimeStateRepository.ts';
import { PSqlJsonPersistenceProvider } from './PSqlJsonPersistenceProvider.ts';
import { PSqlInboundAdmissionBackend } from './PSqlInboundAdmissionBackend.ts';
import { PSqlOutboundAdmissionBackend } from './PSqlOutboundAdmissionBackend.ts';

export type PSqlALRuntimeStoreFactoryOptions = Readonly<{
    namespace?: string;
    orderingTrackTtlMs?: number;
    supersedenceTrackTtlMs?: number;
    retention?: ALRuntimeStoreRetentionConfig;
    repository?: RuntimeStateRepositoryLike;
}>;

const DEFAULT_NAMESPACE = 'al-runtime';

type RuntimeStoreDirection = 'inbound' | 'outbound';

export function toServerWsQBoxALRuntimeStoreId(name: string): string {
    return `server-ws-qbox:${name}`;
}

function resolvePSqlRuntimeStoreContext(
    direction: RuntimeStoreDirection,
    options: PSqlALRuntimeStoreFactoryOptions,
): Readonly<{
    repository: RuntimeStateTransactionalRepositoryLike;
    namespace: string;
}> {
    const repository =
        options.repository ?? new RuntimeStateRepository(defaultSql as unknown as Sql);
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;

    if (!isRuntimeStateTransactionalRepositoryLike(repository)) {
        throw new Error(
            `PSql ${direction} runtime stores require a transactional RuntimeStateRepository`,
        );
    }

    return {
        repository,
        namespace,
    };
}

function createPSqlALRuntimeStores(
    direction: 'inbound',
    options?: PSqlALRuntimeStoreFactoryOptions,
): ALInboundRuntimeStores;
function createPSqlALRuntimeStores(
    direction: 'outbound',
    options?: PSqlALRuntimeStoreFactoryOptions,
): ALOutboundRuntimeStores;
function createPSqlALRuntimeStores(
    direction: RuntimeStoreDirection,
    options: PSqlALRuntimeStoreFactoryOptions = {},
): ALInboundRuntimeStores | ALOutboundRuntimeStores {
    const { repository, namespace } = resolvePSqlRuntimeStoreContext(
        direction,
        options,
    );

    if (direction === 'inbound') {
        return {
            admissionStore: createALInboundAdmissionStore({
                kind: 'backend',
                namespace: `${namespace}:inbound:admission`,
                backend: new PSqlInboundAdmissionBackend(
                    repository,
                    `${namespace}:inbound:admission`,
                ),
                orderingTrackTtlMs: options.orderingTrackTtlMs ?? 5 * 60_000,
                supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
                retention: options.retention,
            }),
        };
    }

    return {
        admissionStore: createALOutboundAdmissionStore({
            kind: 'backend',
            namespace: `${namespace}:outbound:admission`,
            backend: new PSqlOutboundAdmissionBackend(
                repository,
                `${namespace}:outbound:admission`,
            ),
            supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
            retention: options.retention,
        }),
        supersedenceStore: new PersistentALSupersedenceStore(
            new PSqlJsonPersistenceProvider<ALSupersedencePersistenceValue>(repository, `${namespace}:outbound:supersedence`),
            options.supersedenceTrackTtlMs,
        ),
        stateStore: new PersistentALOutboundRuntimeStateStore(
            new PSqlJsonPersistenceProvider<ALOutboundSentMessageSnapshot>(repository, `${namespace}:outbound:sent`),
            new PSqlJsonPersistenceProvider<ALOutboundPendingAckSnapshot>(repository, `${namespace}:outbound:pending-acks`),
            new PSqlJsonPersistenceProvider<ALOutboundRepairAttemptSnapshot>(repository, `${namespace}:outbound:repair-attempts`),
            options.retention,
        ),
    };
}

function createPSqlRuntimeStoreFactories(
    runtimeStoreId: string,
    options: PSqlALRuntimeStoreFactoryOptions,
): ALRuntimeStoreFactories {
    const scopedOptions = {
        ...options,
        namespace: options.namespace ?? runtimeStoreId,
    };

    return {
        createInboundStores: () => createPSqlALInboundRuntimeStores(scopedOptions),
        createOutboundStores: () => createPSqlALOutboundRuntimeStores(scopedOptions),
    };
}

function resolveServerWsQBoxALRuntimeStores(
    direction: 'inbound',
    name: string,
): ALInboundRuntimeStores;
function resolveServerWsQBoxALRuntimeStores(
    direction: 'outbound',
    name: string,
): ALOutboundRuntimeStores;
function resolveServerWsQBoxALRuntimeStores(
    direction: RuntimeStoreDirection,
    name: string,
): ALInboundRuntimeStores | ALOutboundRuntimeStores {
    const runtimeStoreId = toServerWsQBoxALRuntimeStoreId(name);

    return direction === 'inbound'
        ? resolveALInboundRuntimeStores(runtimeStoreId)
        : resolveALOutboundRuntimeStores(runtimeStoreId);
}

export function createPSqlALInboundRuntimeStores(
    options: PSqlALRuntimeStoreFactoryOptions = {},
): ALInboundRuntimeStores {
    return createPSqlALRuntimeStores('inbound', options);
}

export function createPSqlALOutboundRuntimeStores(
    options: PSqlALRuntimeStoreFactoryOptions = {},
): ALOutboundRuntimeStores {
    return createPSqlALRuntimeStores('outbound', options);
}

export function configureServerWsQBoxALRuntimeStores(
    name: string,
    options: PSqlALRuntimeStoreFactoryOptions = {},
): void {
    const runtimeStoreId = toServerWsQBoxALRuntimeStoreId(name);
    configureALRuntimeStoreScopes([
        {
            id: runtimeStoreId,
            factories: createPSqlRuntimeStoreFactories(runtimeStoreId, options),
        },
    ]);
}

export function resolveServerWsQBoxALInboundRuntimeStores(
    name: string,
): ALInboundRuntimeStores {
    return resolveServerWsQBoxALRuntimeStores('inbound', name);
}

export function resolveServerWsQBoxALOutboundRuntimeStores(
    name: string,
): ALOutboundRuntimeStores {
    return resolveServerWsQBoxALRuntimeStores('outbound', name);
}
