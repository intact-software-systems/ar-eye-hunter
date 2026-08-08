import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse } from '@babel/parser';

import {
  authServerInheritedDiagnosticLedger,
  type InheritedDiagnosticDisposition,
  type TypeScriptDiagnostic,
} from './auth-server-inherited-diagnostic-ledger.ts';

export type { TypeScriptDiagnostic } from './auth-server-inherited-diagnostic-ledger.ts';

interface PathEvidence {
  readonly path: string;
  readonly baseExists: boolean;
  readonly headExists: boolean;
  readonly baseDiagnostics: readonly TypeScriptDiagnostic[];
  readonly headDiagnostics: readonly TypeScriptDiagnostic[];
}

interface DiagnosticEvidence {
  readonly baseSha: string;
  readonly baseStatus: number;
  readonly headStatus: number;
  readonly touchedPaths: readonly string[];
  readonly pathEvidence: readonly PathEvidence[];
  readonly baseDiagnostics: readonly TypeScriptDiagnostic[];
  readonly headDiagnostics: readonly TypeScriptDiagnostic[];
  readonly inheritedDiagnosticLedger: readonly InheritedDiagnosticDisposition[];
  readonly diagnosticDispositionViolations: readonly string[];
}

interface CompilerResult {
  readonly status: number;
  readonly diagnostics: readonly TypeScriptDiagnostic[];
}

interface DiagnosticLocation {
  readonly column: number;
  readonly owner: string;
  readonly ownerRelativeLine: number;
}

interface DiagnosticOwner {
  readonly name: string;
  readonly span: number;
  readonly startLine: number;
}

interface DiagnosticPoint {
  readonly column: number;
  readonly line: number;
}

interface AstNode extends Record<string, unknown> {
  readonly type: string;
  readonly loc?: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
}

const repoRoot = process.cwd();
const exactBaseSha = '8152de39faf2d630158143366596d61346e20457';
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts'] as const;

export function readTouchedTypeScriptDiagnostics(): DiagnosticEvidence {
  requireExactBase();
  const touchedPaths = readTouchedPaths();
  const baseRoot = createBaseWorktree();
  try {
    const base = runCompiler(baseRoot, touchedPaths);
    const head = runCompiler(repoRoot, touchedPaths);
    const diagnosticDispositionViolations = readDiagnosticDispositionViolations(
      head.diagnostics,
      authServerInheritedDiagnosticLedger,
    );
    return {
      baseSha: exactBaseSha,
      baseStatus: base.status,
      headStatus: head.status,
      touchedPaths,
      pathEvidence: touchedPaths.map((filePath) => ({
        path: filePath,
        baseExists: existsSync(path.join(baseRoot, filePath)),
        headExists: existsSync(path.join(repoRoot, filePath)),
        baseDiagnostics: base.diagnostics.filter((item) => item.path === filePath),
        headDiagnostics: head.diagnostics.filter((item) => item.path === filePath),
      })),
      baseDiagnostics: base.diagnostics,
      headDiagnostics: head.diagnostics,
      inheritedDiagnosticLedger: authServerInheritedDiagnosticLedger,
      diagnosticDispositionViolations,
    };
  } finally {
    rmSync(baseRoot, { force: true, recursive: true });
  }
}

export function readDiagnosticDispositionViolations(
  candidate: readonly TypeScriptDiagnostic[],
  ledger: readonly Partial<InheritedDiagnosticDisposition>[],
): readonly string[] {
  const metadataViolations = ledger.flatMap(readDispositionMetadataViolations);
  const expected = ledger.flatMap(toCompleteDiagnostic);
  const missing = readDiagnosticRegressions(candidate, expected).map(
    (diagnostic) => `missing diagnostic:${diagnosticKey(diagnostic)}`,
  );
  const unexpected = readDiagnosticRegressions(expected, candidate).map(
    (diagnostic) => `unexpected diagnostic:${diagnosticKey(diagnostic)}`,
  );
  return [...metadataViolations, ...missing, ...unexpected];
}

