import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse, type ParserPlugin } from '@babel/parser';
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
const evidence = parseEvidence(`
request-reader|route|1036|1051|async function readRequestWithRequestId|ca43baaef3247486087c8b5adbaa0dcb8a6fc4057ca269cb201bf7c4bce33ef0|request|3|21|export async function readGroupStateRouteRequest|b8c1b8bc3e971c4076bd45908b3434373513c152a574109d70caa8b8cdb08a27|5|1-2|boundary.unknown at line 5|inherited and accepted for PR A; Task 7 owns any alignment
presence-connect|route|780|819|async (c) => {|03bc151a40f78c12c06683afb3a02279412fb4524318fb84848ca19b5913a6ca|presence|47|81|operation: 'connect-group-presence'|886f24cee805a803567718d5437a84e3956d2d9515aed058d0b10186635b3841|47|1-46, 82-91, 127-136, 172-173|route.handler-length at line 47|inherited and accepted for PR A; Task 7 owns any alignment
presence-heartbeat|route|824|865|async (c) => {|cc2809a75ea86071741752fdec940b2b269fe092049e137687ccb3ea4ffa93fb|presence|92|126|operation: 'heartbeat-group-presence'|6e7b6bee51ea4b89f79d9d6257042c7b596ab8daebd5b969a9541a19155fc535|92|1-46, 82-91, 127-136, 172-173|route.handler-length at line 92|inherited and accepted for PR A; Task 7 owns any alignment
presence-disconnect|route|870|911|async (c) => {|7561ad8b51755ed2931832499fbac340612c420fbc8abe764aff4948dc1134db|presence|137|171|operation: 'disconnect-group-presence'|814fd81590f77da29a642920cbf984d18cbb7675496a10549f5d037728c76593|137|1-46, 82-91, 127-136, 172-173|route.handler-length at line 137|inherited and accepted for PR A; Task 7 owns any alignment
route-errors|errors|1|136|export function toGroupStateErrorResponse|bc6cc7104612ad032674e896d6d3d987cbe4aca2c25625f98ee9b0de7b1c67ef|error|1|136|export function toGroupStateErrorResponse|bc6cc7104612ad032674e896d6d3d987cbe4aca2c25625f98ee9b0de7b1c67ef|35,37,63,81,106,134|none|boundary.unknown at lines 35, 37, 63, 81, 106, 134|inherited and accepted for PR A; Task 7 owns any alignment`);
const compatibilityContents = new Map<string, string>([
  [
    routeSource,
    "export { registerGroupStateRoutes as init } from '../group-state/register-group-state-routes.ts';\nexport { toGroupAppInboxError } from '../group-state/group-state-route-errors.ts';\nexport type {\n  GroupStateRouteAuthSession,\n  GroupStateRouteDependencies,\n  GroupStateRouteService,\n  ProcessGroupAppInbox,\n} from '../group-state/group-state-route-contracts.ts';\n",
  ],
  [
    errorSource,
    "export {\n  toGroupAppInboxError,\n  toGroupStateErrorResponse,\n} from '../group-state/group-state-route-errors.ts';\n",
  ],
]);
const provenanceCompatibility = [
  [routeSource, 'a89164e9e36e885dd330b319e589057bd88dd6d2fe90eb63abb626b4f6971665'],
  [errorSource, '2d2d138be4decdc938c61641353289f61fd590fd363927d7187ee07779e89869'],
] as const;

