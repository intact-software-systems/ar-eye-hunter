import type { MutationRouteInventoryEntry } from './mutation-routing-inventory.ts';

export interface MutationRouteResult {
    readonly issues: readonly string[];
    /** Every source path the route's analysis requested, including reads that failed. */
    readonly readPaths: ReadonlySet<string>;
}

// A route's issues depend only on its entry fields, the text of the sources it read and which import
// candidates exist on disk. The memo assumes files on disk do not change while one test file runs: that
// fixes the text of every source read without an override and the outcome of every existence check.
// A result is therefore remembered only when none of the sources it read was overridden, and reused
// only while the entry is field-for-field the same and no source it read is overridden.
export class MutationRouteResultMemo {
    readonly #resultsByEntry = new Map<string, MutationRouteResult>();

    getIssues(
        entry: MutationRouteInventoryEntry,
        sourceOverrides: ReadonlyMap<string, string>
    ): readonly string[] | undefined {
        const result = this.#resultsByEntry.get(toEntryMemoKey(entry));
        return result && !hasOverriddenSource(result, sourceOverrides) ? result.issues : undefined;
    }

    setResult(
        entry: MutationRouteInventoryEntry,
        result: MutationRouteResult,
        sourceOverrides: ReadonlyMap<string, string>
    ): boolean {
        if (hasOverriddenSource(result, sourceOverrides)) {
            return false;
        }
        this.#resultsByEntry.set(toEntryMemoKey(entry), result);
        return true;
    }
}

function toEntryMemoKey(entry: MutationRouteInventoryEntry): string {
    return JSON.stringify(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)));
}

function hasOverriddenSource(result: MutationRouteResult, sourceOverrides: ReadonlyMap<string, string>): boolean {
    return [...result.readPaths].some((path) => sourceOverrides.has(path));
}