export function readDiagnosticRegressions(
  base: readonly TypeScriptDiagnostic[],
  head: readonly TypeScriptDiagnostic[],
): readonly TypeScriptDiagnostic[] {
  const capacity = new Map<string, number>();
  for (const diagnostic of base) {
    const key = diagnosticKey(diagnostic);
    capacity.set(key, (capacity.get(key) ?? 0) + 1);
  }
  return head.filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    const remaining = capacity.get(key) ?? 0;
    if (remaining === 0) return true;
    capacity.set(key, remaining - 1);
    return false;
  });
}

function requireExactBase(): void {
  const resolved = execFileSync('git', ['rev-parse', exactBaseSha], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (resolved !== exactBaseSha) throw new Error(`Unexpected diagnostics base: ${resolved}`);
}

function readTouchedPaths(): readonly string[] {
  const tracked = lines(
    execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACMRD', exactBaseSha, '--', 'packages/tests'],
      { cwd: repoRoot, encoding: 'utf8' },
    ),
  );
  const untracked = lines(
    execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'packages/tests'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
  );
  return [...new Set([...tracked, ...untracked])].filter(isTypeScriptPath).sort();
}

function createBaseWorktree(): string {
  const baseRoot = mkdtempSync(path.join(tmpdir(), 'auth-tsc-base-'));
  const archive = execFileSync('git', ['archive', exactBaseSha], {
    cwd: repoRoot,
    maxBuffer: 100 * 1024 * 1024,
  });
  const extraction = spawnSync('tar', ['-x', '-C', baseRoot], { input: archive });
  if (extraction.status !== 0) {
    rmSync(baseRoot, { force: true, recursive: true });
    throw new Error(`Could not extract diagnostics base: ${String(extraction.stderr)}`);
  }
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(baseRoot, 'node_modules'), 'dir');
  return baseRoot;
}

function runCompiler(root: string, touchedPaths: readonly string[]): CompilerResult {
  const executable = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
  const result = spawnSync(
    executable,
    ['-p', 'packages/tests/tsconfig.json', '--noEmit', '--pretty', 'false'],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {
    status: result.status ?? -1,
    diagnostics: parseDiagnostics(output, root, new Set(touchedPaths)),
  };
}

function parseDiagnostics(
  output: string,
  root: string,
  touchedPaths: ReadonlySet<string>,
): readonly TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];
  for (const line of lines(output)) {
    const match = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.+)$/.exec(line);
    if (!match) continue;
    const filePath = relativeTo(root, match[1]);
    if (!touchedPaths.has(filePath)) continue;
    const location = readDiagnosticLocation(root, filePath, {
      column: Number(match[3]),
      line: Number(match[2]),
    });
    diagnostics.push({
      ...location,
      code: Number(match[4]),
      message: normalizeMessage(match[5], root),
      path: filePath,
    });
  }
  return diagnostics.sort((left, right) => diagnosticKey(left).localeCompare(diagnosticKey(right)));
}

function readDiagnosticLocation(
  root: string,
  filePath: string,
  point: DiagnosticPoint,
): DiagnosticLocation {
  const absolutePath = path.join(root, filePath);
  if (!existsSync(absolutePath)) return toDiagnosticLocation('<missing>', point, 1);
  try {
    const source = readFileSync(absolutePath, 'utf8');
    const program = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', ...(filePath.endsWith('x') ? (['jsx'] as const) : [])],
    }).program;
    const owner = smallestOwner(program as unknown as AstNode, point.line);
    return toDiagnosticLocation(owner?.name ?? '<module>', point, owner?.startLine ?? 1);
  } catch {
    return toDiagnosticLocation('<unparsed>', point, 1);
  }
}

function toDiagnosticLocation(
  owner: string,
  point: DiagnosticPoint,
  ownerStartLine: number,
): DiagnosticLocation {
  return {
    column: point.column,
    owner,
    ownerRelativeLine: point.line - ownerStartLine,
  };
}

