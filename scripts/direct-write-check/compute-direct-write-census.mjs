import { DIRECT_WRITE_FACT_SETS } from './direct-write-registry.mjs';

/** The census the gate prints on success, and every entry that differs from the base branch's registry. */
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
    const differences = ['stores', ...DIRECT_WRITE_FACT_SETS].flatMap((listName) =>
        computeListDifferences(listName, registry[listName] ?? [], base.registry[listName] ?? [])
    );
    const count = (marker) => differences.filter((line) => line.startsWith(marker)).length;
    return [
        census,
        `against ${base.label}: +${count('+ ')} -${count('- ')} ~${count('~ ')}`,
        ...differences
    ];
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
