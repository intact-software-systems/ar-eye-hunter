import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
import type { PSqlRows } from '../../postgres/p-sql-sql.ts';
import { assertRuntimeStateReadBatchResult } from '../read-batch/assert-runtime-state-read-batch-result.ts';
import { assertRuntimeStateReadBatchSelectors } from '../read-batch/assert-runtime-state-read-batch-selectors.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector,
    RuntimeStateReadBatchVersion,
    RuntimeStateStoredValueFields,
    RuntimeStateVersionedReadBatch
} from '../read-batch/runtime-state-read-batch.ts';
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
    readonly storedValueContains: RuntimeStateStoredValueFields | null;
    readonly expiringAfterTimestamp: number | null;
    readonly prefixEnd: string | null;
    readonly reversedSuffix: string | null;
    readonly reversedSuffixEnd: string | null;
}

const NO_SQL_SELECTOR_FIELDS = {
    key: null,
    keyPrefix: null,
    keySuffix: null,
    storedValueContains: null,
    expiringAfterTimestamp: null,
    prefixEnd: null,
    reversedSuffix: null,
    reversedSuffixEnd: null
} as const;

const SELECTED_RUNTIME_STATE_ROWS = toSelectedRuntimeStateRows();

export interface RuntimeStateReadBatchQuery {
    <Rows extends PSqlRows>(
        strings: TemplateStringsArray,
        ...values: readonly (object | boolean)[]
    ): Promise<Rows>;
}

/**
 * One statement for every selector, returned as one row per selected entry in caller order and C key
 * order: an aggregated JSON document would re-escape every stored value inside one string.
 */
export async function readRuntimeStateBatch(
    sql: RuntimeStateReadBatchQuery,
    input: readonly RuntimeStateReadBatchSelector[]
): Promise<readonly RuntimeStateReadBatchSelection[]> {
    const selectors = assertRuntimeStateReadBatchSelectors(input);
    const rows = await selectRuntimeStateBatchRows(sql, selectors, true);
    return assertRuntimeStateReadBatchResult(selectors, toRuntimeStateReadBatchSelections(selectors, rows));
}

/**
 * The selection with the version of exactly the rows it returned, from the same statement and so the same
 * database snapshot: a value assembled from these rows is current for as long as a probe reports this
 * version.
 */
export async function readRuntimeStateBatchWithVersion(
    sql: RuntimeStateReadBatchQuery,
    input: readonly RuntimeStateReadBatchSelector[]
): Promise<RuntimeStateVersionedReadBatch> {
    const selectors = assertRuntimeStateReadBatchSelectors(input);
    const rows = await selectRuntimeStateBatchRows(sql, selectors, true);
    return {
        selections: assertRuntimeStateReadBatchResult(selectors, toRuntimeStateReadBatchSelections(selectors, rows)),
        version: toRuntimeStateReadBatchVersion(selectors, rows)
    };
}

/**
 * The same selection without the stored values, reduced to the identity of every selected row
 * version: any write of a selected row, a delete and re-insert included, writes a new row
 * version, so equal versions mean no selected row was written in between.
 */
export async function readRuntimeStateBatchVersion(
    sql: RuntimeStateReadBatchQuery,
    input: readonly RuntimeStateReadBatchSelector[]
): Promise<RuntimeStateReadBatchVersion | undefined> {
    const selectors = assertRuntimeStateReadBatchSelectors(input);
    return toRuntimeStateReadBatchVersion(selectors, await selectRuntimeStateBatchRows(sql, selectors, false));
}

async function selectRuntimeStateBatchRows(
    sql: RuntimeStateReadBatchQuery,
    selectors: readonly RuntimeStateReadBatchSelector[],
    includeValues: boolean
): Promise<readonly PSqlRuntimeStateReadBatchRow[]> {
    const statement = PSqlFragment.of`
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
             descriptor.value -> 'storedValueContains' as stored_value_contains,
             (descriptor.value ->> 'expiringAfterTimestamp')::numeric as expiring_after_timestamp,
             descriptor.value ->> 'prefixEnd' as prefix_end,
             descriptor.value ->> 'reversedSuffix' as reversed_suffix,
             descriptor.value ->> 'reversedSuffixEnd' as reversed_suffix_end
      from jsonb_array_elements(${selectors.map(toSqlSelector)}::jsonb)
        with ordinality as descriptor(value, ordinality)
    ) selector
    join lateral (${SELECTED_RUNTIME_STATE_ROWS}) matched on true
    order by selector.selector_ordinal, matched.store_key collate "C"
  `;
    return await sql<PSqlRuntimeStateReadBatchRow[]>(...statement.toStatement());
}

