import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositoryNavigationEvidence,
  selectNavigationCapability,
} from '../../../../scripts/repo-structure-check/navigation-evidence.mjs';
import { fixtureScripts, writeFixture } from './repository-structure-command-fixture.ts';

const fixtureDigest = '0000000000000000000000000000000000000000000000000000000000000000';
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

describe('repository navigation evidence', () => {
  it('composes deterministic code-owned evidence without a disposition', () => {
    const fixture = navigationFixture();

    const evidence = createEvidence(fixture.root);

    expect(evidence).toEqual({
      schemaVersion: 'repository-navigation-evidence-v1',
      owner: 'example capability',
      root: 'scripts/example',
      entry: { path: 'scripts/example.mjs', symbol: 'runExample' },
      results: [
        { path: 'scripts/example/first.mjs', symbol: 'firstResult' },
        { path: 'scripts/example/second.mjs', symbol: 'secondResult' },
      ],
      failures: [{ path: 'scripts/example.mjs', symbol: 'toError' }],
      testRoot: 'packages/tests/repo/example',
      focusedCommand: 'npm run test:example',
      navigationMap: { state: 'present', path: 'scripts/example/README.md' },
      affectedCodeDigest: fixtureDigest,
    });
    expect(JSON.stringify(evidence)).not.toContain('disposition');
  });

  it.each([
    ['missing', '# No contract\n'],
    ['multiple', `${navigationBlock(contract())}\n${navigationBlock(contract())}\n`],
    ['malformed', '```repository-navigation-v1\n{broken}\n```\n'],
  ])('rejects a %s fenced contract', (_, markdown) => {
    const fixture = navigationFixture(markdown);

    expect(() => createEvidence(fixture.root)).toThrow(/exactly one|invalid JSON/u);
  });

  it('accepts a single safe CRLF fenced contract', () => {
    const fixture = navigationFixture(navigationBlock(contract()).replaceAll('\n', '\r\n'));

    expect(createEvidence(fixture.root)).toMatchObject({
      schemaVersion: 'repository-navigation-evidence-v1',
    });
  });

  it.each([
    ['an outer four-backtick fence', `\`\`\`\`text\n${navigationBlock(contract())}\`\`\`\`\n`],
    ['an outer four-tilde fence', `~~~~text\n${navigationBlock(contract())}~~~~\n`],
    ['an unclosed tilde fence', `~~~~text\n${navigationBlock(contract())}`],
    [
      'opening-line trailing text',
      navigationBlock(contract()).replace(
        '```repository-navigation-v1',
        '```repository-navigation-v1 extra',
      ),
    ],
    ['closing-line trailing text', navigationBlock(contract()).replace('\n```\n', '\n``` extra\n')],
    [
      'an indented opening line',
      navigationBlock(contract()).replace('```repository', '  ```repository'),
    ],
    ['an unclosed block', navigationBlock(contract()).replace('\n```\n', '\n')],
  ])('rejects %s', (_, markdown) => {
    const fixture = navigationFixture(markdown);

    expect(() => createEvidence(fixture.root)).toThrow(
      /exactly one standalone repository-navigation-v1 block/u,
    );
  });

  it.each([
    ['unknown key', { ...contract(), unexpected: true }, /unknown keys: unexpected/u],
    ['wrong version', { ...contract(), version: 2 }, /version must be 1/u],
    ['empty results', { ...contract(), results: [] }, /results must be a non-empty array/u],
    [
      'duplicate results',
      { ...contract(), results: [contract().results[0], contract().results[0]] },
      /results must not contain duplicate path#symbol references/u,
    ],
  ])('rejects %s', (_, value, message) => {
    const fixture = navigationFixture(navigationBlock(value));

    expect(() => createEvidence(fixture.root)).toThrow(message);
  });

  it.each([
    ['/absolute.mjs', /repository-relative POSIX path/u],
    ['scripts\\example\\first.mjs', /repository-relative POSIX path/u],
    ['scripts/example/../other.mjs', /repository-relative POSIX path/u],
    ['scripts/other.mjs', /outside example capability/u],
  ])('rejects unsafe or out-of-owner path %s', (repositoryPath, message) => {
    const value = contract();
    value.results[0].path = repositoryPath;
    const fixture = navigationFixture(navigationBlock(value));

    expect(() => createEvidence(fixture.root)).toThrow(message);
  });

  it('rejects an entry that disagrees with the capability declaration', () => {
    const value = contract();
    value.entry.path = 'scripts/example/first.mjs';
    const fixture = navigationFixture(navigationBlock(value));

    expect(() => createEvidence(fixture.root)).toThrow(
      /entry path must match declared entry scripts\/example\.mjs/u,
    );
  });

  it.each([
    ['missing path', 'missingResult', /does not resolve/u],
    ['missing symbol', 'absentResult', /is not a navigable top-level owner/u],
  ])('rejects a %s', (_, symbol, message) => {
    const value = contract();
    value.results[0] = { path: 'scripts/example/missing.mjs', symbol };
    const fixture = navigationFixture(navigationBlock(value));
    if (symbol === 'absentResult') {
      writeFixture(fixture.root, 'scripts/example/missing.mjs', 'export const present = true;\n');
    }

    expect(() => createEvidence(fixture.root)).toThrow(message);
  });

  it('rejects symlinked and unreadable evidence files', () => {
    const symlinkFixture = navigationFixture();
    const outside = path.join(symlinkFixture.root, 'outside.mjs');
    writeFileSync(outside, 'export const firstResult = true;\n');
    writeFixture(symlinkFixture.root, 'scripts/example/placeholder', 'fixture\n');
    const evidencePath = path.join(symlinkFixture.root, 'scripts/example/first.mjs');
    writeFileSync(evidencePath, '');
    expect(() => {
      unlinkSync(evidencePath);
      symlinkSync(outside, evidencePath);
      createEvidence(symlinkFixture.root);
    }).toThrow(/must not be a symlink/u);

    const unreadableFixture = navigationFixture();
    const unreadablePath = path.join(unreadableFixture.root, 'scripts/example/first.mjs');
    chmodSync(unreadablePath, 0o000);
    try {
      expect(() => createEvidence(unreadableFixture.root)).toThrow(/is not readable/u);
    } finally {
      chmodSync(unreadablePath, 0o644);
    }
  });

  it('rejects a symlinked or unreadable navigation map', () => {
    const symlinkFixture = navigationFixture();
    const mapPath = path.join(symlinkFixture.root, 'scripts/example/README.md');
    const outside = path.join(symlinkFixture.root, 'outside.md');
    writeFileSync(outside, navigationBlock(contract()));
    unlinkSync(mapPath);
    symlinkSync(outside, mapPath);
    expect(() => createEvidence(symlinkFixture.root)).toThrow(/must not be a symlink/u);

    const unreadableFixture = navigationFixture();
    const unreadableMap = path.join(unreadableFixture.root, 'scripts/example/README.md');
    chmodSync(unreadableMap, 0o000);
    try {
      expect(() => createEvidence(unreadableFixture.root)).toThrow(/is not readable/u);
    } finally {
      chmodSync(unreadableMap, 0o644);
    }
  });

  it.each([
    ['navigation map', 'scripts/example/README.md', navigationBlock(contract())],
    ['source', 'scripts/example/first.mjs', source('firstResult')],
  ])('rejects a %s replaced between identity capture and descriptor open', (_, target, content) => {
    const fixture = navigationFixture();
    const absoluteTarget = path.join(fixture.root, target);
    const replacementPath = `${absoluteTarget}.replacement`;
    writeFileSync(replacementPath, content);

    expect(() =>
      createEvidence(fixture.root, capability(), fixtureDigest, {
        beforeOpen({ repositoryPath, absolutePath }) {
          if (repositoryPath === target) {
            renameSync(replacementPath, absolutePath);
          }
        },
      }),
    ).toThrow(/changed while reading navigation evidence/u);
  });

  it('rejects a path component whose identity changes after descriptor read', () => {
    const fixture = navigationFixture();
    const scriptsPath = path.join(fixture.root, 'scripts');
    const displacedPath = path.join(fixture.root, 'scripts-before-swap');

    expect(() =>
      createEvidence(fixture.root, capability(), fixtureDigest, {
        afterRead({ repositoryPath }) {
          if (repositoryPath === 'scripts/example/README.md') {
            renameSync(scriptsPath, displacedPath);
            mkdirSync(scriptsPath);
          }
        },
      }),
    ).toThrow(/changed while reading navigation evidence/u);
  });

  it('rejects local symbols and malformed affected-code digests', () => {
    const localFixture = navigationFixture();
    writeFixture(
      localFixture.root,
      'scripts/example/first.mjs',
      'export function wrapper() { function firstResult() { return true; } return firstResult(); }\n',
    );
    expect(() => createEvidence(localFixture.root)).toThrow(/not a navigable top-level owner/u);

    const digestFixture = navigationFixture();
    expect(() => createEvidence(digestFixture.root, capability(), 'fixture-digest')).toThrow(
      /64-character lowercase hexadecimal affected-code digest/u,
    );
  });

  it('rejects a capability without the required navigation-map contract', () => {
    const fixture = navigationFixture();

    expect(() => createEvidence(fixture.root, capability({ navigationMap: undefined }))).toThrow(
      /does not declare a navigation map/u,
    );
  });

  it('rejects a physically present map omitted from repository inventory', () => {
    const fixture = navigationFixture();

    expect(() =>
      createEvidence(fixture.root, capability(), fixtureDigest, undefined, false),
    ).toThrow(
      /navigation map .* does not resolve to a tracked or nonignored untracked repository file/u,
    );
  });

  it('selects one active code capability by exact owner', () => {
    const example = capability();
    const other = capability({ owner: 'other capability' });

    expect(selectNavigationCapability([example, other], 'example capability')).toBe(example);
    expect(() => selectNavigationCapability([example], 'missing')).toThrow(/owner missing/u);
    expect(() => selectNavigationCapability([example, example], 'example capability')).toThrow(
      /owner example capability is ambiguous/u,
    );
  });
});

