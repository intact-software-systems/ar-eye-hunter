import type { PSqlRows } from '../../postgres/p-sql-sql.ts';
import {
    type RuntimeStateReadBatchSelection,
    type RuntimeStateReadBatchSelector,
    type RuntimeStateReadBatchVersion,
    type RuntimeStateVersionedReadBatch
} from '../read-batch/runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchResult } from '../read-batch/validate-runtime-state-read-batch-result.ts';
import { validateRuntimeStateReadBatchSelectors } from '../read-batch/validate-runtime-state-read-batch-selectors.ts';
import { toExclusivePrefixEnd } from './runtime-state-sql-values.ts';
import {
    toRuntimeStateReadBatchSelections,
    toRuntimeStateReadBatchVersion,
    type PSqlRuntimeStateReadBatchRow
} from './to-runtime-state-read-batch-selections.ts';

interface PSqlRuntimeStateReadBatchSelector {
    readonly selectorId: string;
    readonly kind: RuntimeStateReadBatchSelector['kind'];
    readonly namespace: string;
    readonly key: string | null;
    readonly keyPrefix: string | null;
    readonly keySuffix: string | null;
    readonly prefixEnd: string | null;
    readonly reversedSuffix: string | null;
    readonly reversedSuffixEnd: string | null;
}

const NO_SQL_SELECTOR_BOUNDS = { prefixEnd: null, reversedSuffix: null, reversedSuffixEnd: null } as const;

export interface RuntimeStateReadBatchQuery {
    <Rows extends PSqlRows>(
        strings: TemplateStringsArray,
        ...values: readonly (object | boolean)[]
    ): Promise<Rows>;
}

/**
 * One statement for every selector, returned as one row per selected entry in caller order and C key
 * order (D289): an aggregated JSON document would re-escape every stored value inside one string.
 */
export async function readRuntimeStateBatch(
    sql: RuntimeStateReadBatchQuery,
    input: readonly RuntimeStateReadBatchSelector[]
): Promise<readonly RuntimeStateReadBatchSelection[]> {
    const selectors = validateRuntimeStateReadBatchSelectors(input);
    const rows = await selectRuntimeStateBatchRows(sql, selectors, true);
    return validateRuntimeStateReadBatchResult(selectors, toRuntimeStateReadBatchSelections(selectors, rows));
}

/**
 * The selection with the version of exactly the rows it returned, from the same statement and so the same
 * database snapshot (D289): a value assembled from these rows is current for as long as a probe reports this
 * version.
 */
export async function readRuntimeStateBatchWithVersion(
    sql: RuntimeStateReadBatchQuery,
    input: readonly RuntimeStateReadBatchSelector[]
): Promise<RuntimeStateVersionedReadBatch> {
    const selectors = validateRuntimeStateReadBatchSelectors(input);
    const rows = await selectRuntimeStateBatchRows(sql, selectors, true);
    return {
        selections: validateRuntimeStateReadBatchResult(selectors, toRuntimeStateReadBatchSelections(selectors, rows)),
        version: toRuntimeStateReadBatchVersion(selectors, rows)
    };
}

/**
 * The same selection without the stored values, reduced to the identity of every selected row
 * version (D289): any write of a selected row, a delete and re-insert included, writes a new row
 * version, so equal versions mean no selected row was written in between.
 */
export async function readRuntimeStateBatchVersion(
    sql: RuntimeStateReadBatchQuery,
    input: readonly RuntimeStateReadBatchSelector[]
): Promise<RuntimeStateReadBatchVersion | undefined> {
    const selectors = validateRuntimeStateReadBatchSelectors(input);
    return toRuntimeStateReadBatchVersion(selectors, await selectRuntimeStateBatchRows(sql, selectors, false));
}

