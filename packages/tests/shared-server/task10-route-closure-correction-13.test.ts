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
const TYPE_MAP = `const C13_TYPE_MAP = new Map([
    [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
]);`;

describe('Task 10 route-closure correction 13 contracts', { timeout: 30_000 }, () => {
  it('collapses equivalent computed capability and factory member alternatives', () => {
    expectMutation('c13-computed-members.ts', [
      'ClientStateRepository.<unknown>',
      'ClientStateRepository.insertPrincipal',
      'ClientStateRepository.updatePrincipal',
    ]);
  });

  it('shares recursive heap members through every exact alias form', () => {
    expectMutation('c13-nested-heap-aliases.ts', [
      'ClientStateRepository.deletePrincipal',
      'ClientStateRepository.insertPrincipal',
      'ClientStateRepository.updatePrincipal',
    ]);
  });

  it('keeps never-invoked and overwritten nested heap writers clean', () => {
    expectClean('c13-nested-heap-controls.ts');
  });

  it('preserves absent, undefined, exact, spread, and bound argument slots', () => {
    expectMutation('c13-argument-slots.ts', [
      'ClientStateRepository.deletePrincipal',
      'ClientStateRepository.insertPrincipal',
      'ClientStateRepository.updatePrincipal',
    ]);
  });

  it('does not execute a callable merely because its argument slots were bound', () => {
    expectClean('c13-control-bound-slots-never-invoked.ts');
  });

  it('skips statically unreachable nested boundary selections', () => {
    expectClean('c13-unreachable-boundary.ts');
  });

  it('keeps reachable and unknown boundary selections conservative', () => {
    expectMutation('c13-reachable-boundary.ts', [
      'ClientStateRepository.insertPrincipal',
    ]);
  });

  it.each([
    `if (false) registerC13(undefined, 'keys');`,
    `false && registerC13(undefined, 'keys');`,
    `true || registerC13(undefined, 'keys');`,
    `for (; false;) registerC13(undefined, 'keys');`,
    `registerC13.bind(undefined, undefined, 'keys');`,
  ])('does not establish ownership from unreachable registration: %s', (invocation) => {
    expectNoProjection(validateInvocations(invocation));
  });

  it.each([
    `if (true) registerC13(undefined, 'keys');`,
    `true && registerC13(undefined, 'keys');`,
    `false || registerC13(undefined, 'keys');`,
  ])('establishes ownership from a reachable registration: %s', (invocation) => {
    expectProjection(validateInvocations(invocation), 'GROUP_CREATE', 'GROUP_UPDATE');
  });

  it('uses only the reachable arm of an exact conditional registration', () => {
    const issues = validateInvocations(
      `true
            ? registerC13(undefined, 'keys')
            : registerC13(undefined, 'values');`,
    );
    expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
  });

  it('uses only the matching case of an exact switch registration', () => {
    const issues = validateInvocations(`switch ('values') {
            case 'keys':
                registerC13(undefined, 'keys');
                break;
            case 'values':
                registerC13(undefined, 'values');
                break;
        }`);
    expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it('resolves literal-exact for-of registration values', () => {
    const issues = validateInvocations(`for (const method of ['values'] as const) {
            registerC13(undefined, method);
        }`);
    expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it('intersects different registrations across unknown alternatives', () => {
    const issues = validateInvocations(
      `if (c13Enabled) registerC13(undefined, 'keys');
        else registerC13(undefined, 'values');`,
      `declare const c13Enabled: boolean;`,
    );
    expectNoProjection(issues);
  });

  it('retains a common registration across unknown alternatives', () => {
    const issues = validateInvocations(
      `if (c13Enabled) registerC13(undefined, 'keys');
        else registerC13(undefined, 'keys');`,
      `declare const c13Enabled: boolean;`,
    );
    expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
  });

  it('does not infer ownership from an unknown external callback flow', () => {
    const issues = validateInvocations(
      `consumeC13(registerC13);`,
      `declare function consumeC13(callback: unknown): void;`,
    );
    expectNoProjection(issues);
  });

  it.each([
    `registerC13.call(undefined, undefined, 'values');`,
    `registerC13.apply(undefined, [, 'values']);`,
    `registerC13.bind(undefined, undefined, 'values')();`,
    `const bound = registerC13.bind(undefined, undefined);
        bound.apply(undefined, ['values']);`,
  ])('normalizes reachable registration call-family arguments: %s', (invocation) => {
    expectProjection(validateInvocations(invocation), 'GROUP_UPDATE', 'GROUP_CREATE');
  });

  it.each([
    `registerC13();`,
    `registerC13(undefined, undefined);`,
    `registerC13.apply(undefined, [,]);`,
    `registerC13.bind(undefined, undefined, undefined)();`,
  ])('applies registration defaults to absent, hole, and undefined slots: %s', (invocation) => {
    expectProjection(validateInvocations(invocation), 'GROUP_CREATE', 'GROUP_UPDATE');
  });

  it('keeps equivalent direct, alias, and call-family registrations metamorphic', () => {
    const direct = validateInvocations(`registerC13(undefined, 'values');`);
    const alias = validateInvocations(
      `const alias = registerC13;
        alias(undefined, 'values');`,
    );
    const call = validateInvocations(
      `registerC13.call(undefined, undefined, 'values');`,
    );
    expect(connectionProjection(alias)).toEqual(connectionProjection(direct));
    expect(connectionProjection(call)).toEqual(connectionProjection(direct));
  });
});

function expectMutation(name: string, methods: readonly string[]): void {
  const root = `${FIXTURES}/${name}`;
  expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
    expect.objectContaining({ filePath: root, directMutatorCalls: methods }),
  ]);
}

function expectClean(name: string): void {
  expect(findMutationBoundaryViolationsFromRoots([`${FIXTURES}/${name}`])).toEqual([]);
}

function validateInvocations(
  invocation: string,
  topLevel = '',
): readonly string[] {
  const source = readFileSync(GROUP_OWNER, 'utf8');
  let mutated = source.replace(
    CLASS_START,
    `${TYPE_MAP}\n${topLevel}\n\n${CLASS_START}`,
  );
  mutated = mutated.replace(
    LOOP_START,
    `        function registerC13(\n            _ignored: unknown = undefined,\n            MAP_METHOD = 'keys',\n        ): void {\n${LOOP_START}`,
  );
  mutated = mutated.replace(
    LOOP_END,
    `        }\n        ${invocation}\n${LOOP_END}`,
  );
  mutated = mutated.replace(LIVE_GROUP_COLLECTION, 'C13_TYPE_MAP[MAP_METHOD]()');
  expect(mutated).not.toBe(source);
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[GROUP_OWNER, mutated]]),
  });
}

function expectNoProjection(issues: readonly string[]): void {
  expectMissing(issues, 'GROUP_CREATE');
  expectMissing(issues, 'GROUP_UPDATE');
}

function expectProjection(
  issues: readonly string[],
  connected: string,
  missing: string,
): void {
  expectConnected(issues, connected);
  expectMissing(issues, missing);
}

function connectionProjection(issues: readonly string[]): readonly boolean[] {
  return [
    !hasMissingIssue(issues, 'GROUP_CREATE'),
    !hasMissingIssue(issues, 'GROUP_UPDATE'),
  ];
}

function hasMissingIssue(issues: readonly string[], type: string): boolean {
  return issues.some((issue) => issue.includes(`${type} owner dispatch is not connected`));
}

function expectMissing(issues: readonly string[], type: string): void {
  expect(hasMissingIssue(issues, type)).toBe(true);
}

function expectConnected(issues: readonly string[], type: string): void {
  expect(hasMissingIssue(issues, type)).toBe(false);
}
