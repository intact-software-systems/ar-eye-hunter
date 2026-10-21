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
    WS_SESSION_CLOSE_HIGH_WATER_NAMESPACE,
    type WsSessionCloseHighWaterState,
    type WsSessionGenerationCloseFacts,
    type WsSessionGenerationFacts,
    type WsSessionGenerationGuardFacts,
    type WsSessionGenerationLifecycleComputed,
    type WsSessionGenerationLifecycleRead,
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
    write(
        transaction: PSqlSql,
        computed: WsSessionGenerationLifecycleComputed
    ): Promise<void>;
}

export function createWsSessionGenerationLifecycleService(
    repository: RuntimeStateOptimisticTransactionalRepositoryLike
): WsSessionGenerationLifecycleService {
    return {
        read: async (identity) =>
            toWsSessionGenerationLifecycleRead(
                identity,
                await repository.findEntry(WS_SESSION_CLOSE_HIGH_WATER_NAMESPACE, toWsSessionLifecycleKey(identity))
            ),
        isGenerationClosed: isWsSessionGenerationClosed,
        isObservedAtClosed: isWsSessionObservedAtClosed,
        computeClosed: computeWsSessionGenerationClosed,
        computeConnectGuard: computeWsSessionConnectGuard,
        write: async (transaction, computed) => {
            if (computed.row === null) {
                return;
            }
            const { descriptor, expireAtIsoTimestamp } = computed.row;
            const rows = descriptor.operation === 'insert'
                ? await transaction<Array<{ revision: number | string; }>>`
                    insert into runtime_state_store (store_namespace, store_key, store_value,
                                                     expire_at_ts, updated_ts, revision)
                    values (${descriptor.namespace}, ${descriptor.key},
                            ${descriptor.value}, ${expireAtIsoTimestamp}, now(), 0)
                    on conflict (store_namespace, store_key) do nothing
                    returning revision
                `
                : await transaction<Array<{ revision: number | string; }>>`
                    update runtime_state_store
                    set store_value = ${descriptor.value},
                        expire_at_ts = ${expireAtIsoTimestamp},
                        updated_ts = now(),
                        revision = revision + 1
                    where store_namespace = ${descriptor.namespace}
                      and store_key = ${descriptor.key}
                      and revision = ${descriptor.expectedRevision}
                    returning revision
                `;
            if (rows.length === 0) {
                throw new RuntimeStateWriteConflictError();
            }
        }
    };
}

/** The close high-water row of a session, expired or not, as the generation lifecycle reads it. */
export function toWsSessionGenerationLifecycleRead(
    identity: WsSessionHighWaterIdentity,
    entry: RuntimeStateEntry | undefined
): WsSessionGenerationLifecycleRead {
    return {
        identity,
        key: toWsSessionLifecycleKey(identity),
        revision: entry?.revision ?? null,
        persistedExpireAtEpochMs: entry?.expireAtTimestamp ?? null,
        state: entry ? decodeCurrentSessionGenerationRow(entry, identity) : null
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
