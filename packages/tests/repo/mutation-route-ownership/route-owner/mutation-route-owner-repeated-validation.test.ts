import { describe, expect, it } from 'vitest';

import { MutationRouteResultMemo } from '../routing/mutation-route-result-memo.ts';
import {
    MUTATION_ROUTE_INVENTORY,
    validateMutationRouteInventoryWithMemo,
    type MutationRouteInventoryEntry
} from '../routing/mutation-routing-inventory.ts';
import { GROUP_OWNER_PATH, readGroupOwnerAnchors } from './mutation-route-owner-anchors.ts';

// A validator that has already analysed routes must report exactly what a fresh one reports: a remembered
// route result may never stand in for a route whose entry or whose read sources changed.

const CRDT_ADMIN_MUTATIONS = 'apps/api-v1/src/crdt/create-crdt-admin-mutations.ts';
const ADMIN_CRDT_COMPACT = 'POST /api/admin/operations/crdt/compact/requests/:requestId';
const GROUP_CREATE = requireRoute((entry) => entry.transport === 'HTTP' && entry.type === 'GROUP_CREATE');
const GROUP_UPDATE = requireRoute((entry) => entry.transport === 'HTTP' && entry.type === 'GROUP_UPDATE');
const CRDT_COMPACT = requireRoute((entry) => entry.entrypoint === ADMIN_CRDT_COMPACT);
const ROUTES = [GROUP_CREATE, GROUP_UPDATE, CRDT_COMPACT];
const NO_OVERRIDES = new Map<string, string>();
const { source: GROUP_OWNER_SOURCE, collection: GROUP_COLLECTION } = readGroupOwnerAnchors();

describe('repeated mutation route inventory validation', () => {
    it('repeats the fresh result for an unchanged baseline', () => {
        const memo = new MutationRouteResultMemo();
        const cold = validateCold(ROUTES, NO_OVERRIDES);

        expect(validateWarm(memo, ROUTES, NO_OVERRIDES)).toEqual(cold);
        expect(validateWarm(memo, ROUTES, NO_OVERRIDES)).toEqual(cold);
    });

    it('reports a route disconnected by an override after a baseline', () => {
        const memo = new MutationRouteResultMemo();
        validateWarm(memo, ROUTES, NO_OVERRIDES);
        const disconnected = toGroupOwnerOverride('GROUP_MUTATION_INBOX_TYPES.filter(() => false)');

        const warm = validateWarm(memo, ROUTES, disconnected);

        expect(warm).toEqual(
            expect.arrayContaining([expect.stringContaining('GROUP_CREATE owner dispatch is not connected')])
        );
        expect(warm).toEqual(validateCold(ROUTES, disconnected));
    });

    it('analyses a second, different mutation of the same file afresh', () => {
        const memo = new MutationRouteResultMemo();
        const allExcluded = toGroupOwnerOverride('GROUP_MUTATION_INBOX_TYPES.filter(() => false)');
        const updateExcluded = toGroupOwnerOverride(
            'GROUP_MUTATION_INBOX_TYPES.filter((candidate) => candidate !== AppInboxType.GROUP_UPDATE)'
        );
        const coldAllExcluded = validateCold(ROUTES, allExcluded);
        const coldUpdateExcluded = validateCold(ROUTES, updateExcluded);
        expect(coldUpdateExcluded).not.toEqual(coldAllExcluded);

        expect(validateWarm(memo, ROUTES, allExcluded)).toEqual(coldAllExcluded);
        expect(validateWarm(memo, ROUTES, updateExcluded)).toEqual(coldUpdateExcluded);
    });

    it('analyses a route afresh when a source it reaches only by import is overridden', () => {
        const declaredPaths = [
            CRDT_COMPACT.sourcePath,
            CRDT_COMPACT.enqueueSourcePath,
            CRDT_COMPACT.ownerSourcePath,
            CRDT_COMPACT.typeOwnerSourcePath,
            CRDT_COMPACT.dispatchSourcePath
        ];
        expect(declaredPaths).not.toContain(CRDT_ADMIN_MUTATIONS);
        const memo = new MutationRouteResultMemo();
        validateWarm(memo, ROUTES, NO_OVERRIDES);
        const emptied = new Map([[CRDT_ADMIN_MUTATIONS, 'export {};\n']]);

        const warm = validateWarm(memo, ROUTES, emptied);

        expect(warm).toEqual(expect.arrayContaining([expect.stringContaining(`HTTP:${ADMIN_CRDT_COMPACT}:`)]));
        expect(warm).toEqual(validateCold(ROUTES, emptied));
    });

    it('analyses an entry with one changed field afresh', () => {
        const memo = new MutationRouteResultMemo();
        validateWarm(memo, ROUTES, NO_OVERRIDES);
        const changed = ROUTES.map((entry) => entry === GROUP_CREATE ? { ...entry, enqueueMarker: 'AppInboxType.GROUP_UPDATE' } : entry);

        const warm = validateWarm(memo, changed, NO_OVERRIDES);

        expect(warm).toEqual(expect.arrayContaining([expect.stringContaining('GROUP_CREATE has incorrect enqueueMarker')]));
        expect(warm).toEqual(validateCold(changed, NO_OVERRIDES));
    });
});

function validateWarm(
    memo: MutationRouteResultMemo,
    inventory: readonly MutationRouteInventoryEntry[],
    sourceOverrides: ReadonlyMap<string, string>
): readonly string[] {
    return validateMutationRouteInventoryWithMemo(memo, inventory, { sourceOverrides });
}

function validateCold(
    inventory: readonly MutationRouteInventoryEntry[],
    sourceOverrides: ReadonlyMap<string, string>
): readonly string[] {
    return validateWarm(new MutationRouteResultMemo(), inventory, sourceOverrides);
}

function toGroupOwnerOverride(collection: string): ReadonlyMap<string, string> {
    const mutated = GROUP_OWNER_SOURCE.replace(GROUP_COLLECTION, collection);
    expect(mutated).not.toBe(GROUP_OWNER_SOURCE);
    return new Map([[GROUP_OWNER_PATH, mutated]]);
}

function requireRoute(matches: (entry: MutationRouteInventoryEntry) => boolean): MutationRouteInventoryEntry {
    const route = MUTATION_ROUTE_INVENTORY.find(matches);
    if (!route) {
        throw new Error('A mutation route this suite exercises is absent from the inventory');
    }
    return route;
}
