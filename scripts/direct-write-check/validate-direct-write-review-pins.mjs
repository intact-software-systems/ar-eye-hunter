import { DIRECT_WRITE_FACT_SETS } from './direct-write-registry.mjs';

/**
 * Compares the registry with `direct-write-review-pins.json`, a second file the check reads, so that an approval, a new
 * store, a new or removed transport-direct surface, or a surface added or given another class fails the blocking
 * check until that file changes too. Returns every issue and never throws.
 */
export function validateDirectWriteReviewPins(registry, pins) {
    if (!isReviewPins(pins)) {
        return ['the review pins must hold approvedStoreIds, stores, transportDirectSurfaces and classCounts'];
    }
    const stores = registry.stores ?? [];
    return [
        ...validateListEquals({
            foundPhrase: 'stores: the registry approves',
            pinnedPhrase: 'the review pins approve',
            found: stores.filter((store) => store.review?.state === 'approved').map((store) => store.id),
            pinned: pins.approvedStoreIds
        }),
        ...validateListEquals({
            foundPhrase: 'stores: the registry holds',
            pinnedPhrase: 'the review pins hold',
            found: stores.map((store) => `${store.id} ${store.review?.state}`),
            pinned: pins.stores.map((store) => `${store.id} ${store.state}`)
        }),
        ...validateTransportDirectSurfaces(toSurfaces(registry), pins.transportDirectSurfaces),
        ...validateClassCounts(toSurfaces(registry), pins.classCounts)
    ];
}

function validateListEquals({ foundPhrase, pinnedPhrase, found, pinned }) {
    const foundText = `[${found.toSorted().join(', ')}]`;
    const pinnedText = `[${[...pinned].toSorted().join(', ')}]`;
    return foundText === pinnedText ? [] : [`${foundPhrase} ${foundText}, ${pinnedPhrase} ${pinnedText}`];
}

function validateTransportDirectSurfaces(surfaces, pinnedSurfaces) {
    const found = new Set(
        surfaces.filter((surface) => surface.entry.class === 'transport-direct').map((surface) => surface.label)
    );
    const pinned = new Set(pinnedSurfaces);
    return [
        ...[...found].filter((label) => !pinned.has(label)).toSorted()
            .map((label) => `${label}: a transport-direct surface the review pins do not hold`),
        ...[...pinned].filter((label) => !found.has(label)).toSorted()
            .map((label) => `${label}: a pinned transport-direct surface the registry does not hold`)
    ];
}

function validateClassCounts(surfaces, pinnedCounts) {
    const counts = {};
    for (const surface of surfaces) {
        counts[surface.entry.class] = (counts[surface.entry.class] ?? 0) + 1;
    }
    const foundText = toSortedJson(counts);
    const pinnedText = toSortedJson(pinnedCounts);
    return foundText === pinnedText
        ? []
        : [`classes: the registry holds ${foundText}, the review pins hold ${pinnedText}`];
}

function toSurfaces(registry) {
    return DIRECT_WRITE_FACT_SETS.flatMap((factSet) =>
        (registry[factSet] ?? []).map((entry) => ({ label: `${factSet} ${entry.id}`, entry }))
    );
}

function toSortedJson(counts) {
    return JSON.stringify(
        Object.fromEntries(Object.entries(counts).toSorted(([left], [right]) => left < right ? -1 : 1))
    );
}

function isReviewPins(pins) {
    return typeof pins === 'object' && pins !== null &&
        Array.isArray(pins.approvedStoreIds) &&
        Array.isArray(pins.stores) &&
        Array.isArray(pins.transportDirectSurfaces) &&
        typeof pins.classCounts === 'object' && pins.classCounts !== null;
}
