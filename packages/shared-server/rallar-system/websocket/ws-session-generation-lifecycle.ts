import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
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
            if (computed.outcome === 'none') {
                return;
            }
            const rows = computed.outcome === 'insert'
                ? await transaction<Array<{ revision: number | string; }>>`
                    insert into runtime_state_store (store_namespace, store_key, store_value,
                                                     expire_at_ts, updated_ts, revision)
                    values (${SESSION_CLOSE_HIGH_WATER_NAMESPACE}, ${computed.key},
                            ${computed.value}, ${computed.expireAtIsoTimestamp}, now(), 0)
                    on conflict (store_namespace, store_key) do nothing
                    returning revision
                `
                : await transaction<Array<{ revision: number | string; }>>`
                    update runtime_state_store
                    set store_value = ${computed.value},
                        expire_at_ts = ${computed.expireAtIsoTimestamp},
                        updated_ts = now(),
                        revision = revision + 1
                    where store_namespace = ${SESSION_CLOSE_HIGH_WATER_NAMESPACE}
                      and store_key = ${computed.key}
                      and revision = ${computed.expectedRevision}
                    returning revision
                `;
            if (rows.length === 0) {
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
