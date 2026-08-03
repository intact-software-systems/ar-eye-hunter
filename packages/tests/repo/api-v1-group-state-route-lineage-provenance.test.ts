import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse, type ParserPlugin } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mergeBase = '0a52ecee39181c7784fa6b777270f8a59bc33c00';
const lineageArtifactPath = 'plans/repo-style-lineages/api-v1-group-state-route-structure';
const paths = {
  route: 'apps/api-v1/src/routes/group-state-routes.ts',
  errors: 'apps/api-v1/src/routes/group-state-route-errors.ts',
  request: 'apps/api-v1/src/group-state/read-group-state-route-request.ts',
  presence: 'apps/api-v1/src/group-state/register-group-presence-routes.ts',
  error: 'apps/api-v1/src/group-state/group-state-route-errors.ts',
} as const;
const hashes = [
  'ca43baaef3247486087c8b5adbaa0dcb8a6fc4057ca269cb201bf7c4bce33ef0',
  'b8c1b8bc3e971c4076bd45908b3434373513c152a574109d70caa8b8cdb08a27',
  '03bc151a40f78c12c06683afb3a02279412fb4524318fb84848ca19b5913a6ca',
  '886f24cee805a803567718d5437a84e3956d2d9515aed058d0b10186635b3841',
  'cc2809a75ea86071741752fdec940b2b269fe092049e137687ccb3ea4ffa93fb',
  '6e7b6bee51ea4b89f79d9d6257042c7b596ab8daebd5b969a9541a19155fc535',
  '7561ad8b51755ed2931832499fbac340612c420fbc8abe764aff4948dc1134db',
  '814fd81590f77da29a642920cbf984d18cbb7675496a10549f5d037728c76593',
  'bc6cc7104612ad032674e896d6d3d987cbe4aca2c25625f98ee9b0de7b1c67ef',
] as const;
const exclusions = {
  request: '1-2',
  presence: '1-46, 82-91, 127-136, 172-173',
  error: 'none',
} as const;
const lineages = [
  [paths.route, 'aced85e681666edde414be27b68278ddff53fc42', [paths.request, paths.presence]],
  [paths.errors, 'cd58fb90d1836c33be35f417a6a04376150a2327', [paths.error]],
] as const;
const evidence = parseEvidence(`
request-reader|route|1036|1051|0|request|3|21|1|5|request|boundary
presence-connect|route|780|819|2|presence|47|81|3|47|presence|handler
presence-heartbeat|route|824|865|4|presence|92|126|5|92|presence|handler
presence-disconnect|route|870|911|6|presence|137|171|7|137|presence|handler
route-errors|errors|1|136|8|error|1|136|8|35,37,63,81,106,134|error|boundary`);
const compatibilityContents = new Map<string, string>([
  [
    paths.route,
    "export { registerGroupStateRoutes as init } from '../group-state/" +
      "register-group-state-routes.ts';\n" +
      "export { toGroupAppInboxError } from '../group-state/group-state-route-errors.ts';\n" +
      'export type {\n  GroupStateRouteAuthSession,\n  GroupStateRouteDependencies,\n' +
      '  GroupStateRouteService,\n  ProcessGroupAppInbox,\n} ' +
      "from '../group-state/group-state-route-contracts.ts';\n",
  ],
  [
    paths.errors,
    'export {\n  toGroupAppInboxError,\n  toGroupStateErrorResponse,\n' +
      "} from '../group-state/group-state-route-errors.ts';\n",
  ],
]);
describe('API-v1 group-state route structural-lineage provenance', () => {
  it('keeps the exact authorized merge-base lineage inventory and source blobs', () => {
    expect(readManifest()).toEqual({
      version: 1,
      lineages: lineages.map(([filePath, blob, targets]) => ({
        mergeBase,
        source: { path: filePath, blob },
        targets,
      })),
    });
    for (const [filePath, blob] of lineages) expect(readBlob(filePath)).toBe(blob);
  });
  it('binds exact regions, findings, compatibility contents, and parsed provenance', () => {
    validateContentBoundEvidence(evidence, compatibilityContents);
    validateProvenance(read(`${lineageArtifactPath}-provenance.md`));
  });
  it('fails closed for changed content, ordered prose inventory, and finding ownership', () => {
    const changedPath = structuredClone(evidence);
    changedPath[0].target = paths.error;
    const changedHash = structuredClone(evidence);
    changedHash[0].targetHash = '0'.repeat(64);
    const semanticAddition = new Map([
      [
        paths.presence,
        read(paths.presence).replace(
          "operation: 'connect-group-presence',",
          "operation: 'connect-group-presence',\n            semanticAddition: true,",
        ),
      ],
    ]);
    const changedCompatibility = new Map(compatibilityContents).set(
      paths.errors,
      'export const changedCompatibility = true;\n',
    );
    expect(() => validateContentBoundEvidence(changedPath, compatibilityContents)).toThrow(
      'target path',
    );
    expect(() => validateContentBoundEvidence(changedHash, compatibilityContents)).toThrow(
      'target hash',
    );
    expect(() =>
      validateContentBoundEvidence(evidence, compatibilityContents, semanticAddition),
    ).toThrow('target hash');
    expect(() => validateContentBoundEvidence(evidence, changedCompatibility)).toThrow(
      'compatibility content',
    );
    for (const fixture of provenanceFixtures(read(`${lineageArtifactPath}-provenance.md`))) {
      expect(() => validateProvenance(fixture)).toThrow('provenance inventory');
    }
    const reordered = structuredClone(readManifest()) as unknown as { lineages: unknown[] };
    reordered.lineages.reverse();
    expect(reordered).not.toEqual(readManifest());
  });
});