describe('API-v1 group-state route structural-lineage provenance', () => {
  it('keeps the exact authorized merge-base lineage inventory and source blobs', () => {
    expect(readManifest()).toEqual({
      version: 1,
      lineages: lineages.map(([path, blob, targets]) => ({
        mergeBase,
        source: { path, blob },
        targets,
      })),
    });
    for (const [filePath, blob] of lineages) expect(readBlob(filePath)).toBe(blob);
  });

  it('binds exact inherited regions, findings, compatibility contents, and parsed provenance', () => {
    validateContentBoundEvidence(evidence, compatibilityContents);
    validateProvenance(read(provenancePath));
  });

  // prettier-ignore
  it('fails closed for changed content, ordered prose inventory, and finding ownership', () => {
    const changedPath = copyRegions(); changedPath[0][6] = 'apps/api-v1/src/group-state/to-group-state-command.ts';
    const changedHash = copyRegions(); changedHash[0][10] = '0'.repeat(64);
    const semanticAddition = new Map([[presenceTarget, read(presenceTarget).replace("operation: 'connect-group-presence',", "operation: 'connect-group-presence',\n            semanticAddition: true,")]]);
    const changedCompatibility = new Map(compatibilityContents).set(errorSource, 'export const changedCompatibility = true;\n');
    expect(() => validateContentBoundEvidence(changedPath, compatibilityContents)).toThrow('target path');
    expect(() => validateContentBoundEvidence(changedHash, compatibilityContents)).toThrow('target hash');
    expect(() => validateContentBoundEvidence(evidence, compatibilityContents, semanticAddition)).toThrow('target hash');
    expect(() => validateContentBoundEvidence(evidence, changedCompatibility)).toThrow('compatibility content');
    const current = read(provenancePath); const swap = '### Target: `temporary`';
    const fixtures = [current.replace(requestTarget, 'apps/api-v1/src/group-state/to-group-state-command.ts'), current.replace(`### Target: \`${requestTarget}\``, swap).replace(`### Target: \`${presenceTarget}\``, `### Target: \`${requestTarget}\``).replace(swap, `### Target: \`${presenceTarget}\``), current.replace(/^\- Path: `apps\/api-v1\/src\/routes\/group-state-route-errors\.ts`; SHA-256: `[^`]+`\n?/m, ''), current.replace('boundary.unknown at line 5', 'route.handler-length at line 5')];
    for (const fixture of fixtures) expect(() => validateProvenance(fixture)).toThrow('provenance inventory');
    const reordered = structuredClone(readManifest()) as unknown as { lineages: unknown[] }; reordered.lineages.reverse();
    expect(() => validateManifest(reordered)).toThrow('lineage order');
  });

  // prettier-ignore
  it('recognizes executable compatibility specifiers in TypeScript and JavaScript only', () => {
    const entries = ['fixture.ts', 'fixture.js'].flatMap((filePath) => { const routes = '../routes/group-state-routes'; const errors = '../routes/group-state-route-errors.ts'; return [[filePath, [`import value from '${routes}';`, `export { value } from '${errors}';`, `const dynamicValue = import('${routes}.ts');`, `const requiredValue = require('${errors.slice(0, -3)}');`, `const prose = '${routes}';`, `const markdown = '[legacy](${errors})';`, `// import '${errors}';`].join('\n')]] as const; });
    expect(activeCompatibilitySpecifiers(entries)).toEqual(['fixture.ts: ../routes/group-state-routes', 'fixture.ts: ../routes/group-state-route-errors.ts', 'fixture.ts: ../routes/group-state-routes.ts', 'fixture.ts: ../routes/group-state-route-errors', 'fixture.js: ../routes/group-state-routes', 'fixture.js: ../routes/group-state-route-errors.ts', 'fixture.js: ../routes/group-state-routes.ts', 'fixture.js: ../routes/group-state-route-errors']);
    expect(activeCompatibilitySpecifiers()).toEqual([]);
    expect(() => moduleSpecifiers('const x = 1;', 'fixture.jsx')).toThrow('unsupported source extension');
  });
});

function validateContentBoundEvidence(
  evidence: readonly Region[],
  compatibility: ReadonlyMap<string, string>,
  currentSources = new Map<string, string>(),
): void {
  if (
    [...new Set(evidence.map(([, , , , , , target]) => target))].join('\n') !==
    lineages.flatMap((row) => row[2]).join('\n')
  )
    throw new Error('target path');
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
  for (const [filePath, content] of compatibility)
    if (read(filePath) !== content) throw new Error(`compatibility content ${filePath}`);
}

function parseProvenance(text: string): ParsedProvenance {
  const inventory = `${text}\n## End\n`;
  const sourceMatches = [
    ...inventory.matchAll(
      /^## Source: `([^`]+)`\n\nSource blob: `([a-f0-9]+)`\n([\s\S]*?)(?=^## )/gm,
    ),
  ];
  const targets = (body: string) => [
    ...`${body}## End\n`.matchAll(/^### Target: `([^`]+)`\n([\s\S]*?)(?=^### |^## )/gm),
  ];
  const sources = sourceMatches.map(
    ([, sourcePath, blob, body]) =>
      [sourcePath, blob, targets(body).map(([, targetPath]) => targetPath)] as const,
  );
  const regions = sourceMatches.flatMap(([, sourcePath, , body]) =>
    targets(body).flatMap(([, targetPath, targetBody]) =>
      [
        ...targetBody.matchAll(
          /^\- Region: `([^`]+)`; predecessor: `([^`]+)` SHA-256: `([^`]+)`; target: `([^`]+)` SHA-256: `([^`]+)`; excluded: `([^`]+)`; finding: `([^`]+)`; disposition: `([^`]+)`\.$/gm,
        ),
      ].map(
        ([, id, sourceSpan, sourceHash, targetSpan, targetHash, excluded, finding, disposition]) =>
          [
            sourcePath,
            targetPath,
            id,
            sourceSpan,
            sourceHash,
            targetSpan,
            targetHash,
            excluded,
            finding,
            disposition,
          ] as const,
      ),
    ),
  );
  const compatibility = [...text.matchAll(/^\- Path: `([^`]+)`; SHA-256: `([^`]+)`$/gm)].map(
    ([, filePath, contentHash]) => [filePath, contentHash] as const,
  );
  const base = text.match(/^Merge base: `([a-f0-9]+)`$/m)?.[1];
  if (
    !base ||
    sourceMatches.length !== sources.length ||
    text.includes('## Compatibility files') === false
  )
    throw new Error('invalid provenance inventory');
  return { mergeBase: base, sources, regions, compatibility };
}

function validateProvenance(text: string): void {
  const actual = parseProvenance(text);
  const expected = expectedProvenance();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('provenance inventory');
}

function expectedProvenance(): ParsedProvenance {
  return {
    mergeBase,
    sources: lineages.map(([source, blob, targets]) => [source, blob, targets]),
    regions: evidence.map(
      ([
        id,
        source,
        start,
        end,
        ,
        sourceHash,
        target,
        targetStart,
        targetEnd,
        ,
        targetHash,
        ,
        excluded,
        finding,
        disposition,
      ]) => [
        source,
        target,
        id,
        `${start}-${end}`,
        sourceHash,
        `${targetStart}-${targetEnd}`,
        targetHash,
        excluded,
        finding,
        disposition,
      ],
    ),
    compatibility: provenanceCompatibility,
  };
}

function parseEvidence(table: string): Region[] {
  return table
    .trim()
    .split('\n')
    .map((row) => {
      const [
        id,
        sourceName,
        start,
        end,
        sourceMarker,
        sourceHash,
        targetName,
        targetStart,
        targetEnd,
        targetMarker,
        targetHash,
        findingLines,
        excluded,
        finding,
        disposition,
      ] = row.split('|');
      return [
        id,
        pathFor(sourceName),
        Number(start),
        Number(end),
        sourceMarker,
        sourceHash,
        pathFor(targetName),
        Number(targetStart),
        Number(targetEnd),
        targetMarker,
        targetHash,
        findingLines.split(',').map(Number),
        excluded,
        finding,
        disposition,
      ] as Region;
    });
}
function pathFor(name: string): string {
  const paths = {
    route: routeSource,
    errors: errorSource,
    request: requestTarget,
    presence: presenceTarget,
    error: errorTarget,
  };
  const value = paths[name as keyof typeof paths];
  if (!value) throw new Error(`unknown path: ${name}`);
  return value;
}

function validateManifest(value: unknown): void {
  if (JSON.stringify(value) !== JSON.stringify(readManifest())) throw new Error('lineage order');
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
    plugins: parserPlugins(filePath),
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
function parserPlugins(filePath: string): ParserPlugin[] {
  if (/\.tsx$/.test(filePath)) return ['typescript', 'jsx'];
  if (/\.(?:ts|mts|cts)$/.test(filePath)) return ['typescript'];
  if (/\.(?:js|mjs|cjs)$/.test(filePath)) return [];
  throw new Error(`unsupported source extension: ${filePath}`);
}
function activeCompatibilitySpecifiers(
  entries = sourcePaths(['apps', 'packages']).map(
    (filePath) => [filePath, read(filePath)] as const,
  ),
): readonly string[] {
  return entries.flatMap(([filePath, source]) =>
    moduleSpecifiers(source, filePath)
      .filter(isCompatibilitySpecifier)
      .map((specifier) => `${filePath}: ${specifier}`),
  );
}
function isCompatibilitySpecifier(specifier: string): boolean {
  return /(?:^|\/)routes\/group-state-(?:routes|route-errors)(?:\.ts)?$/.test(specifier);
}
function visit(value: unknown, onNode: (node: Record<string, unknown>) => void): void {
  if (!record(value)) return;
  onNode(value);
  for (const [key, child] of Object.entries(value))
    if (!['loc', 'start', 'end', 'tokens', 'comments', 'errors'].includes(key))
      Array.isArray(child) ? child.forEach((item) => visit(item, onNode)) : visit(child, onNode);
}
function sourcePaths(roots: readonly string[]): readonly string[] {
  return roots.flatMap((root) =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const filePath = path.posix.join(root, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourcePaths([filePath]);
      return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [filePath] : [];
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
  return structuredClone(evidence) as unknown as MutableRegion[];
}

// prettier-ignore
type ParsedProvenance = { mergeBase: string; sources: readonly (readonly [string, string, readonly string[]])[]; regions: readonly (readonly string[])[]; compatibility: readonly (readonly [string, string])[] };
// prettier-ignore
type Region = readonly [string, string, number, number, string, string, string, number, number, string, string, readonly number[], string, string, string];
// prettier-ignore
type MutableRegion = [string, string, number, number, string, string, string, number, number, string, string, number[], string, string, string];
