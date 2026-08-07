import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

import { findLockedAppAuthInboxConstructor } from './auth-server-constructor-signature-validation.ts';
import { authServerEvidencePaths } from './auth-server-evidence-paths.ts';

const repoRoot = process.cwd();
const maximumLineLength = 100;
const maximumModuleLines = 400;
const maximumFunctionLines = 60;
const canonicalProductionRoot = 'packages/shared-server/rallar-system/auth';
const canonicalTestRoot = 'packages/tests/shared-server/auth';
const lockedConstructorOwner = `${canonicalProductionRoot}/inbox/app-auth-inbox-service.ts`;
const requiredMovedOwners = [
  `${canonicalTestRoot}/auth-app-inbox-test-runtime.ts`,
  `${canonicalTestRoot}/auth-legacy-cutoff.test.ts`,
  `${canonicalTestRoot}/auth-test-fixtures.ts`,
  `${canonicalTestRoot}/auth-ticket-conflict.test.ts`,
  `${canonicalTestRoot}/auth-transaction-boundary.test.ts`,
] as const;
const removedPredecessors = [
  'packages/tests/shared-server/app-auth-conflict-inbox.test.ts',
  'packages/tests/shared-server/app-auth-inbox-service.test.ts',
  'packages/tests/shared-server/app-auth-inbox-test-harness.ts',
  'packages/tests/shared-server/app-auth-legacy-cutoff.test.ts',
  'packages/tests/shared-server/app-auth-legacy-replay-inbox.test.ts',
  'packages/tests/shared-server/app-auth-persistence-inbox.test.ts',
  'packages/tests/shared-server/app-auth-public-routing-inbox.test.ts',
  'packages/tests/shared-server/app-auth-transaction-inbox.test.ts',
  'packages/tests/shared-server/auth-fixture.ts',
  'packages/tests/shared-server/auth-login-service.test.ts',
  'packages/tests/shared-server/request-auth-service.test.ts',
] as const;
const crossDomainCallbackOwners = [
  'packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts',
  'packages/tests/shared-server/mutation-route-owner-provenance.test.ts',
] as const;
const compatibilityPaths = [
  'packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts',
  'packages/shared-server/rallar-system/repositories/AuthUserRepository.ts',
  'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
  'packages/shared-server/rallar-system/services/auth-credential-issuer.ts',
  'packages/shared-server/rallar-system/services/auth-login-service.ts',
  'packages/shared-server/rallar-system/services/auth-state-mutations.ts',
] as const;
const lockedConstructorParameters = [
  'public override readonly inbox: InboxQueueReader',
  'public override readonly resourceInbox: ResourceInboxRepository',
  'public override readonly resourceInboxResults: ResourceInboxResultsRepository',
  'database: PSqlSql',
  'public readonly authMutationService: AuthMutationService',
  'public readonly credentialIssuer: AuthCredentialIssuer',
  'public override readonly serviceId: string',
  'timing?: RallarTimingSink',
  'options?: AppInboxServiceOptions',
  'wakeQueue?: () => void',
] as const;

// Temporary PR C source/style evidence. The auth server child owns it through
// PR C. The separate later ledger decides removal only after the PR C
// resulting-main workflow and the listed semantic ownership suites publish.
describe('auth server source/style ratchet fixtures', () => {
  it('detects overlong modules, lines, callbacks, and positional inputs', () => {
    const formatterStableImport =
      "import { createHmacAuthCredentialIssuer } from '" +
      "@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';";
    const source = [
      formatterStableImport,
      'const fixture = [',
      `  '${'x'.repeat(101)}',`,
      '];',
      `const longLine = '${'x'.repeat(101)}';`,
      'function positional(one, two, three, four) {}',
      "describe('fixture', () => {",
      ...Array.from({ length: 59 }, () => '  // fixture line'),
      '});',
    ].join('\n');

    expect(readStyleViolations('fixture.ts', source, 4)).toEqual([
      'fixture.ts:module-length',
      'fixture.ts:5:line-width',
      'fixture.ts:6:positional:parameters',
      'fixture.ts:7:describe callback:function-length',
    ]);
  });
});

describe('AppAuthInboxService constructor signature fixtures', () => {
  it('exempts only the exact locked constructor AST node', () => {
    const filePath = lockedConstructorOwner;

    expect(
      readStyleViolations(filePath, toConstructorFixture(lockedConstructorParameters)),
    ).toEqual([]);
  });

  it('rejects constructor drift instead of exempting every constructor-shaped violation', () => {
    const constructorSource = toConstructorFixture([
      ...lockedConstructorParameters,
      'extra: string',
    ]);
    const filePath = lockedConstructorOwner;
    const violations = readStyleViolations(filePath, constructorSource);

    expect(violations).toContain(`${filePath}:2:constructor:parameters`);
  });
});

