import { readFileSync } from 'node:fs';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const maximumLineLength = 100;
const maximumModuleLines = 400;
type RatchetedSourceKind = 'production' | 'test';
// Temporary Task 7 evidence; the later child ledger decides removal once
// semantic coverage is published.
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
  'packages/tests/repo/api-v1-group-state-route-style-ratchet.test.ts',
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
describe('API-v1 group-state route source/style ratchet fixtures', () => {
  it('does not let arbitrary brace or bracket strings hide overlong lines', () => {
    const longComment = 'x'.repeat(110);
    const productionFixture = `const marker = '{}'; // ${longComment}`;
    const ordinaryTestFixture = `const marker = '[ordinary]'; // ${longComment}`;
    const unrelatedJsonAssertion = [
      'assert.equal(',
      '  marker,',
      `  '{"description":"${longComment}"}',`,
      ');',
    ].join('\n');

    expect(
      readLineLengthViolations('production-fixture.ts', productionFixture, 'production'),
    ).toEqual(['production-fixture.ts:1']);
    expect(
      readLineLengthViolations('ordinary-test-fixture.ts', ordinaryTestFixture, 'test'),
    ).toEqual(['ordinary-test-fixture.ts:1']);
    expect(
      readLineLengthViolations('unrelated-json-assertion.test.ts', unrelatedJsonAssertion, 'test'),
    ).toEqual(['unrelated-json-assertion.test.ts:3']);
  });

  it('permits independently written raw JSON assertion literals in tests', () => {
    const expectedJson = `{"second":2,"first":1,"description":"${'x'.repeat(110)}"}`;
    const rawAssertionFixture = [
      'assert.equal(',
      '  JSON.stringify(actual),',
      `  '${expectedJson}',`,
      ');',
    ].join('\n');

    expect(
      readLineLengthViolations('raw-assertion-fixture.test.ts', rawAssertionFixture, 'test'),
    ).toEqual([]);
  });

  it('detects overlong callbacks and positional parameter lists in test source', () => {
    const longCallbackFixture = [
      "Deno.test('long callback', async () => {",
      ...Array.from({ length: 60 }, () => '  // callback fixture line'),
      '});',
    ].join('\n');
    const positionalParametersFixture =
      'function readFixture(one: string, two: string, three: string, four: string): void {}';

    expect(readFunctionStyleViolations('long-callback.test.ts', longCallbackFixture)).toEqual([
      'long-callback.test.ts:1:function-length',
    ]);
    expect(
      readFunctionStyleViolations('positional-parameters.test.ts', positionalParametersFixture),
    ).toEqual(['positional-parameters.test.ts:1:parameters']);
  });
});

describe('API-v1 group-state route source/style ratchet inventory', () => {
  it('keeps every moved module within the 400-line target', () => {
    expect(
      [...ratchetedProductionPaths, ...ratchetedTestPaths].filter(
        (filePath) => physicalLineCount(read(filePath)) > maximumModuleLines,
      ),
    ).toEqual([]);
  });

  it('keeps ordinary source and test lines within 100 columns', () => {
    expect([
      ...ratchetedProductionPaths.flatMap((filePath) =>
        readLineLengthViolations(filePath, read(filePath), 'production'),
      ),
      ...ratchetedTestPaths.flatMap((filePath) =>
        readLineLengthViolations(filePath, read(filePath), 'test'),
      ),
    ]).toEqual([]);
  });

  it(
    'keeps moved production and test functions concise with named inputs ' +
      'after three parameters',
    () => {
      const violations = [...ratchetedProductionPaths, ...ratchetedTestPaths].flatMap((filePath) =>
        readFunctionStyleViolations(filePath, read(filePath)),
      );

      expect(violations).toEqual([]);
    },
  );
});

function read(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function physicalLineCount(source: string): number {
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

function readLineLengthViolations(
  filePath: string,
  source: string,
  sourceKind: RatchetedSourceKind,
): readonly string[] {
  const allowedRawAssertionLines =
    sourceKind === 'test' ? readRawJsonAssertionLines(source) : new Set<number>();

  return source
    .split('\n')
    .flatMap((line, index) =>
      line.length > maximumLineLength && !allowedRawAssertionLines.has(index + 1)
        ? [`${filePath}:${index + 1}`]
        : [],
    );
}

function readRawJsonAssertionLines(source: string): ReadonlySet<number> {
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  const sourceLines = source.split('\n');
  const rawAssertionLines = new Set<number>();

  visit(program, (node) => {
    const expectedLiteral = readAssertExpectedStringLiteral(node);
    if (expectedLiteral === undefined || !isJsonObjectOrArray(expectedLiteral.value)) return;

    const { start, end } = expectedLiteral.loc;
    if (start.line !== end.line) return;

    const sourceLine = sourceLines[start.line - 1] ?? '';
    const prefix = sourceLine.slice(0, start.column);
    const suffix = sourceLine.slice(end.column);
    if (prefix.trim() === '' && suffix.trim() === ',') rawAssertionLines.add(start.line);
  });

  return rawAssertionLines;
}

function readAssertExpectedStringLiteral(node: Record<string, unknown>):
  | {
      readonly value: string;
      readonly loc: SourceLocation;
    }
  | undefined {
  if (node.type !== 'CallExpression' || !Array.isArray(node.arguments)) return undefined;
  if (!isAssertEqualityCallee(node.callee)) return undefined;
  if (!isJsonStringifyCall(node.arguments[0])) return undefined;

  const expected = node.arguments[1];
  return isRecord(expected) &&
    expected.type === 'StringLiteral' &&
    typeof expected.value === 'string' &&
    isSourceLocation(expected.loc)
    ? { value: expected.value, loc: expected.loc }
    : undefined;
}

function isJsonStringifyCall(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'CallExpression') return false;
  if (!isRecord(value.callee) || value.callee.type !== 'MemberExpression') return false;
  if (!isRecord(value.callee.object) || value.callee.object.type !== 'Identifier') return false;
  if (value.callee.object.name !== 'JSON' || !isRecord(value.callee.property)) return false;

  return value.callee.property.type === 'Identifier' && value.callee.property.name === 'stringify';
}

function isAssertEqualityCallee(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'MemberExpression') return false;
  if (!isRecord(value.object) || value.object.type !== 'Identifier') return false;
  if (value.object.name !== 'assert' || !isRecord(value.property)) return false;

  return (
    value.property.type === 'Identifier' &&
    (value.property.name === 'equal' || value.property.name === 'strictEqual')
  );
}

function isJsonObjectOrArray(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) || isRecord(parsed);
  } catch {
    return false;
  }
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

interface SourceLocation {
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
}

function isSourceLocation(value: unknown): value is SourceLocation {
  return (
    isRecord(value) &&
    isRecord(value.start) &&
    typeof value.start.line === 'number' &&
    typeof value.start.column === 'number' &&
    isRecord(value.end) &&
    typeof value.end.line === 'number' &&
    typeof value.end.column === 'number'
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
