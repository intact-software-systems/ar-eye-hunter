import type { JsonWireObject, JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import type {
    RuntimeStateReadBatchSelector,
    RuntimeStateReadBatchVersion
} from '../read-batch/runtime-state-read-batch.ts';

const ROW_FIELD_SEPARATOR = '\u001f';
const ROW_SEPARATOR = '\u001e';
const SELECTOR_SEPARATOR = '\u001d';

/** One selected entry as the driver returns it; the integers travel as text so no driver rounds them. */
export interface PSqlRuntimeStateReadBatchRow {
    readonly selector_ordinal: number;
    readonly store_key: string;
    /** Null in a version probe, which selects the rows without their values. */
    readonly store_value: string | null;
    readonly expire_at_timestamp: string;
    readonly updated_timestamp: string;
    readonly revision: string;
    /** The row version's transaction and location, which every write of the row replaces. */
    readonly row_version: string;
}

/** The driver rows grouped back into one selection per selector, in caller order, for the shared result validator. */
export function toRuntimeStateReadBatchSelections(
    selectors: readonly RuntimeStateReadBatchSelector[],
    rows: readonly PSqlRuntimeStateReadBatchRow[]
): JsonWireValue {
    return toRowsBySelector(selectors, rows).map((selectorRows, index) => ({
        selectorId: selectors[index].selectorId,
        entries: selectorRows.map(toRuntimeStateReadBatchEntry)
    }));
}

/** The probed row versions in selector order and key order; undefined when no row is selected. */
export function toRuntimeStateReadBatchVersion(
    selectors: readonly RuntimeStateReadBatchSelector[],
    rows: readonly PSqlRuntimeStateReadBatchRow[]
): RuntimeStateReadBatchVersion | undefined {
    if (rows.length === 0) {
        return undefined;
    }
    return {
        version: toRowsBySelector(selectors, rows)
            .map((selectorRows) =>
                selectorRows.map((row) => [row.store_key, row.revision, row.row_version].join(ROW_FIELD_SEPARATOR))
                    .join(ROW_SEPARATOR)
            )
            .join(SELECTOR_SEPARATOR),
        expireAtEpochMs: [...new Set(rows.map((row) => Number(row.expire_at_timestamp)))]
    };
}

/**
 * The version of each consecutive selector group within one batch version, exactly as a batch of that group alone
 * reports it: undefined when the group selects no row.
 */
export function splitRuntimeStateReadBatchVersion(
    version: RuntimeStateReadBatchVersion | undefined,
    selectorCounts: readonly number[]
): readonly (string | undefined)[] {
    if (version === undefined) {
        return selectorCounts.map(() => undefined);
    }
    const segments = version.version.split(SELECTOR_SEPARATOR);
    const selectorCount = selectorCounts.reduce((total, count) => total + count, 0);
    if (segments.length !== selectorCount) {
        throw new Error(
            `Invalid runtime state read batch version: ${segments.length} selector segments for ${selectorCount} selectors`
        );
    }
    let start = 0;
    return selectorCounts.map((count) => {
        const groupSegments = segments.slice(start, start + count);
        start += count;
        return groupSegments.every((segment) => segment === '') ? undefined : groupSegments.join(SELECTOR_SEPARATOR);
    });
}

function toRowsBySelector(
    selectors: readonly RuntimeStateReadBatchSelector[],
    rows: readonly PSqlRuntimeStateReadBatchRow[]
): readonly (readonly PSqlRuntimeStateReadBatchRow[])[] {
    const rowsBySelector: PSqlRuntimeStateReadBatchRow[][] = selectors.map(() => []);
    for (const row of rows) {
        const selectorRows = rowsBySelector[row.selector_ordinal - 1];
        if (selectorRows === undefined) {
            throw new Error(
                `Invalid runtime state read batch database result: no selector at ordinal ${row.selector_ordinal}`
            );
        }
        selectorRows.push(row);
    }
    return rowsBySelector;
}

function toRuntimeStateReadBatchEntry(row: PSqlRuntimeStateReadBatchRow): JsonWireObject {
    return {
        key: row.store_key,
        value: row.store_value,
        expireAtTimestamp: toDriverInteger(row.expire_at_timestamp),
        updatedTimestamp: row.updated_timestamp,
        revision: toDriverInteger(row.revision)
    };
}

function toDriverInteger(input: string): JsonWireValue {
    if (!/^-?(0|[1-9]\d*)$/u.test(input)) {
        return input;
    }
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) ? parsed : input;
}