async function selectRuntimeStateBatchRows(
    sql: RuntimeStateReadBatchQuery,
    selectors: readonly RuntimeStateReadBatchSelector[],
    includeValues: boolean
): Promise<readonly PSqlRuntimeStateReadBatchRow[]> {
    return await sql<PSqlRuntimeStateReadBatchRow[]>`
    select selector.selector_ordinal::int as selector_ordinal,
           matched.store_key,
           case when ${includeValues} then matched.store_value end as store_value,
           round(extract(epoch from matched.expire_at_ts) * 1000)::bigint::text as expire_at_timestamp,
           to_jsonb(matched.updated_ts) #>> '{}' as updated_timestamp,
           matched.revision::text as revision,
           matched.xmin::text || '/' || matched.ctid::text as row_version
    from (
      select descriptor.ordinality as selector_ordinal,
             descriptor.value ->> 'kind' as selector_kind,
             descriptor.value ->> 'namespace' as store_namespace,
             descriptor.value ->> 'key' as store_key,
             descriptor.value ->> 'keyPrefix' as key_prefix,
             descriptor.value ->> 'keySuffix' as key_suffix,
             descriptor.value ->> 'prefixEnd' as prefix_end,
             descriptor.value ->> 'reversedSuffix' as reversed_suffix,
             descriptor.value ->> 'reversedSuffixEnd' as reversed_suffix_end
      from jsonb_array_elements(${selectors.map(toSqlSelector)}::jsonb)
        with ordinality as descriptor(value, ordinality)
    ) selector
    join lateral (
      select exact_entry.store_key,
             exact_entry.store_value,
             exact_entry.expire_at_ts,
             exact_entry.updated_ts,
             exact_entry.revision,
             exact_entry.xmin,
             exact_entry.ctid
      from runtime_state_store exact_entry
      where selector.selector_kind = 'key'
        and exact_entry.store_namespace = selector.store_namespace
        and exact_entry.store_key = selector.store_key

      union all

      select prefix_entry.store_key,
             prefix_entry.store_value,
             prefix_entry.expire_at_ts,
             prefix_entry.updated_ts,
             prefix_entry.revision,
             prefix_entry.xmin,
             prefix_entry.ctid
      from runtime_state_store prefix_entry
      where selector.selector_kind = 'prefix'
        and prefix_entry.store_namespace = selector.store_namespace
        and prefix_entry.store_key collate "C" >= selector.key_prefix
        and prefix_entry.store_key collate "C" < selector.prefix_end

      union all

      select suffix_entry.store_key,
             suffix_entry.store_value,
             suffix_entry.expire_at_ts,
             suffix_entry.updated_ts,
             suffix_entry.revision,
             suffix_entry.xmin,
             suffix_entry.ctid
      from runtime_state_store suffix_entry
      where selector.selector_kind = 'prefix-suffix'
        and suffix_entry.store_namespace = selector.store_namespace
        and reverse(suffix_entry.store_key) collate "C" >= selector.reversed_suffix
        and reverse(suffix_entry.store_key) collate "C" < selector.reversed_suffix_end
        and suffix_entry.store_key collate "C" >= selector.key_prefix
        and suffix_entry.store_key collate "C" < selector.prefix_end
        and char_length(suffix_entry.store_key)
          >= char_length(selector.key_prefix) + char_length(selector.key_suffix)

      union all

      select reversed_entry.store_key,
             reversed_entry.store_value,
             reversed_entry.expire_at_ts,
             reversed_entry.updated_ts,
             reversed_entry.revision,
             reversed_entry.xmin,
             reversed_entry.ctid
      from runtime_state_store reversed_entry
      where selector.selector_kind = 'suffix'
        and reversed_entry.store_namespace = selector.store_namespace
        and reverse(reversed_entry.store_key) collate "C" >= selector.reversed_suffix
        and reverse(reversed_entry.store_key) collate "C" < selector.reversed_suffix_end
    ) matched on true
    order by selector.selector_ordinal, matched.store_key collate "C"
  `;
}

function toSqlSelector(
    selector: RuntimeStateReadBatchSelector
): PSqlRuntimeStateReadBatchSelector {
    switch (selector.kind) {
        case 'key':
            return { ...selector, ...NO_SQL_SELECTOR_BOUNDS, keyPrefix: null, keySuffix: null };
        case 'prefix':
            return {
                ...selector,
                ...NO_SQL_SELECTOR_BOUNDS,
                key: null,
                keySuffix: null,
                prefixEnd: toExclusivePrefixEnd(selector.keyPrefix)
            };
        case 'prefix-suffix':
            return {
                ...selector,
                ...toReversedSuffixBounds(selector.keySuffix),
                key: null,
                prefixEnd: toExclusivePrefixEnd(selector.keyPrefix)
            };
        case 'suffix':
            return {
                ...selector,
                ...toReversedSuffixBounds(selector.keySuffix),
                key: null,
                keyPrefix: null,
                prefixEnd: null
            };
    }
}

function toReversedSuffixBounds(
    keySuffix: string
): Pick<PSqlRuntimeStateReadBatchSelector, 'reversedSuffix' | 'reversedSuffixEnd'> {
    const reversedSuffix = toReversedKey(keySuffix);
    return { reversedSuffix, reversedSuffixEnd: toExclusivePrefixEnd(reversedSuffix) };
}

/** Code-point order, as Postgres `reverse()` reverses characters, never UTF-16 units. */
function toReversedKey(key: string): string {
    return Array.from(key).reverse().join('');
}
