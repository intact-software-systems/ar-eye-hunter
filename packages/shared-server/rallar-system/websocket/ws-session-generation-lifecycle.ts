import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '../../runtime-state/runtime-state-repository.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    computeWsSessionConnectGuard,
    computeWsSessionGenerationClosed,
    decodeWsSessionCloseHighWaterState,
    isWsSessionGenerationClosed,
    isWsSessionObservedAtClosed,
    toWsSessionLifecycleKey,
    validateWsSessionConnectGuard,
    validateWsSessionGenerationClosed,
    type WsSessionCloseHighWaterState,
    type WsSessionGenerationCloseFacts,
    type WsSessionGenerationFacts,
    type WsSessionGenerationGuardFacts,
    type WsSessionGenerationLifecycleComputed,
    type WsSessionGenerationLifecycleRead,
    type WsSessionGenerationValidationIssue,
    type WsSessionHighWaterIdentity
} from './ws-session-generation-computation.ts';

export interface WsSessionGenerationLifecycleService {
    read(identity: WsSessionHighWaterIdentity): Promise<WsSessionGenerationLifecycleRead>;
    isGenerationClosed(
        facts: WsSessionGenerationFacts,
        read: WsSessionGenerationLifecycleRead
    ): boolean;
    isObservedAtClosed(
        identity: WsSessionHighWaterIdentity,
        observedAtEpochMs: number,
        read: WsSessionGenerationLifecycleRead
    ): boolean;
    computeClosed(
        facts: WsSessionGenerationCloseFacts,
        read: WsSessionGenerationLifecycleRead
    ): WsSessionGenerationLifecycleComputed;
    computeConnectGuard(
        facts: WsSessionGenerationGuardFacts,
        read: WsSessionGenerationLifecycleRead
    ): WsSessionGenerationLifecycleComputed;
    validateConnectGuard(
        facts: WsSessionGenerationGuardFacts,
        read: WsSessionGenerationLifecycleRead,
        computed: WsSessionGenerationLifecycleComputed
    ): readonly WsSessionGenerationValidationIssue[];
    validateClosed(
        facts: WsSessionGenerationCloseFacts,
        read: WsSessionGenerationLifecycleRead,
        computed: WsSessionGenerationLifecycleComputed
    ): readonly WsSessionGenerationValidationIssue[];
    write(
        transaction: PSqlSql,
        computed: WsSessionGenerationLifecycleComputed
    ): Promise<void>;
}

const SESSION_CLOSE_HIGH_WATER_NAMESPACE = 'ws-session-close-high-water';

export function createWsSessionGenerationLifecycleService(
    repository: RuntimeStateOptimisticTransactionalRepositoryLike
): WsSessionGenerationLifecycleService {
    return {
        read: async (identity) => await readWsSessionGenerationLifecycle(repository, identity),
        isGenerationClosed: isWsSessionGenerationClosed,
        isObservedAtClosed: isWsSessionObservedAtClosed,
        computeClosed: computeWsSessionGenerationClosed,
        computeConnectGuard: computeWsSessionConnectGuard,
        validateConnectGuard: validateWsSessionConnectGuard,
        validateClosed: validateWsSessionGenerationClosed,
        write: writeWsSessionGenerationLifecycle
    };
}

async function readWsSessionGenerationLifecycle(
    repository: RuntimeStateOptimisticTransactionalRepositoryLike,
    identity: WsSessionHighWaterIdentity
): Promise<WsSessionGenerationLifecycleRead> {
    const key = toWsSessionLifecycleKey(identity);
    const entry = await repository.findEntry(SESSION_CLOSE_HIGH_WATER_NAMESPACE, key);
    const state = entry ? decodeCurrentSessionGenerationRow(entry, identity) : null;
    return {
        identity,
        key,
        revision: entry?.revision ?? null,
        persistedExpireAtEpochMs: entry?.expireAtTimestamp ?? null,
        state
    };
}

async function writeWsSessionGenerationLifecycle(
    transaction: PSqlSql,
    computed: WsSessionGenerationLifecycleComputed
): Promise<void> {
    if (computed.outcome === 'none') {
        return;
    }
    const target = new PSqlRuntimeStateRepository(transaction);
    const result = computed.outcome === 'insert'
        ? await target.insertIfAbsent(
            SESSION_CLOSE_HIGH_WATER_NAMESPACE,
            computed.key,
            computed.value,
            computed.expireAtIsoTimestamp
        )
        : await target.upsertIfRevision(
            SESSION_CLOSE_HIGH_WATER_NAMESPACE,
            computed.key,
            computed.value,
            computed.expireAtIsoTimestamp,
            computed.expectedRevision
        );
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}

function decodeCurrentSessionGenerationRow(
    entry: RuntimeStateEntry,
    identity: WsSessionHighWaterIdentity
): WsSessionCloseHighWaterState {
    const state = decodeWsSessionCloseHighWaterState(
        decodeJsonWireValue(
            JSON.parse(entry.value),
            'WebSocket session close high-water state'
        ),
        identity
    );
    if (state.expireAtEpochMs !== entry.expireAtTimestamp) {
        throw new TypeError('WebSocket session close high-water row expiry is invalid');
    }
    return state;
}
