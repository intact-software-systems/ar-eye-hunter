import {
    validateRuntimeStateReadBatchResult,
    validateRuntimeStateReadBatchSelectors,
    type RuntimeStateReadBatchSelection,
    type RuntimeStateReadBatchSelector
} from '../../runtime-state/RuntimeStateReadBatch.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { toExclusivePrefixEnd } from './PSqlRuntimeStateSqlValues.ts';

type PSqlRuntimeStateReadBatchRow = Readonly<{
    selections: unknown;
}>;

type PSqlRuntimeStateReadBatchSelector = Readonly<{
    selectorId: string;
    kind: RuntimeStateReadBatchSelector['kind'];
    namespace: string;
    key: string | null;
    keyPrefix: string | null;
    prefixEnd: string | null;
}>;

export async function readPSqlRuntimeStateBatch(
    sql: PSqlSql,
    input: readonly RuntimeStateReadBatchSelector[]
): Promise<readonly RuntimeStateReadBatchSelection[]> {
    const selectors = validateRuntimeStateReadBatchSelectors(input);
    const rows = await sql<PSqlRuntimeStateReadBatchRow[]>`
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'selectorId', selector_result.selector_id,
                 'entries', selector_result.entries
               )
               order by selector_result.selector_ordinal
             ),
             '[]'::jsonb
           ) as selections
    from (
      select selector.selector_ordinal,
             selector.selector_id,
             coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'key', matched.store_key,
                   'value', matched.store_value,
                   'expireAtTimestamp',
                     round(extract(epoch from matched.expire_at_ts) * 1000)::bigint::text,
                   'updatedTimestamp', matched.updated_ts,
                   'revision', matched.revision::text
                 )
                 order by matched.store_key collate "C"
               ) filter (where matched.store_key is not null),
               '[]'::jsonb
             ) as entries
      from (
        select descriptor.ordinality as selector_ordinal,
               descriptor.value ->> 'selectorId' as selector_id,
               descriptor.value ->> 'kind' as selector_kind,
               descriptor.value ->> 'namespace' as store_namespace,
               descriptor.value ->> 'key' as store_key,
               descriptor.value ->> 'keyPrefix' as key_prefix,
               descriptor.value ->> 'prefixEnd' as prefix_end
        from jsonb_array_elements(${selectors.map(toSqlSelector)}::jsonb)
          with ordinality as descriptor(value, ordinality)
      ) selector
      left join lateral (
        select exact_entry.store_key,
               exact_entry.store_value,
               exact_entry.expire_at_ts,
               exact_entry.updated_ts,
               exact_entry.revision
        from runtime_state_store exact_entry
        where selector.selector_kind = 'key'
          and exact_entry.store_namespace = selector.store_namespace
          and exact_entry.store_key = selector.store_key

        union all

        select prefix_entry.store_key,
               prefix_entry.store_value,
               prefix_entry.expire_at_ts,
               prefix_entry.updated_ts,
               prefix_entry.revision
        from runtime_state_store prefix_entry
        where selector.selector_kind = 'prefix'
          and prefix_entry.store_namespace = selector.store_namespace
          and prefix_entry.store_key collate "C" >= selector.key_prefix
          and prefix_entry.store_key collate "C" < selector.prefix_end
      ) matched on true
      group by selector.selector_ordinal, selector.selector_id
    ) selector_result
  `;

    if (rows.length !== 1) {
        throw new Error(
            `Invalid runtime state read batch database result: expected one packed row, received ${rows.length}`
        );
    }
    return validateRuntimeStateReadBatchResult(
        selectors,
        normalizeDriverResult(rows[0].selections)
    );
}

function toSqlSelector(
    selector: RuntimeStateReadBatchSelector
): PSqlRuntimeStateReadBatchSelector {
    return selector.kind === 'key'
        ? {
            ...selector,
            keyPrefix: null,
            prefixEnd: null
        }
        : {
            ...selector,
            key: null,
            prefixEnd: toExclusivePrefixEnd(selector.keyPrefix)
        };
}

function normalizeDriverResult(input: unknown): unknown {
    const parsed = typeof input === 'string' ? parsePayload(input) : input;
    if (!Array.isArray(parsed)) {
        return parsed;
    }
    return parsed.map((selection) => {
        if (!isRecord(selection) || !Array.isArray(selection.entries)) {
            return selection;
        }
        return {
            ...selection,
            entries: selection.entries.map((entry) => {
                if (!isRecord(entry)) {
                    return entry;
                }
                return {
                    ...entry,
                    expireAtTimestamp: normalizeDriverInteger(entry.expireAtTimestamp),
                    revision: normalizeDriverInteger(entry.revision)
                };
            })
        };
    });
}

function parsePayload(input: string): unknown {
    try {
        return JSON.parse(input) as unknown;
    }
    catch (error) {
        throw new Error(
            `Invalid runtime state read batch database JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function normalizeDriverInteger(input: unknown): unknown {
    if (typeof input !== 'string' || !/^-?(0|[1-9]\d*)$/u.test(input)) {
        return input;
    }
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) ? parsed : input;
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
    return typeof input === 'object' && input !== null && !Array.isArray(input);
}