/** The rows of every selector kind, one union branch per kind; a selector joins only the branch of its own kind. */
function toSelectedRuntimeStateRows(): PSqlFragment<never> {
    return [
        toKeySelectedRows(),
        toPrefixSelectedRows(),
        toPrefixContainingSelectedRows(),
        toPrefixExpiringAfterSelectedRows(),
        toPrefixSuffixSelectedRows(),
        toSuffixSelectedRows()
    ].reduce((union, rows) =>
        PSqlFragment.of`${union}

      union all
${rows}`
    );
}

function toKeySelectedRows(): PSqlFragment<never> {
    const entry = PSqlFragment.identifier('exact_entry');
    return PSqlFragment.of`${toSelectedEntryColumns(entry)}
      where selector.selector_kind = 'key'
        and ${entry}.store_namespace = selector.store_namespace
        and ${entry}.store_key = selector.store_key`;
}

function toPrefixSelectedRows(): PSqlFragment<never> {
    const entry = PSqlFragment.identifier('prefix_entry');
    return PSqlFragment.of`${toSelectedEntryColumns(entry)}
      where selector.selector_kind = 'prefix'
        and ${entry}.store_namespace = selector.store_namespace
        and ${toKeyPrefixRange(entry)}`;
}

function toPrefixContainingSelectedRows(): PSqlFragment<never> {
    const entry = PSqlFragment.identifier('containing_entry');
    return PSqlFragment.of`${toSelectedEntryColumns(entry)}
      where selector.selector_kind = 'prefix-containing'
        and ${entry}.store_namespace = selector.store_namespace
        and ${toKeyPrefixRange(entry)}
        and ${entry}.store_value::jsonb @> selector.stored_value_contains`;
}

function toPrefixExpiringAfterSelectedRows(): PSqlFragment<never> {
    const entry = PSqlFragment.identifier('expiring_entry');
    return PSqlFragment.of`${toSelectedEntryColumns(entry)}
      where selector.selector_kind = 'prefix-expiring-after'
        and ${entry}.store_namespace = selector.store_namespace
        and ${toKeyPrefixRange(entry)}
        and extract(epoch from ${entry}.expire_at_ts) * 1000 > selector.expiring_after_timestamp`;
}

function toPrefixSuffixSelectedRows(): PSqlFragment<never> {
    const entry = PSqlFragment.identifier('suffix_entry');
    return PSqlFragment.of`${toSelectedEntryColumns(entry)}
      where selector.selector_kind = 'prefix-suffix'
        and ${entry}.store_namespace = selector.store_namespace
        and ${toReversedSuffixRange(entry)}
        and ${toKeyPrefixRange(entry)}
        and char_length(${entry}.store_key)
          >= char_length(selector.key_prefix) + char_length(selector.key_suffix)`;
}

function toSuffixSelectedRows(): PSqlFragment<never> {
    const entry = PSqlFragment.identifier('reversed_entry');
    return PSqlFragment.of`${toSelectedEntryColumns(entry)}
      where selector.selector_kind = 'suffix'
        and ${entry}.store_namespace = selector.store_namespace
        and ${toReversedSuffixRange(entry)}`;
}

function toSelectedEntryColumns(entry: PSqlFragment<never>): PSqlFragment<never> {
    return PSqlFragment.of`
      select ${entry}.store_key,
             ${entry}.store_value,
             ${entry}.expire_at_ts,
             ${entry}.updated_ts,
             ${entry}.revision,
             ${entry}.xmin,
             ${entry}.ctid
      from runtime_state_store ${entry}`;
}

function toKeyPrefixRange(entry: PSqlFragment<never>): PSqlFragment<never> {
    return PSqlFragment.of`${entry}.store_key collate "C" >= selector.key_prefix
        and ${entry}.store_key collate "C" < selector.prefix_end`;
}

function toReversedSuffixRange(entry: PSqlFragment<never>): PSqlFragment<never> {
    return PSqlFragment.of`reverse(${entry}.store_key) collate "C" >= selector.reversed_suffix
        and reverse(${entry}.store_key) collate "C" < selector.reversed_suffix_end`;
}

function toSqlSelector(
    selector: RuntimeStateReadBatchSelector
): PSqlRuntimeStateReadBatchSelector {
    switch (selector.kind) {
        case 'key':
            return { ...NO_SQL_SELECTOR_FIELDS, ...selector };
        case 'prefix':
        case 'prefix-containing':
        case 'prefix-expiring-after':
            return { ...NO_SQL_SELECTOR_FIELDS, ...selector, prefixEnd: toExclusivePrefixEnd(selector.keyPrefix) };
        case 'prefix-suffix':
            return {
                ...NO_SQL_SELECTOR_FIELDS,
                ...selector,
                ...toReversedSuffixBounds(selector.keySuffix),
                prefixEnd: toExclusivePrefixEnd(selector.keyPrefix)
            };
        case 'suffix':
            return { ...NO_SQL_SELECTOR_FIELDS, ...selector, ...toReversedSuffixBounds(selector.keySuffix) };
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
