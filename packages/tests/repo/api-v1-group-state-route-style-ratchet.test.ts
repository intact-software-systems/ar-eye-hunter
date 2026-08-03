import { readFileSync } from 'node:fs';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const maximumLineLength = 100;
const maximumModuleLines = 400;
// Temporary Task 7 evidence; the later child ledger decides removal once semantic coverage is published.
const ratchetedProductionPaths = [
  'apps/api-v1/src/group-state/create-group-state-route-dependencies.ts',
  'apps/api-v1/src/group-state/group-state-route-authorization.ts',
  'apps/api-v1/src/group-state/group-state-route-contracts.ts',
  'apps/api-v1/src/group-state/group-state-route-errors.ts',
  'apps/api-v1/src/group-state/read-group-state-route-request.ts',
  'apps/api-v1/src/group-state/register-group-admission-routes.ts',
  'apps/api-v1/src/group-state/register-group-membership-routes.ts',
  'apps/api-v1/src/group-state/register-group-presence-routes.ts',
  'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts',
  'apps/api-v1/src/group-state/register-group-state-read-routes.ts',
  'apps/api-v1/src/group-state/register-group-state-routes.ts',
  'apps/api-v1/src/group-state/to-group-state-command.ts',
  'apps/api-v1/src/group-state/to-group-state-response.ts',
] as const;
const ratchetedTestPaths = [
  'apps/api-v1/test/group-state/group-admission-routes.test.ts',
  'apps/api-v1/test/group-state/group-membership-routes.test.ts',
  'apps/api-v1/test/group-state/group-presence-routes.test.ts',
  'apps/api-v1/test/group-state/group-state-mutation-routes.test.ts',
  'apps/api-v1/test/group-state/group-state-openapi-contract.test.ts',
  'apps/api-v1/test/group-state/group-state-read-routes.test.ts',
  'apps/api-v1/test/group-state/group-state-route-errors.test.ts',
  'apps/api-v1/test/group-state/group-state-route-test-runtime.ts',
  'apps/api-v1/test/group-state/register-group-state-routes.test.ts',
  'apps/api-v1/test/routes/state-api-cross-feature-routes.test.ts',
] as const;
const rawContractLiteralPattern = /['"](?:\[|\{)[^'"`]*['"]/;

describe('API-v1 group-state route source/style ratchet', () => {
  it('keeps every moved module within the 400-line target', () => {
    expect(
      [...ratchetedProductionPaths, ...ratchetedTestPaths].filter(
        (filePath) => physicalLineCount(read(filePath)) > maximumModuleLines,
      ),
    ).toEqual([]);
  });

  it('keeps ordinary source and test lines within 100 columns', () => {
    expect(
      [...ratchetedProductionPaths, ...ratchetedTestPaths].flatMap((filePath) =>
        read(filePath)
          .split('\n')
          .flatMap((line, index) =>
            line.length > maximumLineLength && !rawContractLiteralPattern.test(line)
              ? [`${filePath}:${index + 1}`]
              : [],
          ),
      ),
    ).toEqual([]);
  });

  it('keeps production functions concise and supplied through named inputs after three parameters', () => {
    const violations = ratchetedProductionPaths.flatMap((filePath) =>
      readFunctionStyleViolations(filePath, read(filePath)),
    );

    expect(violations).toEqual([]);
  });
});

function read(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function physicalLineCount(source: string): number {
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

function readFunctionStyleViolations(filePath: string, source: string): readonly string[] {
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  const violations: string[] = [];

  visit(program, (node) => {
    if (!isFunctionNode(node)) return;

    const lineSpan = node.loc.end.line - node.loc.start.line + 1;
    if (lineSpan > 60) violations.push(`${filePath}:${node.loc.start.line}:function-length`);
    if (node.params.length > 3) violations.push(`${filePath}:${node.loc.start.line}:parameters`);
  });

  return violations;
}

function isFunctionNode(node: Record<string, unknown>): node is Record<string, unknown> & {
  readonly loc: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly params: readonly unknown[];
} {
  return (
    /(?:Function(?:Declaration|Expression)|ArrowFunctionExpression|ObjectMethod|ClassMethod)$/.test(
      String(node.type),
    ) &&
    Array.isArray(node.params) &&
    isLocation(node.loc)
  );
}

function isLocation(value: unknown): value is {
  readonly start: { readonly line: number };
  readonly end: { readonly line: number };
} {
  return (
    isRecord(value) &&
    isRecord(value.start) &&
    typeof value.start.line === 'number' &&
    isRecord(value.end) &&
    typeof value.end.line === 'number'
  );
}

function visit(value: unknown, onNode: (node: Record<string, unknown>) => void): void {
  if (!isRecord(value)) return;

  onNode(value);
  for (const [key, child] of Object.entries(value)) {
    if (!['loc', 'start', 'end', 'tokens', 'comments', 'errors'].includes(key)) {
      Array.isArray(child) ? child.forEach((item) => visit(item, onNode)) : visit(child, onNode);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
