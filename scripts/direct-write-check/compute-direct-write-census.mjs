import { DIRECT_WRITE_FACT_SETS, DIRECT_WRITE_SCOPE_LISTS } from './direct-write-registry.mjs';

/**
 * The census the gate prints on success, then every entry, and every value of a list that decides what the check
 * computes, that differs from the registry at the base.
 */
export function computeDirectWriteCensusLines(registry, base) {
    const stores = registry.stores ?? [];
    const underReview = stores.filter((store) => store.review?.state === 'under-review').length;
    const approved = stores.filter((store) => store.review?.state === 'approved').length;
    const surfaces = DIRECT_WRITE_FACT_SETS.reduce((total, factSet) => total + (registry[factSet] ?? []).length, 0);
    const census = `direct-write registry: ${stores.length} transport-direct store${stores.length === 1 ? '' : 's'} ` +
        `(${underReview} under review, ${approved} approved); ${surfaces} surfaces`;
    if (base.kind === 'unavailable') {
        return [census, `against ${base.label}: base not available`];
    }
    const differences = [
        ...DIRECT_WRITE_SCOPE_LISTS.flatMap((listName) =>
            computeScopeDifferences(listName, registry[listName] ?? [], base.registry[listName] ?? [])
        ),
        ...['stores', ...DIRECT_WRITE_FACT_SETS].flatMap((listName) =>
            computeListDifferences(listName, registry[listName] ?? [], base.registry[listName] ?? [])
        )
    ];
    const count = (marker) => differences.filter((line) => line.startsWith(marker)).length;
    return [
        census,
        `against ${base.label}: +${count('+ ')} -${count('- ')} ~${count('~ ')}`,
        ...differences
    ];
}

function computeScopeDifferences(listName, values, baseValues) {
    const current = new Set(values.map(toScopeValue));
    const previous = new Set(baseValues.map(toScopeValue));
    return [
        ...[...current].filter((value) => !previous.has(value)).map((value) => `+ scope ${listName} ${value}`),
        ...[...previous].filter((value) => !current.has(value)).map((value) => `- scope ${listName} ${value}`)
    ];
}

function toScopeValue(value) {
    return typeof value === 'string' ? value : `${value.path}#${value.name}`;
}

function computeListDifferences(listName, entries, baseEntries) {
    const baseById = new Map(baseEntries.map((entry) => [entry.id, entry]));
    const ids = new Set(entries.map((entry) => entry.id));
    const lines = [];
    for (const entry of entries) {
        const baseEntry = baseById.get(entry.id);
        if (baseEntry === undefined) {
            lines.push(`+ ${toEntryLabel(listName, entry)}`);
        }
        else if (JSON.stringify(baseEntry) !== JSON.stringify(entry)) {
            lines.push(`~ ${toEntryLabel(listName, entry)}${toReviewChange(baseEntry, entry)}`);
        }
    }
    for (const baseEntry of baseEntries.filter((candidate) => !ids.has(candidate.id))) {
        lines.push(`- ${toEntryLabel(listName, baseEntry)}`);
    }
    return lines;
}

function toEntryLabel(listName, entry) {
    return `${listName} ${entry.id} (${entry.class})`;
}

function toReviewChange(baseEntry, entry) {
    const before = baseEntry.review?.state;
    const after = entry.review?.state;
    return before === after ? '' : `: review ${before ?? 'none'} -> ${after ?? 'none'}`;
}
