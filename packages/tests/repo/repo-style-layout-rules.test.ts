import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isLayoutTypeScriptFile,
  layoutRuleIds,
  scanRepositoryLayout,
  toKebabCase,
} from '../../../scripts/repo-style-check/layout-rules.mjs';

const repoRoot = path.resolve('/repo');

describe('repository layout rules', () => {
  it('uses the exact TypeScript projection and defensively ignores JavaScript', () => {
    expect(isLayoutTypeScriptFile('/repo/feature/value.ts')).toBe(true);
    expect(isLayoutTypeScriptFile('/repo/feature/value.tsx')).toBe(true);
    expect(isLayoutTypeScriptFile('/repo/feature/value.mts')).toBe(true);
    expect(isLayoutTypeScriptFile('/repo/feature/value.cts')).toBe(true);
    expect(isLayoutTypeScriptFile('/repo/feature/value.d.ts')).toBe(true);
    expect(isLayoutTypeScriptFile('/repo/feature/value.mjs')).toBe(false);

    const result = scan(sources({ 'feature/value.mjs': 'export const value = 1;' }));
    expect(result.findings).toEqual([]);
    expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
  });

  it('normalizes the repository naming forms mechanically', () => {
    expect(toKebabCase('RallarRoomsFacade')).toBe('rallar-rooms-facade');
    expect(toKebabCase('GroupRef')).toBe('group-ref');
    expect(toKebabCase('APIClient')).toBe('api-client');
    expect(toKebabCase('PSqlRepository')).toBe('p-sql-repository');
  });

  it('warns only above the direct TypeScript file threshold', () => {
    expect(scan(makeSources(20)).counts[layoutRuleIds.directoryDensity]).toBe(0);
    expect(scan(makeSources(21)).counts[layoutRuleIds.directoryDensity]).toBe(1);
  });

  it('groups one feature-prefix finding per qualifying cluster', () => {
    const fourAuthFiles = [
      'read-auth-session.ts',
      'compute-auth-session.ts',
      'validate-auth-session.ts',
      'write-auth-session.ts',
    ];
    const result = scan(denseSourcesWithFeatureFiles(fourAuthFiles));
    const prefixFindings = findingsFor(result, layoutRuleIds.featurePrefixCluster);

    expect(prefixFindings).toHaveLength(1);
    expect(prefixFindings[0]?.affectedCount).toBe(1);
    expect(result.counts[layoutRuleIds.featurePrefixCluster]).toBe(1);
    expect(
      scan(denseSourcesWithFeatureFiles(fourAuthFiles.slice(0, 3))).counts[
        layoutRuleIds.featurePrefixCluster
      ],
    ).toBe(0);
  });

  it('compares prefixes only with exact immediate-directory tokens', () => {
    const authFiles = [
      'read-auth-session.ts',
      'compute-auth-session.ts',
      'validate-auth-session.ts',
      'write-auth-session.ts',
    ];
    const groupFiles = [
      'read-group-session.ts',
      'compute-group-session.ts',
      'validate-group-session.ts',
      'write-group-session.ts',
    ];

    expect(
      scan(denseSourcesWithFeatureFiles(authFiles, 'packages/example/auth-services')).counts[
        layoutRuleIds.featurePrefixCluster
      ],
    ).toBe(0);
    expect(
      scan(denseSourcesWithFeatureFiles(authFiles, 'packages/example/auth/services')).counts[
        layoutRuleIds.featurePrefixCluster
      ],
    ).toBe(1);
    expect(
      scan(denseSourcesWithFeatureFiles(groupFiles, 'packages/example/groups')).counts[
        layoutRuleIds.featurePrefixCluster
      ],
    ).toBe(1);
  });

  it('removes ignored tokens only from the leading run and assigns one cluster per file', () => {
    const result = scan(
      denseSourcesWithFeatureFiles([
        'read-auth-register-session.ts',
        'compute-auth-write-session.ts',
        'validate-auth-read-session.ts',
        'write-auth-create-session.ts',
      ]),
    );
    const prefixFindings = findingsFor(result, layoutRuleIds.featurePrefixCluster);

    expect(prefixFindings).toHaveLength(1);
    expect(prefixFindings[0]?.message).toContain('auth');
  });

  it('reports cluster cardinality and at most five sorted samples', () => {
    const clusterFiles = [
      'read-auth-a.ts',
      'compute-auth-b.ts',
      'validate-auth-c.ts',
      'write-auth-d.ts',
      'create-auth-e.ts',
      'to-auth-f.ts',
    ];
    const result = scan(denseSourcesWithFeatureFiles(clusterFiles));
    const message = findingsFor(result, layoutRuleIds.featurePrefixCluster)[0]?.message ?? '';
    const sortedSamples = [...clusterFiles].sort();

    expect(message).toContain('6 direct files');
    for (const sample of sortedSamples.slice(0, 5)) {
      expect(message).toContain(sample);
    }
    expect(message).not.toContain(sortedSamples[5]);
  });

  it('groups non-kebab filenames while accepting exact tool configuration names', () => {
    const result = scan(
      sources({
        'feature/ThingService.ts': 'export class ThingService {}',
        'feature/thingService.ts': 'export class OtherThingService {}',
        'feature/thing-service.ts': 'export class ThingService {}',
        'feature/vite.config.ts': 'export default {};',
      }),
    );

    expect(result.counts[layoutRuleIds.filenameStyle]).toBe(2);
    expect(findingsFor(result, layoutRuleIds.filenameStyle)).toHaveLength(1);
  });

  it('warns only for exact generic filenames', () => {
    const result = scan(
      sources({
        'feature/types.ts': 'export interface Value {}',
        'feature/group-state-types.ts': 'export interface GroupStateValue {}',
        'feature/helpers.ts': 'export function readValue() {}',
        'feature/group-state-helpers.ts': 'export function readGroupState() {}',
      }),
    );

    expect(result.counts[layoutRuleIds.genericFilename]).toBe(2);
  });

  it('parses exported route registration functions instead of matching text', () => {
    const result = scan(
      sources({
        'feature/thing-routes.ts': [
          "const text = 'export function init() {}';",
          'export function init() {}',
        ].join('\n'),
        'feature/other-routes.ts': 'export function registerOtherRoutes() {}',
        'feature/private-route.ts': 'function init() {}',
        'feature/arrow-routes.ts': 'export const init = () => {};',
        'feature/function-expression-routes.ts': 'export const init = function () {};',
      }),
    );

    expect(result.counts[layoutRuleIds.genericRouteInit]).toBe(3);
  });

  it('parses TypeScript type assertions in .ts route modules without JSX', () => {
    const result = scan(
      sources({
        'feature/type-assertion-routes.ts': [
          'const routeConfig = <RouteConfig>input;',
          'export function registerTypeAssertionRoutes() {}',
        ].join('\n'),
      }),
    );

    expect(result.counts[layoutRuleIds.genericRouteInit]).toBe(0);
  });

  it('allows only the approved mod compatibility boundaries', () => {
    const result = scan(
      sources({
        'packages/shared/mod.ts': 'export {};',
        'packages/shared/feature/mod.ts': 'export {};',
      }),
    );

    expect(result.counts[layoutRuleIds.unapprovedMod]).toBe(1);
  });

  it('sorts findings deterministically and derives counts from affected items', () => {
    const records = sources({
      'zeta/types.ts': 'export interface Zeta {}',
      'alpha/Thing.ts': 'export class Thing {}',
      'alpha/helpers.ts': 'export function readThing() {}',
    });
    const forward = scan(records);
    const reversed = scan([...records].reverse());
    const keys = forward.findings.map(findingKey);

    expect(reversed).toEqual(forward);
    expect(keys).toEqual([...keys].sort());
    expect(forward.counts[layoutRuleIds.filenameStyle]).toBe(1);
    expect(forward.counts[layoutRuleIds.genericFilename]).toBe(2);
    expect(forward.counts[layoutRuleIds.primaryExportName]).toBe(0);
  });

  it('sorts findings by code units across punctuation and non-ASCII paths', () => {
    const result = scan(
      sources({
        'order/é/types.ts': 'export interface Accented {}',
        'order/z/types.ts': 'export interface Zeta {}',
        'order/-/types.ts': 'export interface Punctuation {}',
        'order/a/types.ts': 'export interface Alpha {}',
      }),
    );

    expect(
      findingsFor(result, layoutRuleIds.genericFilename).map((finding) => finding.file),
    ).toEqual(
      ['order/-', 'order/a', 'order/z', 'order/é'].map((directory) =>
        path.resolve(repoRoot, directory),
      ),
    );
  });

  it('reproduces the 22-cluster planning count deterministically', () => {
    const planningResult = scanRepositoryLayout({
      repoRoot,
      sources: planningCountFixture(),
    });
    const prefixFindings = planningResult.findings.filter(
      (finding) => finding.ruleId === layoutRuleIds.featurePrefixCluster,
    );

    expect(prefixFindings).toHaveLength(22);
    expect(prefixFindings.every((finding) => finding.affectedCount === 1)).toBe(true);
    expect(new Set(prefixFindings.map((finding) => finding.file))).toHaveLength(8);
    expect(planningResult.counts[layoutRuleIds.featurePrefixCluster]).toBe(22);
  });
});

