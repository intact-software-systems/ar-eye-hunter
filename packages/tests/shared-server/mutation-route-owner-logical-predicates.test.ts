import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import {
  MUTATION_ROUTE_INVENTORY,
  validateMutationRouteInventory,
} from './mutation-routing-inventory.ts';

const FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-capability-receivers';
const GROUP_OWNER = 'packages/shared-server/rallar-system/services/AppGroupInboxService.ts';
const PRODUCTION_FILTER =
  '(candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,';

describe('Mutation route owner logical predicates contracts', () => {
  it.each([
    'flow-sequence.ts',
    'flow-object-member.ts',
    'flow-object-closure.ts',
    'flow-conditional.ts',
    'flow-callback-capture.ts',
  ])('evaluates mutable method provenance at each call in %s', (name) => {
    const root = `${FIXTURES}/${name}`;
    expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
      expect.objectContaining({
        filePath: root,
        directMutatorCalls: ['ClientStateRepository.insertPrincipal'],
      }),
    ]);
  });

  it('keeps a proven read-only overwrite clean when it precedes the only call', () => {
    expect(
      findMutationBoundaryViolationsFromRoots([`${FIXTURES}/flow-benign-overwrite.ts`]),
    ).toEqual([]);
  });

  it('fails closed when negated includes reads an unknown function collection', () => {
    const issues = validateWithGroupFilter(
      '(candidate) => !disabledTypes().includes(candidate),',
      'function disabledTypes(): readonly AppInboxType[] { return []; }',
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_CREATE owner dispatch is not connected'),
      ]),
    );
  });

  it('proves negated includes over a known empty collection', () => {
    expect(validateWithGroupFilter('(candidate) => ![].includes(candidate),')).toEqual([]);
  });

  it('narrows negated includes over a known nonempty collection exactly', () => {
    const issues = validateWithGroupFilter(
      '(candidate) => ![AppInboxType.GROUP_CREATE].includes(candidate),',
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_CREATE owner dispatch is not connected'),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_UPDATE owner dispatch is not connected'),
      ]),
    );
  });

  it('propagates unknown through logical predicates without losing proven true branches', () => {
    const issues = validateWithGroupFilter(
      '(candidate) => candidate === AppInboxType.GROUP_CREATE || !disabledTypes().includes(candidate),',
      'function disabledTypes(): readonly AppInboxType[] { return []; }',
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_UPDATE owner dispatch is not connected'),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_CREATE owner dispatch is not connected'),
      ]),
    );
  });

  it.each([
    'GROUP_MUTATION_INBOX_TYPES.filter(isEnabled)',
    'GROUP_MUTATION_INBOX_TYPES.map(normalizeType)',
  ])('keeps an unknown %s chain unknown under negated includes', (collection) => {
    const issues = validateWithGroupFilter(
      `(candidate) => !${collection}.includes(candidate),`,
      [
        'function isEnabled(_type: AppInboxType): boolean { return true; }',
        'function normalizeType(type: AppInboxType): AppInboxType { return type; }',
      ].join('\n'),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_CREATE owner dispatch is not connected'),
      ]),
    );
  });
});

function validateWithGroupFilter(filter: string, appendedSource = ''): readonly string[] {
  const source = readFileSync(GROUP_OWNER, 'utf8');
  const mutated = source.replace(PRODUCTION_FILTER, filter) + `\n${appendedSource}\n`;
  expect(mutated).not.toBe(source);
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[GROUP_OWNER, mutated]]),
  });
}
