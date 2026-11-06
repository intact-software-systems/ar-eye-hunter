import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import {
    computeRuntimeStateObservations,
    type RuntimeStateObservation,
    type RuntimeStateObservations
} from '../../../../runtime-state/observation/runtime-state-observation.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { readRuntimeStateObservationsCurrent } from '../../../../runtime-state/postgres/read-runtime-state-observations-current.ts';
import type { GroupStateAuthoritativeSnapshot } from '../group-state-persistence-contracts.ts';
import { materializeGroupStateAuthorityGuard } from './group-aggregate-repository.ts';

export interface ObservedGroupAuthority {
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly expectedRevision: number;
    readonly expireAtIso: string;
    readonly observations: RuntimeStateObservations;
}

export interface ObservedGroupAuthorityInput {
    readonly group: GroupStateAuthoritativeSnapshot;
    readonly observations: readonly RuntimeStateObservation[];
}

/** Freezes point observations before transaction entry; no authorization row is rewritten merely to fence it. */
export function computeObservedGroupAuthority(input: ObservedGroupAuthorityInput): ObservedGroupAuthority {
    const authority = materializeGroupStateAuthorityGuard(input.group.authorityGuard);
    return {
        namespace: authority.namespace,
        key: authority.key,
        value: authority.value,
        expectedRevision: authority.expectedRevision,
        expireAtIso: new Date(authority.expireAtTimestamp).toISOString(),
        observations: computeRuntimeStateObservations(input.observations)
    };
}

/** The domain owner commits this fence, its state and its AppInbox outcome in one transaction. */
export async function writeObservedGroupAuthority(
    transaction: PSqlSql,
    computed: ObservedGroupAuthority
): Promise<void> {
    if (!await readRuntimeStateObservationsCurrent(transaction, computed.observations)) {
        throw new RuntimeStateWriteConflictError();
    }
    const rows = await transaction<{ revision: number; }[]>`
        update runtime_state_store
        set store_value = ${computed.value}, expire_at_ts = ${computed.expireAtIso}::timestamptz,
            updated_ts = now(), revision = revision + 1
        where store_namespace = ${computed.namespace} and store_key = ${computed.key}
          and revision = ${computed.expectedRevision}
        returning revision
    `;
    if (rows.length !== 1) {
        throw new RuntimeStateWriteConflictError();
    }
}