describe('AppAuthInboxService constructor rejection fixtures', () => {
  it.each([
    {
      label: 'renamed parameter',
      parameters: replaceParameter(
        lockedConstructorParameters,
        0,
        'public override readonly queue: InboxQueueReader',
      ),
    },
    {
      label: 'reordered parameters',
      parameters: replaceParameter(
        replaceParameter(lockedConstructorParameters, 0, lockedConstructorParameters[1]),
        1,
        lockedConstructorParameters[0],
      ),
    },
    {
      label: 'changed parameter type',
      parameters: replaceParameter(lockedConstructorParameters, 3, 'database: unknown'),
    },
  ])('rejects a $label in the locked constructor', ({ parameters }) => {
    const filePath = lockedConstructorOwner;
    const violations = readStyleViolations(filePath, toConstructorFixture(parameters));

    expect(violations).toContain(`${filePath}:2:constructor:parameters`);
  });

  it('rejects a second AppAuthInboxService constructor', () => {
    const filePath = lockedConstructorOwner;
    const source = toConstructorFixture(lockedConstructorParameters, true);
    const violations = readStyleViolations(filePath, source);

    expect(violations.some((violation) => violation.endsWith(':constructor:parameters'))).toBe(
      true,
    );
  });

  it('does not exempt the same signature outside the locked production owner', () => {
    const filePath = `${canonicalProductionRoot}/inbox/not-app-auth-inbox-service.ts`;
    const violations = readStyleViolations(
      filePath,
      toConstructorFixture(lockedConstructorParameters),
    );

    expect(violations).toContain(`${filePath}:2:constructor:parameters`);
  });
});

function toConstructorFixture(parameters: readonly string[], includeOverload = false): string {
  const overload = lockedConstructorParameters.map((parameter) =>
    parameter.replace(/^(?:public )(?:override )?(?:readonly )?/, ''),
  );
  return [
    'export class AppAuthInboxService {',
    ...(includeOverload ? constructorLines(overload, ';') : []),
    ...constructorLines(parameters, ' {}'),
    '}',
  ].join('\n');
}

function constructorLines(parameters: readonly string[], ending: string): readonly string[] {
  return ['  constructor(', ...parameters.map((parameter) => `    ${parameter},`), `  )${ending}`];
}

function replaceParameter(
  parameters: readonly string[],
  index: number,
  replacement: string,
): readonly string[] {
  return parameters.map((parameter, parameterIndex) =>
    parameterIndex === index ? replacement : parameter,
  );
}

describe('auth server source/style ratchet', () => {
  it('requires behavior-named owners and removes every stale predecessor path', () => {
    expect(requiredMovedOwners.filter((filePath) => !existsSync(absolute(filePath)))).toEqual([]);
    expect(removedPredecessors.filter((filePath) => existsSync(absolute(filePath)))).toEqual([]);
  });

  it('keeps canonical production, moved tests, and review evidence within source limits', () => {
    const violations = readRatchetedSources().flatMap(({ filePath, source }) =>
      readStyleViolations(filePath, source),
    );

    expect(violations).toEqual([]);
  });

  it('keeps every compatibility owner direct named re-export-only', () => {
    const findings = compatibilityPaths.flatMap((filePath) => {
      const program = parse(read(filePath), {
        sourceType: 'module',
        plugins: ['typescript'],
      }).program;
      return program.body.every(
        (statement) =>
          statement.type === 'ExportNamedDeclaration' &&
          statement.source !== null &&
          statement.specifiers.every((specifier) => specifier.type !== 'ExportNamespaceSpecifier'),
      )
        ? []
        : [filePath];
    });

    expect(findings).toEqual([]);
  });

  it('keeps canonical auth tests off compatibility-only import paths', () => {
    const compatibilityImports = readTypeScriptPaths(canonicalTestRoot).flatMap((filePath) =>
      readImports(filePath).filter((importPath) =>
        compatibilityPaths.includes(importPath as never),
      ),
    );

    expect(compatibilityImports).toEqual([]);
  });
});

interface RatchetedSource {
  readonly filePath: string;
  readonly source: string;
}

interface FunctionNode extends Record<string, unknown> {
  readonly type: string;
  readonly loc: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly params: readonly unknown[];
  readonly id?: { readonly name?: string };
  readonly key?: { readonly name?: string; readonly id?: { readonly name?: string } };
}

