import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import { executeMutationPaths } from './mutation-execution-outcomes.ts';
import type { MutationExecutionAstNode as AstNode } from './mutation-execution-path-state.ts';
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
const CLASS_START = 'class AppGroupInboxService extends AppInboxService {';
const TYPE_MAP = `const C16_TYPE_MAP = new Map([
    [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
]);`;

describe('Mutation route owner loop completion contracts', { timeout: 30_000 }, () => {
  it('skips boundary for-update and do-test writers after break, return, or throw', () => {
    expect(findBoundaryViolations('c16-loop-phase-controls.ts')).toEqual([]);
  });

  it('retains boundary update, test, and post-loop writers that are reachable', () => {
    expectBoundaryMutation('c16-loop-phase-mutations.ts', [
      'ClientStateRepository.deletePrincipal',
      'ClientStateRepository.insertPrincipal',
      'ClientStateRepository.updatePrincipal',
    ]);
  });

  it('skips a classic-for update after break and reaches post-loop registration', () => {
    const issues = validateInvocations(`for (; true; registerC16(undefined, 'keys')) {
            break;
        }
        registerC16(undefined, 'values');`);
    expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it('skips a classic-for update after a matching labeled outer break', () => {
    const issues = validateInvocations(`outer: for (; true; registerC16(undefined, 'keys')) {
            {
                break outer;
            }
        }
        registerC16(undefined, 'values');`);
    expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it('lets a break escape to a label outside the loop without running the update', () => {
    const issues = validateInvocations(`outer: {
            for (; true; registerC16(undefined, 'keys')) {
                break outer;
            }
        }
        registerC16(undefined, 'values');`);
    expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it('skips a do-while test after break and reaches post-loop registration', () => {
    const issues = validateInvocations(`do {
            break;
        } while (registerC16(undefined, 'keys'));
        registerC16(undefined, 'values');`);
    expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it.each([
    [
      `for (; true; registerC16(undefined, 'keys')) { break; }`,
      `for (; true; registerC16(undefined, 'keys')) {
            { if (true) { break; } }
        }`,
    ],
    [
      `do { break; } while (registerC16(undefined, 'keys'));`,
      `do { { if (true) { break; } } }
        while (registerC16(undefined, 'keys'));`,
    ],
  ])('makes nested guaranteed break equivalent to direct break', (direct, nested) => {
    const directIssues = validateInvocations(`${direct}
        registerC16(undefined, 'values');`);
    const nestedIssues = validateInvocations(`${nested}
        registerC16(undefined, 'values');`);
    expect(projectionState(nestedIssues)).toEqual(projectionState(directIssues));
    expectProjection(nestedIssues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it('intersects the update out of a conditional break path', () => {
    const issues = validateInvocations(
      `for (; true; registerC16(undefined, 'keys')) {
            if (c16Stop) {
                break;
            } else {
                continue;
            }
        }
        registerC16(undefined, 'values');`,
      'declare const c16Stop: boolean;',
    );
    expectNeitherProjection(issues);
  });

  it('runs continue phases and preserves the unknown do-test exit', () => {
    const forIssues = validateInvocations(`for (; true; registerC16(undefined, 'keys')) {
            continue;
        }
        registerC16(undefined, 'values');`);
    expectProjection(forIssues, 'GROUP_CREATE', 'GROUP_UPDATE');

    const doIssues = validateInvocations(`do {
            continue;
        } while (registerC16(undefined, 'keys'));
        registerC16(undefined, 'values');`);
    expectProjection(doIssues, 'GROUP_CREATE', 'GROUP_UPDATE');
  });

  it('retains return and throw beyond update, test, and post-loop statements', () => {
    for (const invocation of [
      `for (; true; registerC16(undefined, 'keys')) { return; }
        registerC16(undefined, 'values');`,
      `do { throw new Error('stop'); }
        while (registerC16(undefined, 'keys'));
        registerC16(undefined, 'values');`,
    ]) {
      expectNeitherProjection(validateInvocations(invocation));
    }
  });

  it('preserves while, for-of, and for-in post-loop reachability', () => {
    for (const loop of [
      `while (true) { break; }`,
      `for (const item of [1, 2]) { void item; break; }`,
      `for (const key in {}) { void key; break; }`,
    ]) {
      const issues = validateInvocations(`${loop}
        registerC16(undefined, 'keys');`);
      expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    }
  });

  it('runs abrupt update and test phases only after normal or continue outcomes', () => {
    expect(executeCompletion(classicFor('BreakStatement', 'ReturnStatement'))).toBe('normal');
    expect(executeCompletion(classicFor('ContinueStatement', 'ReturnStatement'))).toBe('return');
    expect(executeCompletion(doWhile('BreakStatement', 'ThrowStatement'))).toBe('normal');
    expect(executeCompletion(doWhile('ContinueStatement', 'ThrowStatement'))).toBe('throw');
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
    `        function registerC16(
            _ignored: unknown = undefined,
            MAP_METHOD = 'keys',
        ): void {\n${LOOP_START}`,
  );
  mutated = mutated.replace(LOOP_END, `        }\n        ${invocation}\n${LOOP_END}`);
  mutated = mutated.replace(LIVE_GROUP_COLLECTION, 'C16_TYPE_MAP[MAP_METHOD]()');
  expect(mutated).not.toBe(source);
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[GROUP_OWNER, mutated]]),
  });
}

function executeCompletion(root: AstNode): string {
  const paths = executeMutationPaths(root, [undefined], {
    lexical: () => undefined,
    nestedFunctions: 'skip',
    statesEqual: () => true,
    visit: (_node, state) => state,
  });
  expect(paths).toHaveLength(1);
  return paths[0]!.completion.kind;
}

function classicFor(body: string, update: string): AstNode {
  return {
    type: 'ForStatement',
    init: undefined,
    test: { type: 'BooleanLiteral', value: true },
    update: { type: update },
    body: { type: body },
  };
}

function doWhile(body: string, test: string): AstNode {
  return {
    type: 'DoWhileStatement',
    body: { type: body },
    test: { type: test },
  };
}

function projectionState(issues: readonly string[]): readonly boolean[] {
  return [hasMissingIssue(issues, 'GROUP_CREATE'), hasMissingIssue(issues, 'GROUP_UPDATE')];
}

function expectNeitherProjection(issues: readonly string[]): void {
  expectMissing(issues, 'GROUP_CREATE');
  expectMissing(issues, 'GROUP_UPDATE');
}

function expectProjection(issues: readonly string[], connected: string, missing: string): void {
  expect(hasMissingIssue(issues, connected)).toBe(false);
  expectMissing(issues, missing);
}

function hasMissingIssue(issues: readonly string[], type: string): boolean {
  return issues.some((issue) => issue.includes(`${type} owner dispatch is not connected`));
}

function expectMissing(issues: readonly string[], type: string): void {
  expect(hasMissingIssue(issues, type)).toBe(true);
}
