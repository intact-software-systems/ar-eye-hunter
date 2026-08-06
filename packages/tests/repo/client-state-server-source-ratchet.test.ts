import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const maximumLineLength = 100;
const maximumModuleLines = 400;
const maximumFunctionLines = 60;
const canonicalProductionRoot = 'packages/shared-server/rallar-system/client-state';
const canonicalTestRoot = 'packages/tests/shared-server/client-state';

// Temporary PR C source/style evidence. The client-state server child owns it
// until the separate later ledger removes it after PR C resulting-main workflow
// and the listed semantic ownership evidence are both published.
const preservedPublicParameterCompatibility = new Set([
  'mutation/client-mutation-command.ts:toUpsertPrincipalCommandInput',
  'mutation/client-mutation-command.ts:toUpsertInstanceCommandInput',
  'mutation/client-mutation-command.ts:toConnectCommandInput',
  'mutation/client-mutation-command.ts:toHeartbeatCommandInput',
  'mutation/client-mutation-command.ts:toDisconnectCommandInput',
]);
const approvedDirectImportLineWidths = new Set([
  'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts:7:line-width',
  'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts:8:line-width',
  'packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts:17:line-width',
  'packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-read.ts:21:line-width',
  'packages/shared-server/rallar-system/client-state/persistence/assemble-client-state-snapshot.ts:16:line-width',
]);

describe('client-state server source/style ratchet fixtures', () => {
  it('detects overlong lines, functions, and positional parameter lists', () => {
    const source = [
      `const longLine = '${'x'.repeat(101)}';`,
      'function toFixture(one: string, two: string, three: string, four: string): void {}',
      'function longFixture(): void {',
      ...Array.from({ length: 60 }, () => '  // fixture line'),
      '}',
    ].join('\n');

    expect(readStyleViolations('fixture.ts', source)).toEqual([
      'fixture.ts:1:line-width',
      'fixture.ts:2:toFixture:parameters',
      'fixture.ts:3:longFixture:function-length',
    ]);
  });
});

describe('client-state server source/style ratchet', () => {
  it('keeps canonical production and directly owned test modules within 400 lines', () => {
    expect(
      readRatchetedSources()
        .filter(({ source }) => physicalLineCount(source) > maximumModuleLines)
        .map(({ filePath }) => filePath),
    ).toEqual([]);
  });

  it('keeps canonical production source within 100 columns except canonical direct imports', () => {
    expect(
      readProductionSources().flatMap(({ filePath, source }) =>
        readStyleViolations(filePath, source).filter(
          (violation) =>
            violation.endsWith(':line-width') && !approvedDirectImportLineWidths.has(violation),
        ),
      ),
    ).toEqual([]);
  });

  it('keeps canonical production functions concise with named inputs after three parameters', () => {
    expect(
      readProductionSources().flatMap(({ filePath, source }) =>
        readStyleViolations(filePath, source).filter((violation) => {
          if (!violation.endsWith(':parameters')) return violation.endsWith(':function-length');
          return !preservedPublicParameterCompatibility.has(
            `${relativeProductionPath(filePath)}:${functionName(violation)}`,
          );
        }),
      ),
    ).toEqual([]);
  });

  it('keeps cache-key ownership with the shared repository contract', () => {
    const cache = read(
      'packages/shared-server/rallar-system/client-state/snapshot/client-state-snapshot-read-through-cache.ts',
    );

    expect(cache).not.toContain('function toClientStateSnapshotRepositoryKey(');
    expect(cache).toContain(
      "toClientStateSnapshotRepositoryKey,\n} from '@shared/repository/client-state-snapshots-repository.ts';",
    );
  });
});

function readRatchetedSources(): readonly { readonly filePath: string; readonly source: string }[] {
  return [canonicalProductionRoot, canonicalTestRoot]
    .flatMap(readTypeScriptPaths)
    .sort()
    .map((filePath) => ({ filePath, source: read(filePath) }));
}

function readProductionSources(): readonly {
  readonly filePath: string;
  readonly source: string;
}[] {
  return readTypeScriptPaths(canonicalProductionRoot)
    .sort()
    .map((filePath) => ({ filePath, source: read(filePath) }));
}

function readTypeScriptPaths(directoryPath: string): readonly string[] {
  return readdirSync(path.join(repoRoot, directoryPath), { withFileTypes: true }).flatMap(
    (entry) => {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) return readTypeScriptPaths(entryPath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    },
  );
}

function readStyleViolations(filePath: string, source: string): readonly string[] {
  const lineWidthViolations = source
    .split('\n')
    .flatMap((line, index) =>
      line.length > maximumLineLength ? [`${filePath}:${index + 1}:line-width`] : [],
    );
  const functionViolations: string[] = [];
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;

  visit(program, undefined, (node, parent) => {
    if (node.type !== 'FunctionDeclaration' || isDescribeCallback(parent)) return;
    const name = functionNodeName(node);
    const line = node.loc.start.line;
    if (node.loc.end.line - line + 1 > maximumFunctionLines) {
      functionViolations.push(`${filePath}:${line}:${name}:function-length`);
    }
    if (node.params.length > 3) {
      functionViolations.push(`${filePath}:${line}:${name}:parameters`);
    }
  });

  return [...lineWidthViolations, ...functionViolations];
}

function physicalLineCount(source: string): number {
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

function relativeProductionPath(filePath: string): string {
  return filePath.startsWith(`${canonicalProductionRoot}/`)
    ? filePath.slice(canonicalProductionRoot.length + 1)
    : filePath;
}

function functionName(violation: string): string {
  return violation.split(':').at(-2) ?? '';
}

function visit(
  value: unknown,
  parent: Record<string, unknown> | undefined,
  action: (node: FunctionNode, parent: Record<string, unknown> | undefined) => void,
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, parent, action);
    return;
  }
  const node = value as Record<string, unknown>;
  if (isFunctionNode(node)) action(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'loc' && key !== 'start' && key !== 'end') visit(child, node, action);
  }
}

interface FunctionNode extends Record<string, unknown> {
  readonly type: string;
  readonly loc: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly params: readonly unknown[];
  readonly id?: { readonly name?: string };
  readonly key?: { readonly name?: string };
}

function isFunctionNode(value: Record<string, unknown>): value is FunctionNode {
  return (
    /(?:Function(?:Declaration|Expression)|ArrowFunctionExpression|ObjectMethod|ClassMethod)$/.test(
      String(value.type),
    ) &&
    Array.isArray(value.params) &&
    isLocation(value.loc)
  );
}

function isDescribeCallback(parent: Record<string, unknown> | undefined): boolean {
  const callee = parent?.callee as { readonly name?: unknown } | undefined;
  return parent?.type === 'CallExpression' && callee?.name === 'describe';
}

function functionNodeName(node: FunctionNode): string {
  if (typeof node.id?.name === 'string') return node.id.name;
  if (typeof node.key?.name === 'string') return node.key.name;
  return '<callback>';
}

function isLocation(value: unknown): value is FunctionNode['loc'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FunctionNode['loc']).start?.line === 'number' &&
    typeof (value as FunctionNode['loc']).end?.line === 'number'
  );
}

function read(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}
