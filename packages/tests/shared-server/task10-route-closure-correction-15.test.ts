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
const LOOP_START = '    for (const type of GROUP_MUTATION_INBOX_TYPES.filter(';
const LOOP_END = '    this.onStateMessage<GroupPresenceSessionCleanupAppInboxPayload>(';
const CLASS_START = 'export class AppGroupInboxService extends AppInboxService {';
const TYPE_MAP = `const C15_TYPE_MAP = new Map([
    [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
]);`;

describe('Task 10 route-closure correction 15 contracts', { timeout: 30_000 }, () => {
  it('makes nested guaranteed boundary abrupt completion equivalent to direct completion', () => {
    const direct = findBoundaryViolations('c15-boundary-direct-abrupt.ts');
    const nested = findBoundaryViolations('c15-boundary-nested-abrupt.ts');
    expect(direct).toEqual([]);
    expect(nested).toEqual(direct);
  });

  it('retains writers reachable after an unknown break, return, or throw branch', () => {
    expectBoundaryMutation('c15-boundary-possible-abrupt.ts', [
      'ClientStateRepository.deletePrincipal',
      'ClientStateRepository.insertPrincipal',
      'ClientStateRepository.updatePrincipal',
    ]);
  });

  it.each(['return', "throw new Error('stop')"])(
    'does not own a registration after direct %s',
    (abrupt) => {
      expectNeitherProjection(validateInvocations(`switch ('create') {
            case 'create':
                ${abrupt};
            case 'later':
                registerC15(undefined, 'keys');
        }`));
    },
  );

  it.each([
    ['break', 'break'],
    ['return', 'return'],
    ['throw', "throw new Error('stop')"],
  ])('skips later routing ownership after nested guaranteed %s', (_, abrupt) => {
    const direct = validateInvocations(`switch ('create') {
            case 'create':
                ${abrupt};
            case 'later':
                registerC15(undefined, 'keys');
        }`);
    const nested = validateInvocations(`switch ('create') {
            case 'create': {
                if (true) {
                    ${abrupt};
                }
            }
            case 'later':
                registerC15(undefined, 'keys');
        }`);
    expect(expectProjectionState(nested)).toEqual(expectProjectionState(direct));
    expectNeitherProjection(nested);
  });

  it('intersects a later registration out of an unknown break path', () => {
    const issues = validateInvocations(
      `switch ('create') {
            case 'create':
                if (c15Flag) {
                    break;
                }
            case 'later':
                registerC15(undefined, 'keys');
                break;
        }
        registerC15(undefined, 'values');`,
      'declare const c15Flag: boolean;',
    );
    expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it.each(['return', "throw new Error('stop')"])(
    'intersects a later registration out of an unknown %s path',
    (abrupt) => {
      const issues = validateInvocations(
        `registerC15(undefined, 'keys');
        if (c15Flag) {
            ${abrupt};
        }
        registerC15(undefined, 'values');`,
        'declare const c15Flag: boolean;',
      );
      expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    },
  );

  it('runs finally on every path while retaining an earlier return completion', () => {
    const issues = validateInvocations(
      `try {
            if (c15Flag) {
                return;
            }
        } finally {
            registerC15(undefined, 'keys');
        }
        registerC15(undefined, 'values');`,
      'declare const c15Flag: boolean;',
    );
    expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
  });

  it('consumes a matching break but retains return and throw beyond a switch', () => {
    const breakIssues = validateInvocations(`switch ('create') {
            case 'create':
                break;
        }
        registerC15(undefined, 'keys');`);
    expectProjection(breakIssues, 'GROUP_CREATE', 'GROUP_UPDATE');

    for (const abrupt of ['return', "throw new Error('stop')"]) {
      const issues = validateInvocations(`switch ('create') {
            case 'create':
                ${abrupt};
        }
        registerC15(undefined, 'keys');`);
      expectNeitherProjection(issues);
    }
  });

  it('consumes continue at an exact loop boundary', () => {
    const issues = validateInvocations(`for (const c15Continue of [true]) {
            if (c15Continue) {
                continue;
            }
            registerC15(undefined, 'keys');
        }
        registerC15(undefined, 'values');`);
    expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it('consumes matching labeled break and continue completions', () => {
    const breakIssues = validateInvocations(`c15Block: {
            switch ('create') {
                case 'create':
                    if (true) {
                        break c15Block;
                    }
                case 'later':
                    registerC15(undefined, 'keys');
            }
        }
        registerC15(undefined, 'values');`);
    expectProjection(breakIssues, 'GROUP_UPDATE', 'GROUP_CREATE');

    const continueIssues = validateInvocations(`c15Loop: for (const c15Continue of [true]) {
            if (c15Continue) {
                continue c15Loop;
            }
            registerC15(undefined, 'keys');
        }
        registerC15(undefined, 'values');`);
    expectProjection(continueIssues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });
});

function findBoundaryViolations(name: string) {
  return findMutationBoundaryViolationsFromRoots([`${FIXTURES}/${name}`]);
}

function expectBoundaryMutation(name: string, methods: readonly string[]): void {
  const root = `${FIXTURES}/${name}`;
  expect(findBoundaryViolations(name), root).toEqual([
    expect.objectContaining({ filePath: root, directMutatorCalls: methods }),
  ]);
}

function validateInvocations(invocation: string, topLevel = ''): readonly string[] {
  const source = readFileSync(GROUP_OWNER, 'utf8');
  let mutated = source.replace(CLASS_START, `${TYPE_MAP}\n${topLevel}\n\n${CLASS_START}`);
  mutated = mutated.replace(
    LOOP_START,
    `        function registerC15(
            _ignored: unknown = undefined,
            MAP_METHOD = 'keys',
        ): void {\n${LOOP_START}`,
  );
  mutated = mutated.replace(LOOP_END, `        }\n        ${invocation}\n${LOOP_END}`);
  mutated = mutated.replace(LIVE_GROUP_COLLECTION, 'C15_TYPE_MAP[MAP_METHOD]()');
  expect(mutated).not.toBe(source);
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[GROUP_OWNER, mutated]]),
  });
}

function expectProjectionState(issues: readonly string[]): readonly boolean[] {
  return [hasMissingIssue(issues, 'GROUP_CREATE'), hasMissingIssue(issues, 'GROUP_UPDATE')];
}

function expectNeitherProjection(issues: readonly string[]): void {
  expectMissing(issues, 'GROUP_CREATE');
  expectMissing(issues, 'GROUP_UPDATE');
}

function expectProjection(
  issues: readonly string[],
  connected: string,
  missing: string,
): void {
  expect(hasMissingIssue(issues, connected)).toBe(false);
  expectMissing(issues, missing);
}

function hasMissingIssue(issues: readonly string[], type: string): boolean {
  return issues.some((issue) => issue.includes(`${type} owner dispatch is not connected`));
}

function expectMissing(issues: readonly string[], type: string): void {
  expect(hasMissingIssue(issues, type)).toBe(true);
}