interface SourceRecord {
  readonly file: string;
  readonly raw: string;
}

interface ScanResult {
  readonly findings: readonly {
    readonly affectedCount: number;
    readonly file: string;
    readonly message: string;
    readonly ruleId: string;
  }[];
  readonly counts: Readonly<Record<string, number>>;
}

function scan(sourceRecords: readonly SourceRecord[]): ScanResult {
  return scanRepositoryLayout({ repoRoot, sources: sourceRecords });
}

function sources(files: Readonly<Record<string, string>>): SourceRecord[] {
  return Object.entries(files).map(([file, raw]) => ({
    file: path.resolve(repoRoot, file),
    raw,
  }));
}

function makeSources(count: number, directory = 'packages/example/dense'): SourceRecord[] {
  return sources(
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `${directory}/item${index}-source.ts`,
        `export const value${index} = ${index};`,
      ]),
    ),
  );
}

function denseSourcesWithFeatureFiles(
  featureFiles: readonly string[],
  directory = 'packages/example/dense-review',
): SourceRecord[] {
  const files: Record<string, string> = Object.fromEntries(
    featureFiles.map((file, index) => [`${directory}/${file}`, `export const value${index} = 1;`]),
  );

  for (let index = featureFiles.length; index < 21; index += 1) {
    files[`${directory}/filler${index}-source.ts`] = `export const filler${index} = 1;`;
  }

  return sources(files);
}

function planningCountFixture(): SourceRecord[] {
  const clusterCounts = [3, 3, 3, 3, 3, 3, 2, 2];
  const files: Record<string, string> = {};

  clusterCounts.forEach((clusterCount, directoryIndex) => {
    const directory = `packages/planning/zone-${directoryIndex}`;
    for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex += 1) {
      const prefix = `feature${directoryIndex}${clusterIndex}`;
      for (const action of ['read', 'compute', 'validate', 'write']) {
        files[`${directory}/${action}-${prefix}-value.ts`] = 'export const value = 1;';
      }
    }

    const currentFileCount = clusterCount * 4;
    for (let fillerIndex = currentFileCount; fillerIndex < 21; fillerIndex += 1) {
      files[`${directory}/filler${directoryIndex}${fillerIndex}-source.ts`] =
        'export const filler = 1;';
    }
  });

  return sources(files);
}

function findingsFor(result: ScanResult, ruleId: string) {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}

function findingKey(finding: ScanResult['findings'][number]): string {
  return `${finding.file}\u0000${finding.ruleId}\u0000${finding.message}`;
}