function navigationFixture(markdown = navigationBlock(contract())) {
  const root = mkdtempSync(path.join(tmpdir(), 'navigation-evidence-'));
  fixtureRoots.push(root);
  writeFixture(root, 'scripts/example.mjs', source('runExample', 'toError'));
  writeFixture(root, 'scripts/example/first.mjs', source('firstResult'));
  writeFixture(root, 'scripts/example/second.mjs', source('secondResult'));
  writeFixture(root, 'scripts/example/README.md', markdown);
  writeFixture(root, 'packages/tests/repo/example/first.test.ts', 'export {};\n');
  writeFixture(root, 'packages/tests/repo/example/second.test.ts', 'export {};\n');
  return { root };
}

function createEvidence(
  root: string,
  declaredCapability = capability(),
  affectedCodeDigest = fixtureDigest,
  fileOperations?: Readonly<{
    beforeOpen?(input: Readonly<{ repositoryPath: string; absolutePath: string }>): void;
    afterRead?(input: Readonly<{ repositoryPath: string; absolutePath: string }>): void;
  }>,
  includeNavigationMap = true,
) {
  const optionalFiles = ['scripts/example/missing.mjs'].filter((repositoryPath) =>
    existsSync(path.join(root, repositoryPath)),
  );
  return createRepositoryNavigationEvidence({
    repoRoot: root,
    capability: declaredCapability,
    repositoryFiles: [
      'scripts/example.mjs',
      'scripts/example/first.mjs',
      'scripts/example/second.mjs',
      ...(includeNavigationMap ? ['scripts/example/README.md'] : []),
      'packages/tests/repo/example/first.test.ts',
      'packages/tests/repo/example/second.test.ts',
      ...optionalFiles,
    ],
    packageScripts: fixtureScripts(),
    affectedCodeDigest,
    fileOperations,
  });
}

function capability(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    owner: 'example capability',
    root: 'scripts/example',
    entry: 'scripts/example.mjs',
    testRoot: 'packages/tests/repo/example',
    focusedCommand: 'npm run test:example',
    navigationMap: 'scripts/example/README.md',
    controlFlowFamilies: ['scan', 'report'],
    ...overrides,
  };
}

function contract() {
  return {
    version: 1,
    entry: { path: 'scripts/example.mjs', symbol: 'runExample' },
    results: [
      { path: 'scripts/example/first.mjs', symbol: 'firstResult' },
      { path: 'scripts/example/second.mjs', symbol: 'secondResult' },
    ],
    failures: [{ path: 'scripts/example.mjs', symbol: 'toError' }],
  };
}

function navigationBlock(value: unknown): string {
  return `# Example navigation\n\n\`\`\`repository-navigation-v1\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function source(...symbols: readonly string[]): string {
  return symbols.map((symbol) => `export function ${symbol}() { return true; }`).join('\n');
}
