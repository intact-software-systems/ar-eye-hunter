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

  it('requires the canonical entry to belong to the declared owner', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability({ entry: 'scripts/other.mjs' })],
      authoredFiles: [...fixtureFiles(), 'scripts/other.mjs'],
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability entry scripts/other.mjs must be inside scripts/example or its exact ' +
        'thin sibling entry',
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
      'example capability test root packages/tests/repo/not-example must use a recognized mirrored ' +
        'test hierarchy for scripts/example',
    );
  });

  it('rejects a same-named test root outside the owner surface mirror', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability({ testRoot: 'packages/tests/unrelated/example' })],
      authoredFiles: [...fixtureFiles(), 'packages/tests/unrelated/example/feature.test.ts'],
      packageScripts: {
        'test:example': 'vitest run packages/tests/unrelated/example',
      },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability test root packages/tests/unrelated/example must use a recognized ' +
        'mirrored test hierarchy for scripts/example',
    );
  });

  it('requires a recognized test hierarchy containing real test modules', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability({ testRoot: 'packages/not-tests/example' })],
      authoredFiles: [...fixtureFiles(), 'packages/not-tests/example/helper.ts'],
      packageScripts: { 'test:example': 'vitest run packages/not-tests/example' },
      readFile: () => '',
      coldNavigationEvidence: null,
    });

    expect(issues).toContain(
      'example capability test root packages/not-tests/example must use a recognized mirrored ' +
        'test hierarchy for scripts/example',
    );
    expect(issues).toContain(
      'example capability test root packages/not-tests/example contains no authored .test/.spec modules',
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
      'example capability requires a navigation map (22 production modules, ' +
        '2 control-flow families)',
    );
  });

  it('includes the thin sibling canonical entry in the production-module threshold', () => {
    const productionModules = Array.from(
      { length: 20 },
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
      'example capability requires a navigation map (3 production modules, ' +
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
      'cold-navigation probe symbol missingSymbol is not a navigable top-level owner in ' +
        'scripts/example/first.mjs',
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
      'example capability navigation-map symbol missingSymbol is not a navigable top-level owner in ' +
        'scripts/example/first.mjs',
    );
  });

  it('accepts only navigable top-level JavaScript or TypeScript owner symbols', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability()],
      authoredFiles: fixtureFiles(),
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: (file: string) =>
        file === 'scripts/example/first.mjs'
          ? 'export function outerOwner() { function nestedOwner() {} return nestedOwner; }\n'
          : undefined,
      coldNavigationEvidence: {
        status: 'passed',
        summary: 'The probe claimed a nested local declaration as an owner.',
        probes: [
          {
            capabilityOwner: 'example capability',
            path: 'scripts/example/first.mjs',
            symbol: 'nestedOwner',
          },
        ],
      },
    });

    expect(issues).toContain(
      'cold-navigation probe symbol nestedOwner is not a navigable top-level owner in ' +
        'scripts/example/first.mjs',
    );
  });

  it('validates top-level Python and shell symbols with language-aware rules', () => {
    const capabilities = [
      capability({
        owner: 'python capability',
        root: 'scripts/python',
        entry: 'scripts/python.py',
      }),
      capability({ owner: 'shell capability', root: 'scripts/shell', entry: 'scripts/shell.sh' }),
    ];
    const authoredFiles = [
      ...fixtureFiles(),
      'scripts/python.py',
      'scripts/python/module.py',
      'scripts/shell.sh',
      'scripts/shell/module.sh',
    ];
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities,
      authoredFiles,
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: (file: string) => {
        if (file === 'scripts/python/module.py') {
          return 'def python_owner():\n    def nested_python():\n        pass\n';
        }
        if (file === 'scripts/shell/module.sh') {
          return 'shell_owner() {\nnested_shell() { :; }\n}\n';
        }
        return '';
      },
      coldNavigationEvidence: {
        status: 'passed',
        summary: 'The probes name top-level and nested Python and shell symbols.',
        probes: [
          {
            capabilityOwner: 'python capability',
            path: 'scripts/python/module.py',
            symbol: 'python_owner',
          },
          {
            capabilityOwner: 'python capability',
            path: 'scripts/python/module.py',
            symbol: 'nested_python',
          },
          {
            capabilityOwner: 'shell capability',
            path: 'scripts/shell/module.sh',
            symbol: 'shell_owner',
          },
          {
            capabilityOwner: 'shell capability',
            path: 'scripts/shell/module.sh',
            symbol: 'nested_shell',
          },
        ],
      },
    });

    expect(issues).not.toContain(
      'cold-navigation probe symbol python_owner is not a navigable top-level owner in scripts/python/module.py',
    );
    expect(issues).not.toContain(
      'cold-navigation probe symbol shell_owner is not a navigable top-level owner in scripts/shell/module.sh',
    );
    expect(issues).toContain(
      'cold-navigation probe symbol nested_python is not a navigable top-level owner in scripts/python/module.py',
    );
    expect(issues).toContain(
      'cold-navigation probe symbol nested_shell is not a navigable top-level owner in scripts/shell/module.sh',
    );
  });

  it('resolves shell symbols only at balanced top-level function and brace scope', () => {
    const shellCapability = capability({
      owner: 'shell capability',
      root: 'scripts/shell',
      entry: 'scripts/shell.sh',
    });
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [shellCapability],
      authoredFiles: [
        ...fixtureFiles(),
        'scripts/shell.sh',
        'scripts/shell/module.sh',
        'scripts/shell/malformed.sh',
      ],
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: (file: string) => {
        if (file === 'scripts/shell/module.sh') {
          return [
            'TOP_LEVEL=value',
            'top_level() {',
            '{',
            'BRACED_LOCAL=value',
            '}',
            'FUNCTION_LOCAL=value',
            'nested_function() { :; }',
            '}',
            'one_line() { ONE_LINE_LOCAL=value; }',
            'multi_line()',
            '{',
            'MULTI_LINE_LOCAL=value',
            '}',
          ].join('\n');
        }
        if (file === 'scripts/shell/malformed.sh') {
          return 'broken_function() {\nUNBALANCED_LOCAL=value\n';
        }
        return '';
      },
      coldNavigationEvidence: {
        status: 'passed',
        summary: 'The probes distinguish shell top-level owners from nested declarations.',
        probes: [
          ...[
            'TOP_LEVEL',
            'top_level',
            'one_line',
            'multi_line',
            'BRACED_LOCAL',
            'FUNCTION_LOCAL',
            'nested_function',
            'ONE_LINE_LOCAL',
            'MULTI_LINE_LOCAL',
          ].map((symbol) => ({
            capabilityOwner: 'shell capability',
            path: 'scripts/shell/module.sh',
            symbol,
          })),
          {
            capabilityOwner: 'shell capability',
            path: 'scripts/shell/malformed.sh',
            symbol: 'broken_function',
          },
        ],
      },
    });

    for (const symbol of ['TOP_LEVEL', 'top_level', 'one_line', 'multi_line']) {
      expect(issues).not.toContain(
        `cold-navigation probe symbol ${symbol} is not a navigable top-level owner in ` +
          'scripts/shell/module.sh',
      );
    }
    for (const symbol of [
      'BRACED_LOCAL',
      'FUNCTION_LOCAL',
      'nested_function',
      'ONE_LINE_LOCAL',
      'MULTI_LINE_LOCAL',
    ]) {
      expect(issues).toContain(
        `cold-navigation probe symbol ${symbol} is not a navigable top-level owner in ` +
          'scripts/shell/module.sh',
      );
    }
    expect(issues).toContain(
      'cold-navigation probe symbol evidence for scripts/shell/malformed.sh is unresolvable ' +
        'because shell scope is malformed or unbalanced',
    );
  });

  it('fails explicitly when symbol evidence uses an unsupported authored language', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [capability()],
      authoredFiles: [...fixtureFiles(), 'scripts/example/styles.css'],
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: () => '.owner { color: red; }\n',
      coldNavigationEvidence: {
        status: 'passed',
        summary: 'The probe names a CSS selector as though it were a code owner.',
        probes: [
          {
            capabilityOwner: 'example capability',
            path: 'scripts/example/styles.css',
            symbol: 'owner',
          },
        ],
      },
    });

    expect(issues).toContain(
      'cold-navigation probe symbol evidence for scripts/example/styles.css uses unsupported language .css',
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

  it('allows navigation maps to trace explicitly declared cross-owner fact contracts', () => {
    const issues = validateCapabilityDeclarations({
      repoRoot: '/repo',
      capabilities: [
        capability({
          navigationMap: 'scripts/example/README.md',
          controlFlowFamilies: ['scan', 'classify', 'report'],
          factContracts: ['scripts/other/contract.mjs'],
        }),
      ],
      authoredFiles: [...fixtureFiles(), 'scripts/other/contract.mjs'],
      packageScripts: { 'test:example': 'vitest run packages/tests/repo/example' },
      readFile: (file: string) => {
        if (file === 'scripts/example/README.md') {
          return (
            '[entry](../example.mjs#runExample)\n' +
            '[fact contract](../other/contract.mjs#readFacts)\n'
          );
        }
        if (file === 'scripts/example.mjs') {
          return 'export function runExample() { return true; }\n';
        }
        if (file === 'scripts/other/contract.mjs') {
          return 'export function readFacts() { return []; }\n';
        }
        return undefined;
      },
      coldNavigationEvidence: null,
    });

    expect(issues).not.toContain(
      'example capability navigation-map path scripts/other/contract.mjs is outside its declared owner',
    );
    expect(issues).toEqual([]);
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
