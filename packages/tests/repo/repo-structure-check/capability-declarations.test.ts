import { describe, expect, it } from 'vitest';

import { validateCapabilityDeclarations } from '../../../../scripts/repo-structure-check/capability-declarations.mjs';

describe('repository capability declarations', () => {
  it('requires the declared canonical entry to exist', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability({ entry: 'scripts/missing-example.mjs' })],
      authoredFiles: fixtureFiles(),
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability entry scripts/missing-example.mjs does not resolve to authored code',
    );
  });

  it('requires the declared test root to mirror the capability root', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability({ testRoot: 'packages/tests/repo/not-example' })],
      authoredFiles: [...fixtureFiles(), 'packages/tests/repo/not-example/feature.test.ts'],
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/not-example' },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability test root packages/tests/repo/not-example does not mirror scripts/example',
    );
  });

  it('requires the focused command to run exactly the declared mirrored test root', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability()],
      authoredFiles: fixtureFiles(),
      packageScripts: { 'test:example': 'vitest run packages/tests/repo' },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability focused command npm run test:example must resolve exactly to ' +
        'vitest run packages/tests/repo/example',
    );
  });

  it('requires every consumed fact contract to resolve to authored code', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability({ factContracts: ['scripts/repo-style-check/missing.mjs'] })],
      authoredFiles: fixtureFiles(),
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability fact contract scripts/repo-style-check/missing.mjs does not resolve ' +
        'to authored code',
    );
  });

  it('requires the declared capability and test roots to contain authored code', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [
        capability({ root: 'scripts/absent', testRoot: 'packages/tests/repo/absent' }),
      ],
      authoredFiles: fixtureFiles(),
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/absent' },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain('example capability root scripts/absent contains no authored code');
    expect(issues).toContain(
      'example capability test root packages/tests/repo/absent contains no authored tests',
    );
  });

  it('requires a navigation map above twenty production modules', () => {
    const productionModules = Array.from(
      { length: 21 },
      (_, index) => `scripts/example/module-${index}.mjs`,
    );
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability()],
      authoredFiles: [
        'scripts/example.mjs',
        ...productionModules,
        'packages/tests/repo/example/feature.test.ts',
      ],
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability requires a navigation map (21 production modules, ' +
        '2 control-flow families)',
    );
  });

  it('requires a navigation map at three control-flow families', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability({ controlFlowFamilies: ['scan', 'classify', 'report'] })],
      authoredFiles: fixtureFiles(),
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability requires a navigation map (2 production modules, ' +
        '3 control-flow families)',
    );
  });

  it('validates repository paths and symbols cited by cold-navigation evidence', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability()],
      authoredFiles: fixtureFiles(),
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: (file: string) =>
        file === 'scripts/example/first.mjs'
          ? 'export function scanExample() { return true; }\n'
          : undefined,
      coldNavigationEvidence: {
        status: 'passed',
        summary: 'The probe followed the declared entry to its result.',
        probes: [
          {
            capabilityOwner: 'example capability',
            path: 'scripts/example/first.mjs',
            symbol: 'missingSymbol',
          },
          {
            capabilityOwner: 'example capability',
            path: 'scripts/example/missing.mjs',
            symbol: 'readMissing',
          },
        ],
      },
    });

    expect(issues).toContain(
      'cold-navigation probe symbol missingSymbol does not resolve in scripts/example/first.mjs',
    );
    expect(issues).toContain(
      'cold-navigation probe path scripts/example/missing.mjs does not resolve to authored code',
    );
  });

  it('requires complex-feature navigation maps to link to resolvable source symbols', () => {
    const mapCapability = capability({
      navigationMap: 'scripts/example/README.md',
      controlFlowFamilies: ['scan', 'classify', 'report'],
    });
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [mapCapability],
      authoredFiles: fixtureFiles(),
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: (file: string) => {
        if (file === 'scripts/example/README.md') {
          return '[scan](./first.mjs#missingSymbol)';
        }
        if (file === 'scripts/example/first.mjs') {
          return 'export function scanExample() { return true; }\n';
        }
        return undefined;
      },
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability navigation-map symbol missingSymbol does not resolve in ' +
        'scripts/example/first.mjs',
    );
  });

  it('rejects a navigation map without source links', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [
        capability({
          navigationMap: 'scripts/example/README.md',
          controlFlowFamilies: ['scan', 'classify', 'report'],
        }),
      ],
      authoredFiles: fixtureFiles(),
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: (file: string) =>
        file === 'scripts/example/README.md' ? '# Example\n\n`first.mjs` owns scanning.\n' : '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability navigation map scripts/example/README.md must link to source symbols',
    );
  });

  it('requires navigation-map links to stay with their owner and cite its canonical entry', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [
        capability({
          navigationMap: 'scripts/example/README.md',
          controlFlowFamilies: ['scan', 'classify', 'report'],
        }),
      ],
      authoredFiles: [...fixtureFiles(), 'scripts/other/entry.mjs'],
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: (file: string) => {
        if (file === 'scripts/example/README.md') {
          return (
            '[external](https://example.com/source#scanExample)\n' +
            '[other owner](../other/entry.mjs#scanOther)\n' +
            '[local helper](./first.mjs#scanExample)\n'
          );
        }
        if (file === 'scripts/other/entry.mjs') {
          return 'export function scanOther() { return true; }\n';
        }
        if (file === 'scripts/example/first.mjs') {
          return 'export function scanExample() { return true; }\n';
        }
        return undefined;
      },
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability navigation-map path scripts/other/entry.mjs is outside its declared owner',
    );
    expect(issues).toContain(
      'example capability navigation map scripts/example/README.md must link to canonical entry ' +
        'scripts/example.mjs',
    );
  });

  it('requires cold-navigation probes to stay within their declared owner', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability()],
      authoredFiles: [...fixtureFiles(), 'scripts/other/entry.mjs'],
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: (file: string) =>
        file === 'scripts/other/entry.mjs'
          ? 'export function scanOther() { return true; }\n'
          : undefined,
      coldNavigationEvidence: {
        status: 'passed',
        summary: 'The probe reached a symbol owned by another capability.',
        probes: [
          {
            capabilityOwner: 'example capability',
            path: 'scripts/other/entry.mjs',
            symbol: 'scanOther',
          },
        ],
      },
    });

    expect(issues).toContain(
      'cold-navigation probe path scripts/other/entry.mjs is outside example capability',
    );
  });
});

function capability(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'example capability',
    root: 'scripts/example',
    entry: 'scripts/example.mjs',
    testRoot: 'packages/tests/repo/example',
    focusedCommand: 'npm run test:example',
    navigationMap: null,
    controlFlowFamilies: ['scan', 'report'],
    factContracts: [],
    ...overrides,
  };
}

function fixtureFiles(): readonly string[] {
  return [
    'scripts/example.mjs',
    'scripts/example/first.mjs',
    'scripts/example/second.mjs',
    'packages/tests/repo/example/first.test.ts',
    'packages/tests/repo/example/second.test.ts',
  ];
}
