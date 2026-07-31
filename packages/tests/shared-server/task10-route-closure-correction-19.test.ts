import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

import {
  createMutationBoundaryLexicalValues,
  mutationBoundaryLexicalValuesEqual,
} from './mutation-boundary-lexical-values.ts';
import {
  coalesceExecutionPaths,
  DIVERGE_COMPLETION,
  type MutationExecutionAdapter,
  type MutationExecutionAstNode as AstNode,
  type MutationExecutionPath,
  NORMAL_COMPLETION,
} from './mutation-execution-path-state.ts';
import {
  knownRegistrationTypes,
  type RegistrationTypeCollection,
  unknownRegistrationTypes,
} from './mutation-routing-registration-predicate.ts';
import {
  collectRoutingExecutionPaths,
  type RoutingExecutionPath,
} from './mutation-routing-execution-paths.ts';
import {
  MUTATION_ROUTE_INVENTORY,
  validateMutationRouteInventory,
} from './mutation-routing-inventory.ts';

const GROUP_OWNER = 'packages/shared-server/rallar-system/services/AppGroupInboxService.ts';
const LIVE_GROUP_COLLECTION = `GROUP_MUTATION_INBOX_TYPES.filter(
      (candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
    )`;
const LOOP_START = '    for (const type of GROUP_MUTATION_INBOX_TYPES.filter(';
const LOOP_END = '    this.onStateMessage<GroupPresenceSessionCleanupAppInboxPayload>(';
const CLASS_START = 'export class AppGroupInboxService extends AppInboxService {';
const TYPE_MAP = `const C19_TYPE_MAP = new Map([
    [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
]);`;
const IDENTICAL_BRANCH = 'if (c19Enabled) {} else {}';

const REGISTRATION_VALUES = new Map<string, RegistrationTypeCollection>([
  ['knownCreate', knownRegistrationTypes(['GROUP_CREATE'])],
  ['knownUpdate', knownRegistrationTypes(['GROUP_UPDATE'])],
  ['unknown', unknownRegistrationTypes()],
  ['unknownCreate', unknownRegistrationTypes(['GROUP_CREATE'])],
  ['unknownCreateUpdate', unknownRegistrationTypes(['GROUP_CREATE', 'GROUP_UPDATE'])],
]);