describe('API-v1 group-state route executable compatibility references', () => {
  it('recognizes executable compatibility specifiers in TypeScript and JavaScript only', () => {
    const entries = ['fixture.ts', 'fixture.js'].map(compatibilityFixture);
    expect(activeCompatibilitySpecifiers(entries)).toEqual(
      ['fixture.ts', 'fixture.js'].flatMap((filePath) =>
        fixtureOperations.map(([, specifier]) => `${filePath}: ${specifier}`),
      ),
    );
    expect(activeCompatibilitySpecifiers()).toEqual([]);
    const importEquals = "import x = require('../routes/group-state-route-errors.ts');";
    expect(moduleSpecifiers(importEquals, 'fixture.cts')).toEqual([legacyErrorsSpecifier]);
    expect(() => moduleSpecifiers('x', 'fixture.jsx')).toThrow('unsupported source extension');
    expect(() => moduleSpecifiers('import(', 'fixture.ts')).toThrow();
  });
});
function validateContentBoundEvidence(
  rows: readonly (typeof evidence)[number][],
  compatibility: ReadonlyMap<string, string>,
  currentSources = new Map<string, string>(),
): void {
  const targets = [...new Set(rows.map((row) => row.target))];
  if (targets.join('\n') !== lineages.flatMap((row) => row[2]).join('\n')) {
    throw new Error('target path');
  }
  for (const row of rows) {
    const source = readBase(row.source);
    const target = currentSources.get(row.target) ?? read(row.target);
    if (hash(source, row.sourceStart, row.sourceEnd) !== row.sourceHash) {
      throw new Error(`source hash ${row.id}`);
    }
    if (hash(target, row.targetStart, row.targetEnd) !== row.targetHash) {
      throw new Error(`target hash ${row.id}`);
    }
    if (row.findingLines.some((line) => line < row.targetStart || line > row.targetEnd)) {
      throw new Error(`finding line ${row.id}`);
    }
  }
  for (const [filePath, content] of compatibility) {
    if (read(filePath) !== content) throw new Error(`compatibility content ${filePath}`);
  }
}
function parseProvenance(text: string) {
  const inventory = `${text}\n## End\n`;
  const sources = [...inventory.matchAll(sourcePattern)].map((match) => {
    const [sourcePath, blob, body] = match.slice(1);
    const targets = [...`${body}## End\n`.matchAll(targetPattern)].map((target) => target[1]);
    const regions = [...`${body}## End\n`.matchAll(targetPattern)].flatMap((target) =>
      [...target[2].matchAll(regionPattern)].map((region) => [
        sourcePath,
        target[1],
        ...region.slice(1),
      ]),
    );
    return { source: [sourcePath, blob, targets], regions };
  });
  const compatibility = [...text.matchAll(compatibilityPattern)].map((match) => match.slice(1));
  const recordedBase = text.match(/^Merge base: `([a-f0-9]+)`$/m)?.[1];
  if (!recordedBase || !text.includes('## Compatibility files')) {
    throw new Error('invalid provenance inventory');
  }
  return {
    mergeBase: recordedBase,
    sources: sources.map(({ source }) => source),
    regions: sources.flatMap(({ regions }) => regions),
    compatibility,
  };
}
function validateProvenance(text: string): void {
  if (JSON.stringify(parseProvenance(text)) !== JSON.stringify(expectedProvenance())) {
    throw new Error('provenance inventory');
  }
}
function expectedProvenance() {
  return {
    mergeBase,
    sources: lineages.map(([source, blob, targets]) => [source, blob, targets]),
    regions: evidence.map((row) => [
      row.source,
      row.target,
      row.id,
      `${row.sourceStart}-${row.sourceEnd}`,
      row.sourceHash,
      `${row.targetStart}-${row.targetEnd}`,
      row.targetHash,
      row.excluded,
      row.finding,
      'inherited and accepted for PR A; Task 7 owns any alignment',
    ]),
    compatibility: [
      [paths.route, 'a89164e9e36e885dd330b319e589057bd88dd6d2fe90eb63abb626b4f6971665'],
      [paths.errors, '2d2d138be4decdc938c61641353289f61fd590fd363927d7187ee07779e89869'],
    ],
  };
}
function parseEvidence(table: string) {
  return table
    .trim()
    .split('\n')
    .map((row) => {
      const [
        id,
        sourceKey,
        sourceStart,
        sourceEnd,
        sourceHash,
        targetKey,
        targetStart,
        targetEnd,
        targetHash,
        lines,
        exclusionKey,
        rule,
      ] = row.split('|');
      const findingLines = lines.split(',').map(Number);
      return {
        id,
        source: paths[sourceKey as keyof typeof paths],
        sourceStart: Number(sourceStart),
        sourceEnd: Number(sourceEnd),
        sourceHash: String(hashes[Number(sourceHash)]),
        target: paths[targetKey as keyof typeof paths],
        targetStart: Number(targetStart),
        targetEnd: Number(targetEnd),
        targetHash: String(hashes[Number(targetHash)]),
        findingLines,
        excluded: exclusions[exclusionKey as keyof typeof exclusions],
        finding: `${rule === 'handler' ? 'route.handler-length' : 'boundary.unknown'} at ${
          findingLines.length === 1 ? 'line' : 'lines'
        } ${findingLines.join(', ')}`,
      };
    });
}
function provenanceFixtures(current: string): readonly string[] {
  const swap = '### Target: `temporary`';
  return [
    current.replace(paths.request, paths.error),
    current
      .replace(`### Target: \`${paths.request}\``, swap)
      .replace(`### Target: \`${paths.presence}\``, `### Target: \`${paths.request}\``)
      .replace(swap, `### Target: \`${paths.presence}\``),
    current.replace(
      /^\- Path: `apps\/api-v1\/src\/routes\/group-state-route-errors\.ts`;.*\n?/m,
      '',
    ),
    current.replace('boundary.unknown at line 5', 'route.handler-length at line 5'),
  ];
}
function compatibilityFixture(filePath: string): readonly [string, string] {
  return [
    filePath,
    [
      ...fixtureOperations.map(([statement]) => statement),
      "const route = 'group-state-routes';",
      'import(`../routes/${route}`);',
      'require(`../routes/${route}.ts`);',
      "const prose = '../routes/group-state-routes';",
      "const markdown = '[legacy](../routes/group-state-route-errors.ts)';",
      "// import '../routes/group-state-route-errors.ts';",
    ].join('\n'),
  ];
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
    const value = stringValue(node.source ?? node.expression);
    if (value && moduleSpecifierNodeTypePattern.test(String(node.type))) result.push(value);
    if (
      node.type === 'CallExpression' &&
      record(node.callee) &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      Array.isArray(node.arguments)
    ) {
      const argument = stringValue(node.arguments[0]);
      if (argument) result.push(argument);
    }
  });
  return result;
}
function activeCompatibilitySpecifiers(
  entries = sourcePaths(['apps', 'packages']).map(
    (filePath) => [filePath, read(filePath)] as const,
  ),
): readonly string[] {
  return entries.flatMap(([filePath, source]) =>
    moduleSpecifiers(source, filePath)
      .filter((specifier) =>
        /(?:^|\/)routes\/group-state-(?:routes|route-errors)(?:\.ts)?$/.test(specifier),
      )
      .map((specifier) => `${filePath}: ${specifier}`),
  );
}
function parserPlugins(filePath: string): ParserPlugin[] {
  if (/\.tsx$/.test(filePath)) return ['typescript', 'jsx'];
  if (/\.(?:ts|mts|cts)$/.test(filePath)) return ['typescript'];
  if (/\.(?:js|mjs|cjs)$/.test(filePath)) return [];
  throw new Error(`unsupported source extension: ${filePath}`);
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
      return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [filePath] : [];
    }),
  );
}
function readManifest() {
  return JSON.parse(read(`${lineageArtifactPath}.json`));
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
function hash(source: string, start: number, end: number): string {
  const region = source
    .split('\n')
    .slice(start - 1, end)
    .join('\n');
  return createHash('sha256').update(`${region}\n`).digest('hex');
}
function stringValue(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  if (value.type === 'StringLiteral' && typeof value.value === 'string') return value.value;
  if (value.type !== 'TemplateLiteral' || !Array.isArray(value.expressions)) return undefined;
  if (value.expressions.length > 0 || !Array.isArray(value.quasis)) return undefined;
  if (value.quasis.length !== 1 || !record(value.quasis[0])) return undefined;
  const templateValue = value.quasis[0].value;
  if (!record(templateValue) || typeof templateValue.cooked !== 'string') return undefined;
  return templateValue.cooked;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const sourcePattern = /^## Source: `([^`]+)`\n\nSource blob: `([a-f0-9]+)`\n([\s\S]*?)(?=^## )/gm;
const targetPattern = /^### Target: `([^`]+)`\n([\s\S]*?)(?=^### |^## )/gm;
const regionPattern = new RegExp(
  [
    String.raw`^- Region: \`([^\`]+)\`; predecessor: \`([^\`]+)\` SHA-256: \`([^\`]+)\`; `,
    String.raw`target: \`([^\`]+)\` SHA-256: \`([^\`]+)\`; excluded: \`([^\`]+)\`; `,
    String.raw`finding: \`([^\`]+)\`; disposition: \`([^\`]+)\`\.$`,
  ].join(''),
  'gm',
);
const compatibilityPattern = /^\- Path: `([^`]+)`; SHA-256: `([^`]+)`$/gm;
const moduleSpecifierNodeTypePattern = new RegExp(
  '^(' +
    'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration|' +
    'ImportExpression|TSExternalModuleReference)$',
);
const legacyErrorsSpecifier = '../routes/group-state-route-errors.ts';
const fixtureOperations = [
  ["import x from '../routes/group-state-routes';", '../routes/group-state-routes'],
  ["export { x } from '../routes/group-state-route-errors.ts';", legacyErrorsSpecifier],
  ["import('../routes/group-state-routes.ts');", '../routes/group-state-routes.ts'],
  ["require('../routes/group-state-route-errors');", '../routes/group-state-route-errors'],
  ['import(`../routes/group-state-routes`);', '../routes/group-state-routes'],
  ['require(`../routes/group-state-route-errors.ts`);', legacyErrorsSpecifier],
] as const;
