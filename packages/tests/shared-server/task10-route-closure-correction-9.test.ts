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

describe('Task 10 route-closure correction 9 contracts', () => {
  it.each([
    'flow-closure-iife.ts',
    'flow-closure-helper-alias.ts',
    'flow-closure-object-method.ts',
    'flow-closure-object-unknown-member.ts',
    'flow-closure-deep-chain.ts',
    'flow-closure-mutual-cycle.ts',
  ])('follows every reachable local invocation form in %s', (name) => {
    const root = `${FIXTURES}/${name}`;
    expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
      expect.objectContaining({
        filePath: root,
        directMutatorCalls: ['ClientStateRepository.insertPrincipal'],
      }),
    ]);
  });

  it.each([
    'flow-closure-control-never-invoked.ts',
    'flow-closure-control-read-only-alias.ts',
    'flow-closure-control-recursive-no-write.ts',
  ])('keeps the closure control clean in %s', (name) => {
    expect(findMutationBoundaryViolationsFromRoots([`${FIXTURES}/${name}`])).toEqual([]);
  });

  it('projects Object.values without crediting object keys', () => {
    const issues = validateWithGroupCollection(
      'Object.values({ [AppInboxType.GROUP_CREATE]: AppInboxType.GROUP_UPDATE })',
    );
    expectMissing(issues, 'GROUP_CREATE');
    expectConnected(issues, 'GROUP_UPDATE');
  });

  it('projects computed Object.keys without crediting object values', () => {
    const issues = validateWithGroupCollection(
      'Object.keys({ [AppInboxType.GROUP_CREATE]: AppInboxType.GROUP_UPDATE })',
    );
    expectConnected(issues, 'GROUP_CREATE');
    expectMissing(issues, 'GROUP_UPDATE');
  });

  it('projects the key from exactly modeled Object.entries consumers', () => {
    const issues = validateWithGroupCollection(
      `Object.entries({ [AppInboxType.GROUP_CREATE]: AppInboxType.GROUP_UPDATE })
        .map(([type]) => type)`,
    );
    expectConnected(issues, 'GROUP_CREATE');
    expectMissing(issues, 'GROUP_UPDATE');
  });

  it('projects the value from exactly modeled Object.entries consumers', () => {
    const issues = validateWithGroupCollection(
      `Object.entries({ [AppInboxType.GROUP_CREATE]: AppInboxType.GROUP_UPDATE })
        .map(([, type]) => type)`,
    );
    expectMissing(issues, 'GROUP_CREATE');
    expectConnected(issues, 'GROUP_UPDATE');
  });

  it.each([
    'Object.keys(unknownObject())',
    `Object.entries({ [AppInboxType.GROUP_CREATE]: AppInboxType.GROUP_UPDATE })
      .map((entry) => entry)`,
  ])('does not establish ownership from unsupported collection shape %s', (collection) => {
    const issues = validateWithGroupCollection(
      collection,
      'function unknownObject(): Record<string, AppInboxType> { return {}; }',
    );
    expectMissing(issues, 'GROUP_CREATE');
    expectMissing(issues, 'GROUP_UPDATE');
  });
});

function validateWithGroupCollection(
  collection: string,
  appendedSource = '',
): readonly string[] {
  const source = readFileSync(GROUP_OWNER, 'utf8');
  const mutated = source.replace(LIVE_GROUP_COLLECTION, collection) + `\n${appendedSource}\n`;
  expect(mutated).not.toBe(source);
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[GROUP_OWNER, mutated]]),
  });
}

function expectMissing(issues: readonly string[], type: string): void {
  expect(issues).toEqual(expect.arrayContaining([
    expect.stringContaining(`${type} owner dispatch is not connected`),
  ]));
}

function expectConnected(issues: readonly string[], type: string): void {
  expect(issues).not.toEqual(expect.arrayContaining([
    expect.stringContaining(`${type} owner dispatch is not connected`),
  ]));
}