describe('Task 10 route-closure correction 19 contracts', () => {
  it('bounds 14 identical binary branches through the public route analyzer', () => {
    const startedAt = performance.now();
    const issues = validateInvocations(
      `${repeatBranches(14)}\n        registerC19(undefined, 'keys');`,
    );
    const elapsedMs = performance.now() - startedAt;

    expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    expect(elapsedMs).toBeLessThan(5_000);
  }, 30_000);

  it('coalesces 14 identical binary branches to one routing state', () => {
    expect(collectLexicalPaths(repeatBranches(14))).toHaveLength(1);
  });

  it('keeps 24 identical branches bounded without truncating analyzer paths', () => {
    const startedAt = performance.now();
    const issues = validateInvocations(
      `${repeatBranches(24)}\n        registerC19(undefined, 'keys');`,
    );
    const elapsedMs = performance.now() - startedAt;

    expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    expect(collectLexicalPaths(repeatBranches(24))).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 30_000);

  it('coalesces identical registration values from identical alternatives', () => {
    expectRegistrationPathCount(
      'if (flag) knownCreate(); else knownCreate();',
      1,
    );
  });

  it('treats registration insertion order as irrelevant but matches duplicates one-to-one', () => {
    expectRegistrationPathCount(
      `if (flag) {
        knownCreate();
        knownCreate();
        knownUpdate();
      } else {
        knownUpdate();
        knownCreate();
        knownCreate();
      }`,
      1,
    );
    expectRegistrationPathCount(
      'if (flag) { knownCreate(); knownCreate(); } else knownCreate();',
      2,
    );
  });

  it('keeps different registration values distinct and ownership intersection safe', () => {
    expectRegistrationPathCount(
      'if (flag) knownCreate(); else knownUpdate();',
      2,
    );

    const issues = validateInvocations(
      `if (c19Enabled) registerC19(undefined, 'keys');
        else registerC19(undefined, 'values');`,
    );
    expectMissing(issues, 'GROUP_CREATE');
    expectMissing(issues, 'GROUP_UPDATE');
  });

  it('keeps known, unknown, and different unknown lower bounds distinct', () => {
    expectRegistrationPathCount(
      'if (flag) knownCreate(); else unknownCreate();',
      2,
    );
    expectRegistrationPathCount(
      'if (flag) unknown(); else unknownCreate();',
      2,
    );
    expectRegistrationPathCount(
      'if (flag) unknownCreate(); else unknownCreateUpdate();',
      2,
    );
  });

  it('keeps true and false executed lexical overlays distinct', () => {
    expect(
      collectLexicalPaths(`let active = true;
        if (flag) active = true;
        else active = false;`),
    ).toHaveLength(2);
  });

  it('keeps normal, divergent, abrupt, labeled, and branch contexts distinct', () => {
    expect(collectLexicalPaths('while (flag) {}')).toHaveLength(2);
    expect(collectLexicalPaths('if (flag) return;')).toHaveLength(2);

    const group = {};
    const paths: readonly MutationExecutionPath<string>[] = [
      executionPath(NORMAL_COMPLETION),
      executionPath(DIVERGE_COMPLETION),
      executionPath({ kind: 'return' }),
      executionPath({ kind: 'break', label: 'outer' }),
      executionPath({ kind: 'break', label: 'inner' }),
      executionPath(NORMAL_COMPLETION, [{
        alternativeCount: 2,
        alternativeIndex: 0,
        group,
        optional: false,
      }]),
      executionPath(NORMAL_COMPLETION, [{
        alternativeCount: 2,
        alternativeIndex: 1,
        group,
        optional: false,
      }]),
    ];

    expect(coalesceExecutionPaths(paths, STRING_ADAPTER)).toHaveLength(paths.length);
    expect(coalesceExecutionPaths([paths[0]!, paths[0]!], STRING_ADAPTER)).toHaveLength(1);
  });
});

function collectLexicalPaths(body: string): readonly RoutingExecutionPath<never>[] {
  const { program, root } = parseFunction(body);
  const lexical = createMutationBoundaryLexicalValues(program);
  return collectRoutingExecutionPaths<never>(
    root,
    lexical,
    (_call, path) => path,
    mutationBoundaryLexicalValuesEqual,
  );
}

function expectRegistrationPathCount(body: string, count: number): void {
  const { program, root } = parseFunction(body);
  const paths = collectRoutingExecutionPaths<RegistrationTypeCollection>(
    root,
    createMutationBoundaryLexicalValues(program),
    appendRegistration,
    registrationTypeCollectionsEqual,
  );
  expect(paths).toHaveLength(count);
}

function appendRegistration(
  call: AstNode,
  path: RoutingExecutionPath<RegistrationTypeCollection>,
): RoutingExecutionPath<RegistrationTypeCollection> {
  const value = REGISTRATION_VALUES.get(readName(asNode(call.callee)));
  return value ? { ...path, values: [...path.values, value] } : path;
}

function registrationTypeCollectionsEqual(
  left: RegistrationTypeCollection,
  right: RegistrationTypeCollection,
): boolean {
  return left.kind === right.kind && left.types.size === right.types.size &&
    [...left.types].every((type) => right.types.has(type));
}

function parseFunction(body: string): Readonly<{ program: AstNode; root: AstNode }> {
  const program = parse(
    `function inspect(flag: boolean) { ${body} }`,
    { sourceType: 'module', plugins: ['typescript'] },
  ).program as unknown as AstNode;
  const root = (program.body as readonly AstNode[])[0]!;
  return { program, root };
}

function executionPath(
  completion: MutationExecutionPath<string>['completion'],
  branches: MutationExecutionPath<string>['branches'] = [],
): MutationExecutionPath<string> {
  return { branches, completion, conditional: branches.length > 0, state: 'same' };
}

const STRING_ADAPTER: MutationExecutionAdapter<string> = {
  lexical: () => undefined,
  nestedFunctions: 'skip',
  statesEqual: (left, right) => left === right,
  visit: (_node, state) => state,
};

function validateInvocations(invocation: string): readonly string[] {
  const source = readFileSync(GROUP_OWNER, 'utf8');
  let mutated = source.replace(
    CLASS_START,
    `${TYPE_MAP}\ndeclare const c19Enabled: boolean;\n\n${CLASS_START}`,
  );
  mutated = mutated.replace(
    LOOP_START,
    `        function registerC19(
            _ignored: unknown = undefined,
            MAP_METHOD = 'keys',
        ): void {\n${LOOP_START}`,
  );
  mutated = mutated.replace(
    LOOP_END,
    `        }\n        ${invocation}\n${LOOP_END}`,
  );
  mutated = mutated.replace(LIVE_GROUP_COLLECTION, 'C19_TYPE_MAP[MAP_METHOD]()');
  expect(mutated).not.toBe(source);
  return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
    sourceOverrides: new Map([[GROUP_OWNER, mutated]]),
  });
}

function repeatBranches(count: number): string {
  return Array.from({ length: count }, () => IDENTICAL_BRANCH).join('\n        ');
}

function expectProjection(
  issues: readonly string[],
  connected: string,
  missing: string,
): void {
  expect(hasMissingIssue(issues, connected)).toBe(false);
  expectMissing(issues, missing);
}

function expectMissing(issues: readonly string[], type: string): void {
  expect(hasMissingIssue(issues, type)).toBe(true);
}

function hasMissingIssue(issues: readonly string[], type: string): boolean {
  return issues.some((issue) => issue.includes(`${type} owner dispatch is not connected`));
}

function readName(value: AstNode | undefined): string {
  return value && typeof value.name === 'string' ? value.name : '';
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}