function readRatchetedSources(): readonly RatchetedSource[] {
  const filePaths = [
    ...readTypeScriptPaths(canonicalProductionRoot),
    ...readTypeScriptPaths(canonicalTestRoot),
    ...crossDomainCallbackOwners,
    ...authServerEvidencePaths,
  ];
  return [...new Set(filePaths)].sort().map((filePath) => ({
    filePath,
    source: read(filePath),
  }));
}

function readTypeScriptPaths(directoryPath: string): readonly string[] {
  return readdirSync(absolute(directoryPath), { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) return readTypeScriptPaths(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

function readStyleViolations(
  filePath: string,
  source: string,
  moduleLimit = maximumModuleLines,
): readonly string[] {
  const violations = physicalLineCount(source) > moduleLimit ? [`${filePath}:module-length`] : [];
  source.split('\n').forEach((line, index) => {
    if (
      line.length > maximumLineLength &&
      !isFormatterStableImport(line) &&
      !isFormatterStableFixtureLiteral(line)
    ) {
      violations.push(`${filePath}:${index + 1}:line-width`);
    }
  });
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
  const lockedConstructor =
    filePath === lockedConstructorOwner
      ? findLockedAppAuthInboxConstructor(program as unknown as FunctionNode)
      : undefined;
  visit(program, undefined, (node, parent) => {
    const name = functionNodeName(node, parent);
    if (node.loc.end.line - node.loc.start.line + 1 > maximumFunctionLines) {
      violations.push(`${filePath}:${node.loc.start.line}:${name}:function-length`);
    }
    if (node.params.length > 3 && node !== lockedConstructor) {
      violations.push(`${filePath}:${node.loc.start.line}:${name}:parameters`);
    }
  });
  return violations;
}

// Prettier preserves single-specifier imports on one physical line even when the
// module specifier carries that line past printWidth. The ratchet accepts only
// that formatter-stable syntax; every other source line remains capped at 100.
function isFormatterStableImport(line: string): boolean {
  return /^import (?:type )?\{?[^{};]+\}? from ['"][^'"]+['"];$/.test(line);
}

// Exact serialized fixtures and regex expectations must keep their literal byte
// sequence. Prettier cannot wrap a literal token without changing that evidence.
function isFormatterStableFixtureLiteral(line: string): boolean {
  const trimmed = line.trim();
  return (
    (trimmed.startsWith("'") &&
      (trimmed.endsWith("',") || trimmed.endsWith("';") || trimmed.endsWith("');"))) ||
    (trimmed.startsWith('/') && trimmed.endsWith('/,'))
  );
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
    if (!['loc', 'start', 'end'].includes(key)) visit(child, node, action);
  }
}

function isFunctionNode(value: Record<string, unknown>): value is FunctionNode {
  const pattern = new RegExp(
    '(?:Function(?:Declaration|Expression)|ArrowFunctionExpression|' +
      'ObjectMethod|Class(?:Method|PrivateMethod))$',
  );
  return pattern.test(String(value.type)) && Array.isArray(value.params) && isLocation(value.loc);
}

function functionNodeName(node: FunctionNode, parent: Record<string, unknown> | undefined): string {
  if (typeof node.id?.name === 'string') return node.id.name;
  if (typeof node.key?.name === 'string') return node.key.name;
  if (typeof node.key?.id?.name === 'string') return `#${node.key.id.name}`;
  const variableId = parent?.id as { readonly name?: unknown } | undefined;
  if (parent?.type === 'VariableDeclarator' && typeof variableId?.name === 'string') {
    return variableId.name;
  }
  const callee = parent?.callee as { readonly name?: unknown } | undefined;
  return typeof callee?.name === 'string' ? `${callee.name} callback` : '<callback>';
}

function isLocation(value: unknown): value is FunctionNode['loc'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FunctionNode['loc']).start?.line === 'number' &&
    typeof (value as FunctionNode['loc']).end?.line === 'number'
  );
}

function readImports(filePath: string): readonly string[] {
  const program = parse(read(filePath), { sourceType: 'module', plugins: ['typescript'] }).program;
  return program.body.flatMap((statement) => {
    if (statement.type !== 'ImportDeclaration') return [];
    return [resolveImportPath(filePath, statement.source.value)];
  });
}

function resolveImportPath(filePath: string, specifier: string): string {
  if (specifier.startsWith('@shared-server/')) {
    return path.posix.join('packages/shared-server', specifier.slice('@shared-server/'.length));
  }
  if (specifier.startsWith('.')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier));
  }
  return specifier;
}

function physicalLineCount(source: string): number {
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}
