import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mergeBase = '0a52ecee39181c7784fa6b777270f8a59bc33c00';
const manifestPath = 'plans/repo-style-lineages/api-v1-group-state-route-structure.json';
const provenancePath = 'plans/repo-style-lineages/api-v1-group-state-route-structure-provenance.md';
const routeSource = 'apps/api-v1/src/routes/group-state-routes.ts';
const errorSource = 'apps/api-v1/src/routes/group-state-route-errors.ts';
const requestTarget = 'apps/api-v1/src/group-state/read-group-state-route-request.ts';
const presenceTarget = 'apps/api-v1/src/group-state/register-group-presence-routes.ts';
const errorTarget = 'apps/api-v1/src/group-state/group-state-route-errors.ts';
const lineages = [
  [routeSource, 'aced85e681666edde414be27b68278ddff53fc42', [requestTarget, presenceTarget]],
  [errorSource, 'cd58fb90d1836c33be35f417a6a04376150a2327', [errorTarget]],
] as const;
const regions = [
  [
    'request-reader',
    routeSource,
    1036,
    1051,
    'async function readRequestWithRequestId',
    'ca43baaef3247486087c8b5adbaa0dcb8a6fc4057ca269cb201bf7c4bce33ef0',
    requestTarget,
    3,
    21,
    'export async function readGroupStateRouteRequest',
    'b8c1b8bc3e971c4076bd45908b3434373513c152a574109d70caa8b8cdb08a27',
    [5],
  ],
  [
    'presence-connect',
    routeSource,
    780,
    819,
    'async (c) => {',
    '03bc151a40f78c12c06683afb3a02279412fb4524318fb84848ca19b5913a6ca',
    presenceTarget,
    47,
    81,
    "operation: 'connect-group-presence'",
    '886f24cee805a803567718d5437a84e3956d2d9515aed058d0b10186635b3841',
    [47],
  ],
  [
    'presence-heartbeat',
    routeSource,
    824,
    865,
    'async (c) => {',
    'cc2809a75ea86071741752fdec940b2b269fe092049e137687ccb3ea4ffa93fb',
    presenceTarget,
    92,
    126,
    "operation: 'heartbeat-group-presence'",
    '6e7b6bee51ea4b89f79d9d6257042c7b596ab8daebd5b969a9541a19155fc535',
    [92],
  ],
  [
    'presence-disconnect',
    routeSource,
    870,
    911,
    'async (c) => {',
    '7561ad8b51755ed2931832499fbac340612c420fbc8abe764aff4948dc1134db',
    presenceTarget,
    137,
    171,
    "operation: 'disconnect-group-presence'",
    '814fd81590f77da29a642920cbf984d18cbb7675496a10549f5d037728c76593',
    [137],
  ],
  [
    'route-errors',
    errorSource,
    1,
    136,
    'export function toGroupStateErrorResponse',
    'bc6cc7104612ad032674e896d6d3d987cbe4aca2c25625f98ee9b0de7b1c67ef',
    errorTarget,
    1,
    136,
    'export function toGroupStateErrorResponse',
    'bc6cc7104612ad032674e896d6d3d987cbe4aca2c25625f98ee9b0de7b1c67ef',
    [35, 37, 63, 81, 106, 134],
  ],
] as const satisfies readonly Region[];
const compatibilityContents = new Map<string, string>([
  [
    routeSource,
    "export { registerGroupStateRoutes as init } from '../group-state/register-group-state-routes.ts';\n" +
      "export { toGroupAppInboxError } from '../group-state/group-state-route-errors.ts';\n" +
      'export type {\n  GroupStateRouteAuthSession,\n  GroupStateRouteDependencies,\n' +
      "  GroupStateRouteService,\n  ProcessGroupAppInbox,\n} from '../group-state/group-state-route-contracts.ts';\n",
  ],
  [
    errorSource,
    'export {\n  toGroupAppInboxError,\n  toGroupStateErrorResponse,\n' +
      "} from '../group-state/group-state-route-errors.ts';\n",
  ],
]);

