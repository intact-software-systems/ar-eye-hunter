import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const removedMixedOwners = [
  'packages/tests/shared-server/app-client-inbox-service.test.ts',
  'packages/tests/shared-server/client-state-concurrency.test.ts',
  'packages/tests/shared-server/client-state-service-idempotency.test.ts',
] as const;
const finalTestOwners = [
  'packages/tests/shared-server/client-state/app-client-inbox-authentication.test.ts',
  'packages/tests/shared-server/client-state/app-client-inbox-mutation-test-harness.ts',
  'packages/tests/shared-server/client-state/app-client-inbox-operation-matrix.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-authorised-ws-generation.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-command-and-request.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-concurrency.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-concurrency-test-runtime.ts',
  'packages/tests/shared-server/client-state/client-mutation-idempotency.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-lifecycle-validation.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-persisted-state-validation.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-principal-and-instance.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-rollback-test-harness.ts',
  'packages/tests/shared-server/client-state/client-mutation-session-replay.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-session-lifecycle.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-transaction-boundary-fixture.ts',
  'packages/tests/shared-server/client-state/client-mutation-transaction-convergence.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-transaction-and-outbox.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-validation.test.ts',
  'packages/tests/shared-server/client-state/client-mutation-validation-test-fixtures.ts',
  'packages/tests/shared-server/client-state/client-state-public-compatibility.test.ts',
  'packages/tests/shared-server/client-state/client-state-service-timing.test.ts',
  'packages/tests/shared-server/client-state/client-state-service-test-fixtures.ts',
] as const;
const lineageOwners = [
  'packages/tests/repo/client-state-server-lineage-provenance.test.ts',
  'packages/tests/repo/client-state-server-lineage-evidence.ts',
  'packages/tests/repo/client-state-server-mutation-lineage-inventory.ts',
] as const;

describe('client-state server test ownership', () => {
  it('moves every mixed predecessor suite to behavior-named client-state owners', () => {
    for (const filePath of finalTestOwners) {
      expect(existsSync(path.join(repoRoot, filePath)), filePath).toBe(true);
    }
    for (const filePath of removedMixedOwners) {
      expect(existsSync(path.join(repoRoot, filePath)), filePath).toBe(false);
    }
  });

  it('keeps every final test and lineage evidence owner within 400 physical lines', () => {
    for (const filePath of [...finalTestOwners, ...lineageOwners]) {
      expect(physicalLines(read(filePath)), filePath).toBeLessThanOrEqual(400);
    }
  });

  it('keeps every moved general function and test callback within 60 physical lines', () => {
    for (const filePath of [...finalTestOwners, ...lineageOwners]) {
      expect(oversizedFunctions(read(filePath)), filePath).toEqual([]);
    }
  });

  it('keeps the supplementary source ratchet owned by PR C before ledger publication', () => {
    const ratchet = read('packages/tests/repo/client-state-server-source-ratchet.test.ts');
    expect(ratchet).toContain(
      [
        'Owner: Task 4A persistence cohort; PR C must decide whether to remove, replace,',
        '// or retain this supplementary ratchet after PR B publication evidence exists.',
        '// The separate later ledger records that already-made PR C decision.',
      ].join('\n'),
    );
    expect(ratchet).not.toContain('PR C ledger');
  });

  it('registers the persistent test-ownership evidence with repository governance', () => {
    const script = JSON.parse(readRaw('package.json')).scripts['test:repo-governance'] as string;
    expect(script).toContain('packages/tests/repo/client-state-server-test-ownership.test.ts');
  });
});

function physicalLines(source: string): number {
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

function read(filePath: string): string {
  const source = readRaw(filePath);
  parse(source, { sourceType: 'module', plugins: ['typescript'] });
  return source;
}

function readRaw(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

interface SyntaxNode {
  readonly type: string;
  readonly loc?: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly callee?: SyntaxNode & { readonly name?: string };
  readonly [key: string]: unknown;
}

function oversizedFunctions(source: string): readonly string[] {
  const root = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }) as unknown as SyntaxNode;
  const findings: string[] = [];
  visit(root, undefined, findings);
  return findings;
}

function visit(node: SyntaxNode, parent: SyntaxNode | undefined, findings: string[]): void {
  if (isFunction(node) && node.loc && !isDescribeCallback(parent)) {
    const lines = node.loc.end.line - node.loc.start.line + 1;
    if (lines > 60) findings.push(`${node.loc.start.line}:${lines}`);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isSyntaxNode(child)) visit(child, node, findings);
    } else if (isSyntaxNode(value)) {
      visit(value, node, findings);
    }
  }
}

function isFunction(node: SyntaxNode): boolean {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}

function isDescribeCallback(parent: SyntaxNode | undefined): boolean {
  return parent?.type === 'CallExpression' && parent.callee?.name === 'describe';
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === 'object' && value !== null && typeof (value as SyntaxNode).type === 'string'
  );
}
