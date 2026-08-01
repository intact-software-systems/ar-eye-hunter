import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
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
const TYPE_MAP = `const C17_TYPE_MAP = new Map([
    [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
]);`;

describe('Mutation route owner loop divergence contracts', { timeout: 30_000 }, () => {
  it('keeps writers after statically non-terminating loops unreachable', () => {
    expect(findBoundaryViolations('c17-loop-divergence-controls.ts')).toEqual([]);
  });

  it('retains required update and test phases before divergence', () => {
    expectBoundaryMutation('c17-loop-divergence-phases.ts', [
      'ClientStateRepository.insertPrincipal',
      'ClientStateRepository.updatePrincipal',
    ]);
  });

  it('retains post-loop writers on conditional, owned, and exact-false exits', () => {
    expectBoundaryMutation('c17-loop-conditional-break.ts', [
      'ClientStateRepository.deletePrincipal',
    ]);
    expectBoundaryMutation('c17-loop-owned-break.ts', ['ClientStateRepository.insertPrincipal']);
    expectBoundaryMutation('c17-loop-false-exit.ts', ['ClientStateRepository.deletePrincipal']);
  });

  it.each([
    'for (;;) { continue; }',
    'for (;;) {}',
    'do { continue; } while (true);',
    'while (true) {}',
  ])('records divergence and does not execute a following statement: %s', (loop) => {
    const execution = executeSource(`${loop}\nmarker();`);
    expect(execution.completions).toEqual(['diverge']);
    expect(execution.calls).not.toContain('marker');
  });

  it('executes the classic-for update and do-while test before divergence', () => {
    const forExecution = executeSource(`for (;; update()) { continue; }\nmarker();`);
    expect(forExecution.completions).toEqual(['diverge']);
    expect(forExecution.calls).toEqual(['update']);

    const doExecution = executeSource(`do { continue; } while ((testMarker(), true));\nmarker();`);
    expect(doExecution.completions).toEqual(['diverge']);
    expect(doExecution.calls).toEqual(['testMarker']);
  });

  it('keeps exact-false and unknown tests on their supported normal exit paths', () => {
    expect(executeSource('while (false) {}\nmarker();')).toEqual({
      calls: ['marker'],
      completions: ['normal'],
    });
    expect(executeSource('while (unknown) { break; }\nmarker();')).toEqual({
      calls: ['marker'],
      completions: ['normal'],
    });
  });

  it('keeps direct and matching labeled breaks as normal post-loop exits', () => {
    for (const loop of ['for (;;) { break; }', 'outer: while (true) { break outer; }']) {
      expect(executeSource(`${loop}\nmarker();`)).toEqual({
        calls: ['marker'],
        completions: ['normal'],
      });
    }
  });

  it('keeps conditional break as a normal exit plus a divergent alternative', () => {
    const execution = executeSource(`while (true) {
      if (stop) break;
    }
    marker();`);
    expect(execution.completions).toEqual(['diverge', 'normal']);
    expect(execution.calls).toEqual(['marker']);
  });

  it('preserves return, throw, and non-owned labeled escape completions', () => {
    expect(executeSource('while (true) { return; }\nmarker();').completions).toEqual(['return']);
    expect(
      executeSource(`while (true) { throw new Error('stop'); }\nmarker();`).completions,
    ).toEqual(['throw']);
    expect(
      executeSource(`outer: {
        while (true) { break outer; }
      }
      marker();`),
    ).toEqual({ calls: ['marker'], completions: ['normal'] });
  });

  it('propagates inner divergence and preserves inner versus outer break ownership', () => {
    expect(
      executeSource(`while (true) {
        while (true) {}
        innerPost();
      }
      marker();`),
    ).toEqual({ calls: [], completions: ['diverge'] });
    expect(
      executeSource(`while (true) {
        while (true) { break; }
        innerPost();
        break;
      }
      marker();`),
    ).toEqual({ calls: ['innerPost', 'marker'], completions: ['normal'] });
    expect(
      executeSource(`outer: while (true) {
        while (true) { break outer; }
        innerPost();
      }
      marker();`),
    ).toEqual({ calls: ['marker'], completions: ['normal'] });
  });

  it('preserves divergence through switches, labels, branch joins, and finally', () => {
    expect(
      executeSource(`label: {
        while (true) {
          switch (choice) {
            case 1: continue;
            default: continue;
          }
        }
      }
      marker();`),
    ).toEqual({ calls: [], completions: ['diverge'] });
    expect(
      executeSource(`if (choice) { while (true) {} } else { while (true) {} }
        marker();`),
    ).toEqual({ calls: [], completions: ['diverge'] });
    expect(executeSource(`try { while (true) {} } finally { finalizer(); }`)).toEqual({
      calls: [],
      completions: ['diverge'],
    });
    expect(executeSource(`try { return; } finally { while (true) {} }`)).toEqual({
      calls: [],
      completions: ['diverge'],
    });
  });

  it('keeps nested conditional exploration bounded before divergence', () => {
    const conditions = Array.from(
      { length: 12 },
      (_, index) => `if (flag${index}) left(); else right();`,
    ).join('\n');
    const execution = executeSource(`while (true) { ${conditions} }`);
    expect(execution.completions).toEqual(['diverge']);
    expect(execution.calls).toHaveLength(24);
  });

  it('does not treat a dead post-loop registration as owned', () => {
    for (const loop of [
      'for (;;) { continue; }',
      'for (;;) {}',
      'do { continue; } while (true);',
      'while (true) {}',
    ]) {
      expectNeitherProjection(
        validateInvocations(`${loop}
        registerC17(undefined, 'values');`),
      );
    }
  });

  it('includes a divergent path when intersecting conditional-break ownership', () => {
    const issues = validateInvocations(
      `for (;;) {
        if (c17Stop) break;
      }
      registerC17(undefined, 'values');`,
      'declare const c17Stop: boolean;',
    );
    expectNeitherProjection(issues);
  });

  it('keeps phase registration and owned-break post registration distinct', () => {
    const phaseIssues = validateInvocations(`for (;; registerC17(undefined, 'keys')) {
        continue;
      }
      registerC17(undefined, 'values');`);
    expectProjection(phaseIssues, 'GROUP_CREATE', 'GROUP_UPDATE');

    for (const loop of ['for (;;) { break; }', 'outer: for (;;) { break outer; }']) {
      const issues = validateInvocations(`${loop}
        registerC17(undefined, 'values');`);
      expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    }
  });

  it('distinguishes nested divergence, inner break, and outer break in routing', () => {
    expectNeitherProjection(
      validateInvocations(`while (true) {
        while (true) {}
        registerC17(undefined, 'keys');
      }
      registerC17(undefined, 'values');`),
    );

    expectBothProjections(
      validateInvocations(`while (true) {
        while (true) { break; }
        registerC17(undefined, 'keys');
        break;
      }
      registerC17(undefined, 'values');`),
    );

    const outerIssues = validateInvocations(`outer: while (true) {
        while (true) { break outer; }
        registerC17(undefined, 'keys');
      }
      registerC17(undefined, 'values');`);
    expectProjection(outerIssues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });
});

function executeSource(body: string): Readonly<{
  calls: readonly string[];
  completions: readonly string[];
}> {
  const root = parse(`function inspect() { ${body} }`, { sourceType: 'module' }).program
    .body[0] as AstNode;
  const calls: string[] = [];
  const paths = executeMutationPaths(root, [undefined], {
    lexical: () => undefined,
    nestedFunctions: 'skip',
    statesEqual: () => true,
    visit: (node, state) => {
      if (node.type === 'CallExpression') {
        const callee = node.callee as AstNode | undefined;
        if (callee?.type === 'Identifier' && typeof callee.name === 'string') {
          calls.push(callee.name);
        }
      }
      return state;
    },
  });
  return {
    calls,
    completions: paths.map((path) => path.completion.kind).toSorted(),
  };
}

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
    `        function registerC17(
            _ignored: unknown = undefined,
            MAP_METHOD = 'keys',
        ): void {\n${LOOP_START}`,
  );
  mutated = mutated.replace(LOOP_END, `        }\n        ${invocation}\n${LOOP_END}`);
  mutated = mutated.replace(LIVE_GROUP_COLLECTION, 'C17_TYPE_MAP[MAP_METHOD]()');
  expect(mutated).not.toBe(source);
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[GROUP_OWNER, mutated]]),
  });
}

function expectBothProjections(issues: readonly string[]): void {
  expect(hasMissingIssue(issues, 'GROUP_CREATE')).toBe(false);
  expect(hasMissingIssue(issues, 'GROUP_UPDATE')).toBe(false);
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