describe('API-v1 group-state route structural-lineage provenance', () => {
  it('keeps the exact authorized merge-base lineage inventory and source blobs', () => {
    expect(readManifest()).toEqual({
      version: 1,
      lineages: lineages.map(([sourcePath, blob, targets]) => ({
        mergeBase,
        source: { path: sourcePath, blob },
        targets,
      })),
    });
    for (const [sourcePath, blob] of lineages) expect(readBlob(sourcePath)).toBe(blob);
  });

  it('binds inherited regions, accepted findings, and compatibility paths to content', () => {
    validateContentBoundEvidence(regions, compatibilityContents);
    const provenance = read(provenancePath);
    expect(provenance).toContain(`Merge base: \`${mergeBase}\``);
    for (const [id, , , , , sourceHash, , , , , targetHash, findingLines] of regions) {
      expect(provenance).toContain(id);
      expect(provenance).toContain(sourceHash);
      expect(provenance).toContain(targetHash);
      for (const line of findingLines) expect(provenance).toContain(`line ${line}`);
    }
  });

  it('fails closed for changed targets, regions, semantic additions, compatibility, and ordering', () => {
    const changedPath = copyRegions();
    changedPath[0][6] = 'apps/api-v1/src/group-state/to-group-state-command.ts';
    const changedHash = copyRegions();
    changedHash[0][10] = '0'.repeat(64);
    const semanticAddition = new Map([
      [
        presenceTarget,
        read(presenceTarget).replace(
          "operation: 'connect-group-presence',",
          "operation: 'connect-group-presence',\n            semanticAddition: true,",
        ),
      ],
    ]);
    const changedCompatibility = new Map(compatibilityContents).set(
      errorSource,
      'export const changedCompatibility = true;\n',
    );
    const reordered = structuredClone(readManifest()) as {
      readonly version: 1;
      lineages: unknown[];
    };
    reordered.lineages.reverse();

    expect(() => validateContentBoundEvidence(changedPath, compatibilityContents)).toThrow(
      'target path',
    );
    expect(() => validateContentBoundEvidence(changedHash, compatibilityContents)).toThrow(
      'target hash',
    );
    expect(() =>
      validateContentBoundEvidence(regions, compatibilityContents, semanticAddition),
    ).toThrow('target hash');
    expect(() => validateContentBoundEvidence(regions, changedCompatibility)).toThrow(
      'compatibility content',
    );
    expect(() => validateManifest(reordered)).toThrow('lineage order');
  });

  it('recognizes only executable import, export, dynamic import, and require specifiers', () => {
    const routesPath = '../routes/group-state-routes.ts';
    const errorsPath = '../routes/group-state-route-errors.ts';
    const fixture = [
      `import value ${'from'} '${routesPath}';`,
      `export { value } ${'from'} '${errorsPath}';`,
      `const dynamicValue = import('${routesPath}');`,
      `const requiredValue = require('${errorsPath}');`,
      `const prose = '${routesPath}';`,
      `// import '${errorsPath}';`,
    ].join('\n');

    expect(moduleSpecifiers(fixture)).toEqual([routesPath, errorsPath, routesPath, errorsPath]);
    expect(activeCompatibilitySpecifiers()).toEqual([]);
  });
});

function validateContentBoundEvidence(
  evidence: readonly Region[],
  compatibility: ReadonlyMap<string, string>,
  currentSources = new Map<string, string>(),
): void {
  const targetPaths = [...new Set(evidence.map(([, , , , , , target]) => target))];
  if (targetPaths.join('\n') !== lineages.flatMap((row) => row[2]).join('\n')) {
    throw new Error('target path');
  }
  for (const [
    id,
    sourcePath,
    sourceStart,
    sourceEnd,
    sourceMarker,
    sourceHash,
    targetPath,
    targetStart,
    targetEnd,
    targetMarker,
    targetHash,
    findingLines,
  ] of evidence) {
    const source = readBase(sourcePath);
    const target = currentSources.get(targetPath) ?? read(targetPath);
    if (!region(source, sourceStart, sourceEnd).includes(sourceMarker))
      throw new Error(`source marker ${id}`);
    if (!region(target, targetStart, targetEnd).includes(targetMarker))
      throw new Error(`target marker ${id}`);
    if (hash(source, sourceStart, sourceEnd) !== sourceHash) throw new Error(`source hash ${id}`);
    if (hash(target, targetStart, targetEnd) !== targetHash) throw new Error(`target hash ${id}`);
    if (findingLines.some((line) => line < targetStart || line > targetEnd))
      throw new Error(`finding line ${id}`);
  }
  for (const [filePath, content] of compatibility) {
    if (read(filePath) !== content) throw new Error(`compatibility content ${filePath}`);
  }
}

