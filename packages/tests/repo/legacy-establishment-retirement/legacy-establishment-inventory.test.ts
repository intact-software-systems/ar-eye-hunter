import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    LEGACY_ESTABLISHMENT_RECIPE_EPOCH_ASSERTIONS,
    LEGACY_ESTABLISHMENT_RECIPE_ROOT,
    LEGACY_ESTABLISHMENT_RECIPE_SITES,
    LEGACY_ESTABLISHMENT_ROUTE_PATH_SEGMENT,
    LEGACY_ESTABLISHMENT_SURFACES
} from './legacy-establishment-inventory.ts';

/**
 * Slice 5d inventories what slice 8d removes; nothing leaves here. The
 * inventory earns its place only if it cannot drift, so every entry is
 * recomputed from the tree and compared against the declaration: a new
 * `establish` caller fails this test until it is inventoried, and a surface
 * that disappears early fails it too.
 */
describe('legacy start-establishment retirement inventory', () => {
    it('declares exactly the establish call sites the recipe tree contains', () => {
        expect(scanRecipeSites()).toEqual(
            LEGACY_ESTABLISHMENT_RECIPE_SITES.map((site) => ({
                recipe: site.recipe,
                requestIdTemplate: site.requestIdTemplate
            }))
        );
    });

    it('still finds every non-recipe surface the cutover has to remove', () => {
        for (const surface of LEGACY_ESTABLISHMENT_SURFACES) {
            expect(existsSync(surface.file), surface.file).toBe(true);
            expect(readFileSync(surface.file, 'utf8'), surface.file).toContain(surface.marker);
        }
    });

    /**
     * The cutover's real cost. One `establish` POST advances the formation
     * epoch once; its replacement is `plan` (forming -> planned) plus
     * `connect` (planned -> connecting), which advance it twice. Every
     * `formationEpoch` assertion after an establish call therefore shifts,
     * so the count is recorded per recipe rather than discovered in 8d.
     */
    it('records the formation-epoch assertions each rewrite has to renumber', () => {
        expect(LEGACY_ESTABLISHMENT_RECIPE_EPOCH_ASSERTIONS).toEqual(
            LEGACY_ESTABLISHMENT_RECIPE_EPOCH_ASSERTIONS.map((entry) => ({
                recipe: entry.recipe,
                formationEpochAssertions: countFormationEpochAssertions(entry.recipe)
            }))
        );

        // Every recipe that owns a call site is counted, and no other.
        expect(LEGACY_ESTABLISHMENT_RECIPE_EPOCH_ASSERTIONS.map((entry) => entry.recipe)).toEqual(
            [...new Set(LEGACY_ESTABLISHMENT_RECIPE_SITES.map((site) => site.recipe))].sort()
        );
    });
});

interface ScannedSite {
    readonly recipe: string;
    readonly requestIdTemplate: string;
}

function scanRecipeSites(): readonly ScannedSite[] {
    return readdirSync(LEGACY_ESTABLISHMENT_RECIPE_ROOT)
        .filter((entry) => entry.endsWith('.json'))
        .sort()
        .flatMap((entry) => readRecipeSites(entry));
}

function readRecipeSites(recipe: string): readonly ScannedSite[] {
    const contents = readFileSync(path.join(LEGACY_ESTABLISHMENT_RECIPE_ROOT, recipe), 'utf8');
    const pattern = new RegExp(`${LEGACY_ESTABLISHMENT_ROUTE_PATH_SEGMENT}/([^"]+)`, 'gu');
    return [...contents.matchAll(pattern)].map((match) => ({
        recipe,
        requestIdTemplate: match[1]
    }));
}

function countFormationEpochAssertions(recipe: string): number {
    const contents = readFileSync(path.join(LEGACY_ESTABLISHMENT_RECIPE_ROOT, recipe), 'utf8');
    return [...contents.matchAll(/"formationEpoch"/gu)].length;
}
