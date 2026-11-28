import { DIRECT_WRITE_FACT_SETS } from './direct-write-registry.mjs';

/** Entry fields a pin does not repeat: the identity is the label, and the basis is prose. */
const UNPINNED_FIELDS = new Set(['id', 'basis', 'class']);

/**
 * Compares the registry with `direct-write-review-pins.json`, a second file the check reads. An approval, a new
 * store, a surface added, removed or given another class, and a `transport-direct` surface whose computed attributes
 * or stores moved all fail the blocking check until that file changes too. Returns every issue and never throws.
 */
export function validateDirectWriteReviewPins(registry, pins) {
    if (!isReviewPins(pins)) {
        return ['the review pins must hold approvedStoreIds, stores and surfaces'];
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
        ...validateSurfaces(toSurfaces(registry), pins.surfaces)
    ];
}

function validateListEquals({ foundPhrase, pinnedPhrase, found, pinned }) {
    const foundText = `[${found.toSorted().join(', ')}]`;
    const pinnedText = `[${[...pinned].toSorted().join(', ')}]`;
    return foundText === pinnedText ? [] : [`${foundPhrase} ${foundText}, ${pinnedPhrase} ${pinnedText}`];
}

function validateSurfaces(surfaces, pinnedSurfaces) {
    const found = new Map(surfaces.map((surface) => [surface.label, surface.entry]));
    const issues = [...found.keys()].toSorted().flatMap((label) => {
        const entry = found.get(label);
        const pinned = pinnedSurfaces[label];
        if (pinned === undefined) {
            return [`${label}: a surface the review pins do not hold`];
        }
        if (pinned.class !== entry.class) {
            return [`${label}: class ${entry.class}, the review pins hold ${pinned.class}`];
        }
        return validatePinnedAttributes(label, entry, pinned);
    });
    const missing = Object.keys(pinnedSurfaces).filter((label) => !found.has(label)).toSorted()
        .map((label) => `${label}: a pinned surface the registry does not hold`);
    return [...issues, ...missing];
}

/** A transport-direct surface belongs to a store under review, so what it computes is pinned as well as its class. */
function validatePinnedAttributes(label, entry, pinned) {
    if (entry.class !== 'transport-direct') {
        return [];
    }
    const foundText = toSortedJson(toPinnedAttributes(entry));
    const pinnedText = toSortedJson(toPinnedAttributes(pinned));
    return foundText === pinnedText
        ? []
        : [`${label}: the registry holds ${foundText}, the review pins hold ${pinnedText}`];
}

function toPinnedAttributes(entry) {
    return Object.fromEntries(Object.entries(entry).filter(([field]) => !UNPINNED_FIELDS.has(field)));
}

function toSurfaces(registry) {
    return DIRECT_WRITE_FACT_SETS.flatMap((factSet) =>
        (registry[factSet] ?? []).map((entry) => ({ label: `${factSet} ${entry.id}`, entry }))
    );
}

function toSortedJson(value) {
    return JSON.stringify(
        Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left < right ? -1 : 1))
    );
}

function isReviewPins(pins) {
    return typeof pins === 'object' && pins !== null &&
        Array.isArray(pins.approvedStoreIds) &&
        Array.isArray(pins.stores) &&
        typeof pins.surfaces === 'object' && pins.surfaces !== null && !Array.isArray(pins.surfaces);
}