function validateManifest(value: unknown): void {
  const actual = value as { version?: unknown; lineages?: unknown };
  if (JSON.stringify(actual) !== JSON.stringify(readManifest())) throw new Error('lineage order');
}

function readManifest(): { readonly version: 1; readonly lineages: readonly unknown[] } {
  return JSON.parse(read(manifestPath)) as {
    readonly version: 1;
    readonly lineages: readonly unknown[];
  };
}

function moduleSpecifiers(source: string, filePath = 'fixture.ts'): readonly string[] {
  const program = parse(source, {
    sourceType: 'unambiguous',
    createImportExpressions: true,
    sourceFilename: filePath,
    plugins: filePath.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  }).program;
  const result: string[] = [];
  visit(program, (node) => {
    const sourceValue = stringValue(node.source);
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(
        String(node.type),
      ) &&
      sourceValue
    )
      result.push(sourceValue);
    if (node.type === 'ImportExpression' && sourceValue) result.push(sourceValue);
    if (
      node.type === 'CallExpression' &&
      identifier(node.callee, 'require') &&
      Array.isArray(node.arguments)
    ) {
      const value = stringValue(node.arguments[0]);
      if (value) result.push(value);
    }
  });
  return result;
}

function activeCompatibilitySpecifiers(): readonly string[] {
  const suffixes = ['routes/group-state-routes.ts', 'routes/group-state-route-errors.ts'];
  return sourcePaths(['apps', 'packages']).flatMap((filePath) =>
    moduleSpecifiers(read(filePath), filePath)
      .filter((specifier) => suffixes.some((suffix) => specifier.endsWith(suffix)))
      .map((specifier) => `${filePath}: ${specifier}`),
  );
}

function visit(value: unknown, onNode: (node: Record<string, unknown>) => void): void {
  if (!record(value)) return;
  onNode(value);
  for (const [key, child] of Object.entries(value)) {
    if (!['loc', 'start', 'end', 'tokens', 'comments', 'errors'].includes(key)) {
      Array.isArray(child) ? child.forEach((item) => visit(item, onNode)) : visit(child, onNode);
    }
  }
}

function sourcePaths(roots: readonly string[]): readonly string[] {
  return roots.flatMap((root) =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const filePath = path.posix.join(root, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourcePaths([filePath]);
      return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [filePath] : [];
    }),
  );
}

function read(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}
function readBase(filePath: string): string {
  return execFileSync('git', ['show', `${mergeBase}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}
function readBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${mergeBase}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}
function region(source: string, start: number, end: number): string {
  return `${source
    .split('\n')
    .slice(start - 1, end)
    .join('\n')}\n`;
}
function hash(source: string, start: number, end: number): string {
  return createHash('sha256')
    .update(region(source, start, end))
    .digest('hex');
}
function stringValue(value: unknown): string | undefined {
  return record(value) && value.type === 'StringLiteral' && typeof value.value === 'string'
    ? value.value
    : undefined;
}
function identifier(value: unknown, name: string): boolean {
  return record(value) && value.type === 'Identifier' && value.name === name;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function copyRegions(): MutableRegion[] {
  return structuredClone(regions) as unknown as MutableRegion[];
}

type Region = readonly [
  string,
  string,
  number,
  number,
  string,
  string,
  string,
  number,
  number,
  string,
  string,
  readonly number[],
];
type MutableRegion = [
  string,
  string,
  number,
  number,
  string,
  string,
  string,
  number,
  number,
  string,
  string,
  number[],
];
