import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    computeWsSessionConnectGuard,
    computeWsSessionGenerationClosed,
    decodeWsSessionCloseHighWaterState,
    isWsSessionGenerationClosed,
    isWsSessionObservedAtClosed,
    toWsSessionLifecycleKey,
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

export function createWsSessionGenerationLifecycleService(
    repository: RuntimeStateOptimisticTransactionalRepositoryLike
): WsSessionGenerationLifecycleService {
    return {
        read: async (identity) => {
            const key = toWsSessionLifecycleKey(identity);
            const entry = await repository.findEntry(SESSION_CLOSE_HIGH_WATER_NAMESPACE, key);
            return {
                identity,
                key,
                revision: entry?.revision ?? null,
                persistedExpireAtEpochMs: entry?.expireAtTimestamp ?? null,
                state: entry
                    ? decodeWsSessionCloseHighWaterState(
                        decodeJsonWireValue(
                            JSON.parse(entry.value),
                            'WebSocket session close high-water state'
                        ),
                        identity
                    )
                    : null
            };
        },
        isGenerationClosed: isWsSessionGenerationClosed,
        isObservedAtClosed: isWsSessionObservedAtClosed,
        computeClosed: computeWsSessionGenerationClosed,
        computeConnectGuard: computeWsSessionConnectGuard,
        write: async (transaction, computed) => {
            if (computed.outcome === 'none') {
                return;
            }
            const target = new PSqlRuntimeStateRepository(transaction);
            const value = JSON.stringify(computed.state);
            const result = computed.outcome === 'insert'
                ? await target.insertIfAbsent(
                    SESSION_CLOSE_HIGH_WATER_NAMESPACE,
                    computed.key,
                    value,
                    computed.state.expireAtEpochMs
                )
                : await target.upsertIfRevision(
                    SESSION_CLOSE_HIGH_WATER_NAMESPACE,
                    computed.key,
                    value,
                    computed.state.expireAtEpochMs,
                    requireExpectedRevision(computed)
                );
            if (result.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
        }
    };
}

function requireExpectedRevision(computed: WsSessionGenerationLifecycleComputed): number {
    if (computed.expectedRevision === null) {
        throw new TypeError('WebSocket session close high-water update revision is missing');
    }
    return computed.expectedRevision;
}
