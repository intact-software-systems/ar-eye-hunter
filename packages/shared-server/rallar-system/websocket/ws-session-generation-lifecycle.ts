import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type {
    RuntimeStateGuardedBatchInsert,
    RuntimeStateGuardedBatchUpdate
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { createTransactionBoundPSqlRuntimeStateRepository } from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
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
    type WsSessionCloseHighWaterState,
    type WsSessionGenerationCloseFacts,
    type WsSessionGenerationFacts,
    type WsSessionGenerationGuardFacts,
    type WsSessionGenerationLifecycleComputed,
    type WsSessionGenerationLifecycleRead,
    type WsSessionHighWaterIdentity
} from './ws-session-generation-computation.ts';

const SESSION_CLOSE_HIGH_WATER_NAMESPACE = 'ws-session-close-high-water';

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
    write(
        transaction: PSqlSql,
        computed: WsSessionGenerationLifecycleComputed
    ): Promise<void>;
}

/**
 * The lifecycle row's conditional write, the one encoding that a guarded batch and the standalone write both execute;
 * null when the row stays as read.
 */
export function toWsSessionGenerationLifecycleRow(
    computed: WsSessionGenerationLifecycleComputed
): RuntimeStateGuardedBatchInsert | RuntimeStateGuardedBatchUpdate | null {
    const row = {
        namespace: SESSION_CLOSE_HIGH_WATER_NAMESPACE,
        key: computed.key,
        value: computed.value,
        expireAtTimestamp: computed.state.expireAtEpochMs
    };
    switch (computed.outcome) {
        case 'none':
            return null;
        case 'insert':
            return { ...row, operation: 'insert' };
        case 'update':
            return { ...row, operation: 'update', expectedRevision: computed.expectedRevision };
    }
}

export function createWsSessionGenerationLifecycleService(
    repository: RuntimeStateOptimisticTransactionalRepositoryLike
): WsSessionGenerationLifecycleService {
    return {
        read: async (identity) => {
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
        },
        isGenerationClosed: isWsSessionGenerationClosed,
        isObservedAtClosed: isWsSessionObservedAtClosed,
        computeClosed: computeWsSessionGenerationClosed,
        computeConnectGuard: computeWsSessionConnectGuard,
        write: async (transaction, computed) => {
            const row = toWsSessionGenerationLifecycleRow(computed);
            if (row === null) {
                return;
            }
            const store = createTransactionBoundPSqlRuntimeStateRepository(transaction);
            const written = row.operation === 'insert'
                ? await store.insertIfAbsent(row.namespace, row.key, row.value, row.expireAtTimestamp)
                : await store.upsertIfRevision(
                    row.namespace,
                    row.key,
                    row.value,
                    row.expireAtTimestamp,
                    row.expectedRevision
                );
            if (written.status !== 'applied') {
                throw new RuntimeStateWriteConflictError();
            }
        }
    };
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
