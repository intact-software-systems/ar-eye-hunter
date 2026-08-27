import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { findMutationBoundaryViolationsFromRoots } from '../boundary/mutation-boundary-analysis.ts';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from '../routing/mutation-routing-inventory.ts';

const TRANSITIVE_FIXTURE = 'packages/tests/repo/mutation-route-ownership/fixtures/mutation-boundary-transitive/root.ts';

describe('Mutation route owner boundary traversal contracts', { timeout: 30_000 }, () => {
    it('finds forbidden mutations in recursively imported helpers without listing them', () => {
        const violations = findMutationBoundaryViolationsFromRoots([TRANSITIVE_FIXTURE]);

        expect(violations).toEqual([
            expect.objectContaining({
                filePath: expect.stringContaining('through-helper.ts'),
                directMutatorCalls: ['connectSession']
            })
        ]);
    });

    it('always rejects incomplete and duplicate inventories', () => {
        expect(validateMutationRouteInventory([])).toContain(
            'Expected 57 entrypoints, found 0'
        );
        expect(validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY.slice(0, 56))).toContain(
            'Expected 57 entrypoints, found 56'
        );
        expect(
            validateMutationRouteInventory([
                ...MUTATION_ROUTE_INVENTORY.slice(0, 56),
                MUTATION_ROUTE_INVENTORY[0]!
            ])
        ).toEqual(
            expect.arrayContaining([
                expect.stringContaining('Duplicate mutation route'),
                'Inventory must cover all 53 AppInbox command types'
            ])
        );
    });

    it('binds authorised websocket types to their real owner methods', () => {
        const byType = new Map(MUTATION_ROUTE_INVENTORY.map((entry) => [entry.type, entry]));

        expect(byType.get(AppInboxType.CLIENT_AUTHORISED_WS_CONNECT)?.owner).toBe(
            'ClientStateInboxHandler.processAuthorisedWsConnect'
        );
        expect(byType.get(AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT)?.owner).toBe(
            'ClientStateInboxHandler.processAuthorisedWsDisconnect'
        );
    });

    it('rejects route, type, owner, handoff method, and source mutations', () => {
        const first = MUTATION_ROUTE_INVENTORY[0]!;
        const second = MUTATION_ROUTE_INVENTORY[1]!;
        const mutations = [
            { ...first, entrypoint: `${first.entrypoint}/wrong` },
            { ...first, type: second.type },
            { ...first, owner: 'ClientStateInboxHandler.processAuthorisedWsConnect' },
            { ...first, enqueueMarker: 'readSnapshot' },
            { ...first, sourcePath: 'apps/api-v1/src/routes/ws-routes.ts' }
        ];

        for (const mutation of mutations) {
            const inventory = MUTATION_ROUTE_INVENTORY.map((entry, index) => index === 0 ? mutation : entry);
            expect(validateMutationRouteInventory(inventory), JSON.stringify(mutation)).not.toEqual([]);
        }
    });
});
