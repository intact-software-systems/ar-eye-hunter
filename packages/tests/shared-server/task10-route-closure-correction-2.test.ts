import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import * as boundaryAnalysis from './mutation-boundary-analysis.ts';
import {
  MUTATION_ROUTE_INVENTORY,
  validateMutationRouteInventory,
} from './mutation-routing-inventory.ts';

const TRANSITIVE_FIXTURE =
  'packages/tests/shared-server/fixtures/mutation-boundary-transitive/root.ts';

describe('Task 10 route-closure correction 2 contracts', () => {
  it('finds forbidden mutations in recursively imported helpers without listing them', () => {
    const findViolations = (boundaryAnalysis as unknown as {
      findMutationBoundaryViolationsFromRoots?: (
        roots: readonly string[],
      ) => readonly boundaryAnalysis.MutationBoundaryViolation[];
    }).findMutationBoundaryViolationsFromRoots;

    expect(findViolations).toBeTypeOf('function');
    if (!findViolations) return;
    const violations = findViolations([TRANSITIVE_FIXTURE]);

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: expect.stringContaining('through-helper.ts'),
        directMutatorCalls: ['connectSession'],
      }),
    ]);
  });

  it('always rejects incomplete and duplicate inventories', () => {
    expect(validateMutationRouteInventory([])).toContain(
      'Expected 50 entrypoints, found 0',
    );
    expect(validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY.slice(0, 49)))
      .toContain('Expected 50 entrypoints, found 49');
    expect(validateMutationRouteInventory([
      ...MUTATION_ROUTE_INVENTORY.slice(0, 49),
      MUTATION_ROUTE_INVENTORY[0]!,
    ])).toEqual(expect.arrayContaining([
      expect.stringContaining('Duplicate mutation route'),
      'Inventory must cover all 46 AppInbox command types',
    ]));
  });

  it('binds authorised websocket types to their real owner methods', () => {
    const byType = new Map(MUTATION_ROUTE_INVENTORY.map((entry) => [entry.type, entry]));

    expect(byType.get(AppInboxType.CLIENT_AUTHORISED_WS_CONNECT)?.owner).toBe(
      'AppClientInboxService.processAuthorisedWsConnect',
    );
    expect(byType.get(AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT)?.owner).toBe(
      'AppClientInboxService.processAuthorisedWsDisconnect',
    );
  });

  it('rejects route, type, owner, handoff method, and source mutations', () => {
    const first = MUTATION_ROUTE_INVENTORY[0]!;
    const second = MUTATION_ROUTE_INVENTORY[1]!;
    const mutations = [
      { ...first, entrypoint: `${first.entrypoint}/wrong` },
      { ...first, type: second.type },
      { ...first, owner: 'AppClientInboxService.processAuthorisedWsConnect' },
      { ...first, enqueueMarker: 'readSnapshot' },
      { ...first, sourcePath: 'apps/api-v1/src/routes/ws-routes.ts' },
    ];

    for (const mutation of mutations) {
      const inventory = MUTATION_ROUTE_INVENTORY.map((entry, index) =>
        index === 0 ? mutation : entry
      );
      expect(validateMutationRouteInventory(inventory), mutation).not.toEqual([]);
    }
  });
});
