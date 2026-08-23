import {
    type RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ALSupersedencePersistenceValue } from '@shared/al-contracts/al-runtime.ts';
import { PersistentALSupersedenceStore } from '@shared/al-contracts/al-runtime.ts';
import { createALInboundAdmissionStore } from '@shared/alm/ALInboundAdmissionStore.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/ALInboundMessageRuntime.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/ALOutboundAdmissionStore.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot
} from '@shared/alm/ALRuntimeStateStores.ts';
import { PersistentALOutboundRuntimeStateStore } from '@shared/alm/ALRuntimeStateStores.ts';
import {
    configureALRuntimeStoreScopes,
    resolveALInboundRuntimeStores,
    resolveALOutboundRuntimeStores,
    type ALRuntimeStoreFactories
} from '@shared/alm/ALRuntimeStoreRegistry.ts';
import type { ALRuntimeStoreRetentionConfig } from '@shared/alm/ALStoreRetention.ts';
import { RuntimeStateJsonPersistenceProvider } from '../../runtime-state/runtime-state-json-persistence-provider.ts';
import { alOutboundSentMessageCodec } from '../persistence/al-outbound-sent-message-codec.ts';
import {
    alOutboundPendingAckCodec,
    alOutboundRepairAttemptCodec,
    alSupersedencePersistenceCodec
} from '../persistence/al-runtime-state-codecs.ts';
import { PSqlInboundAdmissionBackend } from './p-sql-inbound-admission-backend.ts';
import { PSqlOutboundAdmissionBackend } from './p-sql-outbound-admission-backend.ts';

export interface PSqlALRuntimeStoreFactoryOptions {
    readonly repository: RuntimeStateOptimisticTransactionalRepositoryLike;
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
    options: PSqlALRuntimeStoreFactoryOptions
): ALInboundRuntimeStores;
function createPSqlALRuntimeStores(
    direction: 'outbound',
    options: PSqlALRuntimeStoreFactoryOptions
): ALOutboundRuntimeStores;
function createPSqlALRuntimeStores(
    direction: RuntimeStoreDirection,
    options: PSqlALRuntimeStoreFactoryOptions
): ALInboundRuntimeStores | ALOutboundRuntimeStores {
    const repository = options.repository;
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;

    if (direction === 'inbound') {
        return {
            admissionStore: createALInboundAdmissionStore({
                kind: 'backend',
                namespace: `${namespace}:inbound:admission`,
                backend: new PSqlInboundAdmissionBackend(
                    repository,
                    `${namespace}:inbound:admission`
                ),
                orderingTrackTtlMs: options.orderingTrackTtlMs ?? 5 * 60_000,
                supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
                retention: options.retention
            })
        };
    }

    return {
        admissionStore: createALOutboundAdmissionStore({
            kind: 'backend',
            namespace: `${namespace}:outbound:admission`,
            backend: new PSqlOutboundAdmissionBackend(
                repository,
                `${namespace}:outbound:admission`
            ),
            supersedenceTrackTtlMs: options.supersedenceTrackTtlMs ?? 5 * 60_000,
            retention: options.retention
        }),
        supersedenceStore: new PersistentALSupersedenceStore(
            new RuntimeStateJsonPersistenceProvider<ALSupersedencePersistenceValue>(
                repository,
                `${namespace}:outbound:supersedence`,
                alSupersedencePersistenceCodec
            ),
            options.supersedenceTrackTtlMs
        ),
        stateStore: new PersistentALOutboundRuntimeStateStore(
            new RuntimeStateJsonPersistenceProvider<ALOutboundSentMessageSnapshot>(
                repository,
                `${namespace}:outbound:sent`,
                alOutboundSentMessageCodec
            ),
            new RuntimeStateJsonPersistenceProvider<ALOutboundPendingAckSnapshot>(
                repository,
                `${namespace}:outbound:pending-acks`,
                alOutboundPendingAckCodec
            ),
            new RuntimeStateJsonPersistenceProvider<ALOutboundRepairAttemptSnapshot>(
                repository,
                `${namespace}:outbound:repair-attempts`,
                alOutboundRepairAttemptCodec
            ),
            options.retention
        )
    };
}

function createPSqlRuntimeStoreFactories(
    runtimeStoreId: string,
    options: PSqlALRuntimeStoreFactoryOptions
): ALRuntimeStoreFactories {
    const scopedOptions = {
        ...options,
        namespace: options.namespace ?? runtimeStoreId
    };

    return {
        createInboundStores: () => createPSqlALInboundRuntimeStores(scopedOptions),
        createOutboundStores: () => createPSqlALOutboundRuntimeStores(scopedOptions)
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
    options: PSqlALRuntimeStoreFactoryOptions
): ALInboundRuntimeStores {
    return createPSqlALRuntimeStores('inbound', options);
}

export function createPSqlALOutboundRuntimeStores(
    options: PSqlALRuntimeStoreFactoryOptions
): ALOutboundRuntimeStores {
    return createPSqlALRuntimeStores('outbound', options);
}

export function configureServerWsQBoxALRuntimeStores(
    name: string,
    options: PSqlALRuntimeStoreFactoryOptions
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
