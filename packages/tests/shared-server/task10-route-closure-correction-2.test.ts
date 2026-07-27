import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import * as boundaryAnalysis from './mutation-boundary-analysis.ts';
import {
  MUTATION_ROUTE_INVENTORY,
  validateMutationRouteInventory,
} from './mutation-routing-inventory.ts';

const TRANSITIVE_FIXTURE =
  'packages/tests/shared-server/fixtures/mutation-boundary-transitive/root.ts';
const BARREL_FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-barrel';

describe('Task 10 route-closure correction 2 contracts', { timeout: 30_000 }, () => {
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

  it('resolves mutable repository capabilities through the shared-server barrel', () => {
    const forbidden = ['direct.ts', 'alias.ts', 'namespace.ts'].map((name) =>
      `${BARREL_FIXTURES}/${name}`
    );
    for (const root of forbidden) {
      expect(boundaryAnalysis.findMutationBoundaryViolationsFromRoots([root]), root)
        .toEqual([
          expect.objectContaining({
            filePath: root,
            directMutatorCalls: ['ClientStateRepository.insertPrincipal'],
          }),
        ]);
    }
    expect(boundaryAnalysis.findMutationBoundaryViolationsFromRoots([
      `${BARREL_FIXTURES}/read-only.ts`,
    ])).toEqual([]);
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

  it('uses the canonical inventory in the original routing contract test', () => {
    const source = readFileSync(
      'packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts',
      'utf8',
    );
    expect(source).toContain("from './mutation-routing-inventory.ts'");
    expect(source).not.toContain('const MUTATION_ROUTE_INVENTORY');
  });

  it('rejects a dead correct marker when the registered handler is rerouted', () => {
    const first = MUTATION_ROUTE_INVENTORY[0]!;
    const source = readFileSync(first.sourcePath, 'utf8');
    const liveCall =
      'const snapshot = await processClientAppInbox<ClientPrincipalUpsertAppInboxPayload>';
    expect(source).toContain(liveCall);
    const rerouted = source.replace(
      liveCall,
      'const snapshot = await Promise.resolve<ClientSnapshot>',
    ) + `
function deadCorrectMutationMarker(): void {
  void AppInboxType.${first.type};
  void deps.processClientAppInbox;
}
`;
    const validateWithSources = validateMutationRouteInventory as unknown as (
      inventory: typeof MUTATION_ROUTE_INVENTORY,
      options: Readonly<{ sourceOverrides: ReadonlyMap<string, string> }>,
    ) => readonly string[];

    expect(validateWithSources(MUTATION_ROUTE_INVENTORY, {
      sourceOverrides: new Map([[first.sourcePath, rerouted]]),
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('registered handler is not connected'),
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