function readDispositionMetadataViolations(
  entry: Partial<InheritedDiagnosticDisposition>,
  index: number,
): readonly string[] {
  const violations: string[] = [];
  if (typeof entry.column !== 'number' || !Number.isInteger(entry.column) || entry.column < 1) {
    violations.push(`ledger[${index}]:column`);
  }
  if (!Number.isInteger(entry.code)) violations.push(`ledger[${index}]:code`);
  if (
    typeof entry.ownerRelativeLine !== 'number' ||
    !Number.isInteger(entry.ownerRelativeLine) ||
    entry.ownerRelativeLine < 0
  ) {
    violations.push(`ledger[${index}]:ownerRelativeLine`);
  }
  if (entry.disposition !== 'accepted inherited debt') {
    violations.push(`ledger[${index}]:disposition`);
  }
  for (const field of [
    'message',
    'owner',
    'path',
    'responsibility',
    'rationale',
    'removalCondition',
  ] as const) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      violations.push(`ledger[${index}]:${field}`);
    }
  }
  return violations;
}

function toCompleteDiagnostic(
  entry: Partial<InheritedDiagnosticDisposition>,
): readonly TypeScriptDiagnostic[] {
  if (
    typeof entry.column !== 'number' ||
    typeof entry.code !== 'number' ||
    typeof entry.message !== 'string' ||
    typeof entry.owner !== 'string' ||
    typeof entry.ownerRelativeLine !== 'number' ||
    typeof entry.path !== 'string'
  ) {
    return [];
  }
  return [entry as TypeScriptDiagnostic];
}

function smallestOwner(root: AstNode, line: number): DiagnosticOwner | undefined {
  let selected: DiagnosticOwner | undefined;
  visit(root, undefined, (node, parent) => {
    if (!containsLine(node, line)) return;
    const name = ownerName(node, parent);
    if (!name) return;
    const span = node.loc!.end.line - node.loc!.start.line;
    if (!selected || span < selected.span) {
      selected = { name, span, startLine: node.loc!.start.line };
    }
  });
  return selected;
}

function visit(
  value: unknown,
  parent: AstNode | undefined,
  action: (node: AstNode, parent: AstNode | undefined) => void,
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, parent, action);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') action(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child, node, action);
  }
}

function ownerName(node: AstNode, parent: AstNode | undefined): string | undefined {
  const identifier = node.id as { readonly name?: unknown } | undefined;
  if (node.type === 'FunctionDeclaration' && typeof identifier?.name === 'string') {
    return identifier.name;
  }
  if (['ClassMethod', 'ClassPrivateMethod'].includes(node.type)) return nameOf(node.key);
  if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)) return undefined;
  if (parent?.type === 'CallExpression') {
    const title = ((parent.arguments as readonly AstNode[]) ?? [])[0];
    const callee = callName(parent.callee as AstNode);
    if (title?.type === 'StringLiteral' && ['it', 'test'].includes(callee)) {
      return `${callee}:${String(title.value)}`;
    }
  }
  return parent?.type === 'VariableDeclarator' ? nameOf(parent.id) : undefined;
}

function callName(node: AstNode | undefined): string {
  if (!node) return '';
  if (node.type === 'Identifier') return nameOf(node);
  if (node.type !== 'MemberExpression') return '';
  return nameOf(node.object) || callName(node.object as AstNode);
}

function containsLine(node: AstNode, line: number): boolean {
  return Boolean(node.loc && node.loc.start.line <= line && node.loc.end.line >= line);
}

function diagnosticKey(diagnostic: TypeScriptDiagnostic): string {
  return JSON.stringify([
    diagnostic.path,
    diagnostic.code,
    diagnostic.message,
    diagnostic.owner,
    diagnostic.ownerRelativeLine,
    diagnostic.column,
  ]);
}

function normalizeMessage(message: string, root: string): string {
  return message
    .replaceAll(root, '<repo>')
    .replaceAll(repoRoot, '<repo>')
    .replace(/'[^']*\/scripts\//gu, "'<repo>/scripts/")
    .replace(/\s+/gu, ' ')
    .trim();
}

function relativeTo(root: string, filePath: string): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  return path.relative(root, absolutePath).split(path.sep).join(path.posix.sep);
}

function lines(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function nameOf(value: unknown): string {
  const node = value as { readonly name?: unknown; readonly value?: unknown } | undefined;
  if (typeof node?.name === 'string') return node.name;
  return typeof node?.value === 'string' ? node.value : '';
}

function isTypeScriptPath(filePath: string): boolean {
  return sourceExtensions.some((extension) => filePath.endsWith(extension));
}
