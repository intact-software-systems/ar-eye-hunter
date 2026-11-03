import { requireString } from '@shared/api/exact-object-decoding.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import {
    assertRuntimeStateExpectedRevision,
    type RuntimeStateEntry
} from '../../../../runtime-state/runtime-state-repository.ts';
import type { GroupStateAuthoritativeSnapshot } from '../group-state-persistence-contracts.ts';
import { materializeGroupStateAuthorityGuard } from './group-aggregate-repository.ts';

export interface ObservedGroupAuthority {
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly expectedRevision: number;
    readonly expireAtIso: string;
    readonly observationsJson: string;
}

export interface ObservedGroupAuthorityInput {
    readonly group: GroupStateAuthoritativeSnapshot;
    readonly observations: readonly {
        readonly namespace: string;
        readonly key: string;
        readonly entry: RuntimeStateEntry | null;
    }[];
}

/** Freezes point observations before transaction entry; no authorization row is rewritten merely to fence it. */
export function computeObservedGroupAuthority(input: ObservedGroupAuthorityInput): ObservedGroupAuthority {
    const authority = materializeGroupStateAuthorityGuard(input.group.authorityGuard);
    const observations = input.observations.map(({ namespace, key, entry }) => {
        requireString(namespace, 'Observed authority namespace');
        requireString(key, 'Observed authority key');
        if (entry !== null) {
            if (entry.key !== key) {
                throw new TypeError('Observed authority row differs from its requested key');
            }
            assertRuntimeStateExpectedRevision(entry.revision);
        }
        return {
            namespace,
            key,
            revision: entry?.revision ?? null,
            value: entry?.value ?? null,
            expires: entry === null ? null : new Date(entry.expireAtTimestamp).toISOString()
        };
    });
    return {
        namespace: authority.namespace,
        key: authority.key,
        value: authority.value,
        expectedRevision: authority.expectedRevision,
        expireAtIso: new Date(authority.expireAtTimestamp).toISOString(),
        observationsJson: JSON.stringify(observations)
    };
}

/** The domain owner commits this fence, its state and its AppInbox outcome in one transaction. */
export async function writeObservedGroupAuthority(
    transaction: PSqlSql,
    computed: ObservedGroupAuthority
): Promise<void> {
    const rows = await transaction<{ revision: number; }[]>`
        update runtime_state_store
        set store_value = ${computed.value}, expire_at_ts = ${computed.expireAtIso}::timestamptz,
            updated_ts = now(), revision = revision + 1
        where store_namespace = ${computed.namespace} and store_key = ${computed.key}
          and revision = ${computed.expectedRevision}
          and not exists (
              select 1
              from jsonb_to_recordset(${computed.observationsJson}::text::jsonb)
                  as observed(namespace text, key text, revision bigint, value text, expires text)
              left join runtime_state_store as observation
                on observation.store_namespace = observed.namespace and observation.store_key = observed.key
              where observation.revision is distinct from observed.revision
                 or observation.store_value is distinct from observed.value
                 or observation.expire_at_ts is distinct from observed.expires::timestamptz
          )
        returning revision
    `;
    if (rows.length !== 1) {
        throw new RuntimeStateWriteConflictError();
    }
}
