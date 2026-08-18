import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import {
  MUTATION_ROUTE_INVENTORY,
  validateMutationRouteInventory,
} from './mutation-routing-inventory.ts';

const FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-capability-receivers';
const GROUP_OWNER = 'packages/shared-server/rallar-system/services/AppGroupInboxService.ts';
const AUTH_OWNER = 'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
const CRDT_OWNER = 'packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts';

describe('Mutation route owner registration predicates contracts', () => {
  it.each([
    'lexical-functions.ts',
    'lexical-block-catch.ts',
    'lexical-classes.ts',
    'member-references.ts',
  ])('binds mutable capabilities to lexical identities in %s', (name) => {
    const root = `${FIXTURES}/${name}`;
    expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
      expect.objectContaining({
        filePath: root,
        directMutatorCalls: ['ClientStateRepository.insertPrincipal'],
      }),
    ]);
  });

  it('keeps shadowed domain values and read-only member references clean', () => {
    expect(findMutationBoundaryViolationsFromRoots([`${FIXTURES}/lexical-controls.ts`])).toEqual(
      [],
    );
  });

  it('narrows the group registration array with an exact equality filter', () => {
    const source = readFileSync(GROUP_OWNER, 'utf8');
    const mutated = source.replace(
      'candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP',
      'candidate === AppInboxType.GROUP_CREATE',
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(GROUP_OWNER, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_UPDATE owner dispatch is not connected'),
      ]),
    );
  });

  it('rejects a group registration filter that is always false', () => {
    const source = readFileSync(GROUP_OWNER, 'utf8');
    const mutated = source.replace(
      '(candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP',
      '() => false',
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(GROUP_OWNER, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_CREATE owner dispatch is not connected'),
      ]),
    );
  });

  it('narrows the auth registration array with an exact equality filter', () => {
    const source = readFileSync(AUTH_OWNER, 'utf8');
    const mutated = source.replace(
      'for (const type of AUTH_TYPES)',
      'for (const type of AUTH_TYPES.filter((candidate) => candidate === AppInboxType.AUTH_USER_REGISTER))',
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(AUTH_OWNER, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AUTH_SESSION_ISSUE owner dispatch is not connected'),
      ]),
    );
  });

  it('narrows the imported CRDT collection with an exact equality filter', () => {
    const source = readFileSync(CRDT_OWNER, 'utf8');
    const mutated = source.replace(
      'for (const type of CRDT_MUTATION_INBOX_TYPES)',
      'for (const type of CRDT_MUTATION_INBOX_TYPES.filter((candidate) => candidate === AppInboxType.CRDT_UPDATE_APPEND))',
    );
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(CRDT_OWNER, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CRDT_ERASE owner dispatch is not connected'),
      ]),
    );
  });

  it('fails closed for an opaque registration predicate', () => {
    const source = readFileSync(GROUP_OWNER, 'utf8');
    const mutated =
      source.replace(
        '(candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP',
        '(candidate) => isGroupInboxTypeEnabled(candidate)',
      ) + '\nfunction isGroupInboxTypeEnabled(_type: AppInboxType): boolean { return true; }\n';
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(GROUP_OWNER, mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GROUP_CREATE owner dispatch is not connected'),
      ]),
    );
  });

  it('evaluates safe logical includes and identity map chains exactly', () => {
    const source = readFileSync(AUTH_OWNER, 'utf8');
    const mutated = source.replace(
      'for (const type of AUTH_TYPES)',
      `for (const type of AUTH_TYPES
            .filter((candidate) => candidate !== AppInboxType.AUTH_USER_REGISTER && ![AppInboxType.AUTH_SESSION_LOGOUT].includes(candidate))
            .map((candidate) => candidate))`,
    );
    expect(mutated).not.toBe(source);

    const issues = validateWithOverride(AUTH_OWNER, mutated);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AUTH_USER_REGISTER owner dispatch is not connected'),
        expect.stringContaining('AUTH_SESSION_LOGOUT owner dispatch is not connected'),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('AUTH_SESSION_ISSUE owner dispatch is not connected'),
      ]),
    );
  });
});

function validateWithOverride(filePath: string, source: string): readonly string[] {
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[filePath, source]]),
  });
}
