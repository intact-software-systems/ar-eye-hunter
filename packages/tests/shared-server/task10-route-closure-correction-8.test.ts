import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import {
  MUTATION_ROUTE_INVENTORY,
  validateMutationRouteInventory,
} from './mutation-routing-inventory.ts';

const FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-capability-receivers';
const GROUP_OWNER = 'packages/shared-server/rallar-system/services/AppGroupInboxService.ts';
const LIVE_GROUP_COLLECTION = `GROUP_MUTATION_INBOX_TYPES.filter(
            (candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
        )`;
const UNKNOWN_TYPES = 'function unknownTypes(): readonly AppInboxType[] { return []; }';

describe('Task 10 route-closure correction 8 contracts', () => {
  it.each([
    'flow-closure-hoisted.ts',
    'flow-closure-late-initializer.ts',
    'flow-closure-conditional.ts',
    'flow-closure-callback.ts',
    'flow-closure-recursive.ts',
  ])('applies reachable closure assignments at execution in %s', (name) => {
    const root = `${FIXTURES}/${name}`;
    expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
      expect.objectContaining({
        filePath: root,
        directMutatorCalls: ['ClientStateRepository.insertPrincipal'],
      }),
    ]);
  });

  it('ignores never-executed writes and accepts an invoked read-only overwrite', () => {
    expect(findMutationBoundaryViolationsFromRoots([
      `${FIXTURES}/flow-closure-controls.ts`,
    ])).toEqual([]);
  });

  it('filters every guaranteed member out of an unknown collection', () => {
    const issues = validateWithGroupCollection(
      '[...GROUP_MUTATION_INBOX_TYPES, ...unknownTypes()].filter(() => false)',
    );
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('GROUP_CREATE owner dispatch is not connected'),
      expect.stringContaining('GROUP_UPDATE owner dispatch is not connected'),
    ]));
  });

  it('maps guaranteed members of an unknown collection to an exact constant', () => {
    const issues = validateWithGroupCollection(
      '[...GROUP_MUTATION_INBOX_TYPES, ...unknownTypes()].map(() => AppInboxType.GROUP_UPDATE)',
    );
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('GROUP_CREATE owner dispatch is not connected'),
    ]));
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.stringContaining('GROUP_UPDATE owner dispatch is not connected'),
    ]));
  });

  it('propagates unknown lower bounds through chained logical filter and map', () => {
    const issues = validateWithGroupCollection(
      `[...GROUP_MUTATION_INBOX_TYPES, ...unknownTypes()]
        .filter((candidate) => candidate !== AppInboxType.GROUP_CREATE && ![AppInboxType.GROUP_UPDATE].includes(candidate))
        .map((candidate) => candidate)`,
    );
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('GROUP_CREATE owner dispatch is not connected'),
      expect.stringContaining('GROUP_UPDATE owner dispatch is not connected'),
    ]));
  });
});

function validateWithGroupCollection(collection: string): readonly string[] {
  const source = readFileSync(GROUP_OWNER, 'utf8');
  const mutated = source.replace(LIVE_GROUP_COLLECTION, collection) + `\n${UNKNOWN_TYPES}\n`;
  expect(mutated).not.toBe(source);
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[GROUP_OWNER, mutated]]),
  });
}
