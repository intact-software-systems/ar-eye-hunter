import type { MutationRouteInventoryEntry } from './mutation-routing-inventory.ts';

export interface MutationRouteResult {
    readonly issues: readonly string[];
    /** Every source path the route's analysis requested, including reads that failed to parse. */
    readonly readPaths: ReadonlySet<string>;
}

// A route's issues depend only on its entry fields and the text of the sources it read. A result is
// therefore remembered only when none of those sources was overridden, and reused only while the
// entry is field-for-field the same and no source it read is overridden.
export class MutationRouteResultMemo {
    readonly #resultsByEntry = new Map<string, MutationRouteResult>();

    getIssues(
        entry: MutationRouteInventoryEntry,
        sourceOverrides: ReadonlyMap<string, string>
    ): readonly string[] | undefined {
        const result = this.#resultsByEntry.get(toEntryMemoKey(entry));
        return result && !readsOverriddenSource(result, sourceOverrides) ? result.issues : undefined;
    }

    setResult(
        entry: MutationRouteInventoryEntry,
        result: MutationRouteResult,
        sourceOverrides: ReadonlyMap<string, string>
    ): void {
        if (!readsOverriddenSource(result, sourceOverrides)) {
            this.#resultsByEntry.set(toEntryMemoKey(entry), result);
        }
    }
}

function toEntryMemoKey(entry: MutationRouteInventoryEntry): string {
    return JSON.stringify(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)));
}

function readsOverriddenSource(result: MutationRouteResult, sourceOverrides: ReadonlyMap<string, string>): boolean {
    return [...result.readPaths].some((path) => sourceOverrides.has(path));
}
