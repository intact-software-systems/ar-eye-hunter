import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readRepositoryNavigationEvidence } from '../../../../scripts/repo-structure-check/repository-structure-check.mjs';
import {
  computePlanFacts,
  readChangedPaths,
} from '../../../../scripts/plan-adaptation/plan-change-facts.mjs';
import {
  cleanupRepositoryFixtures,
  createRecord,
  createRepositoryFixture,
  runChecker,
  writeFixture,
  writePlanRecord,
} from './repository-structure-command-fixture.ts';

afterEach(cleanupRepositoryFixtures);

describe('repository navigation evidence command', () => {
  it('emits deterministic JSON for a declared owner', () => {
    const fixture = navigationCommandFixture();

    const first = runChecker(fixture, {
      includeBase: false,
      extraArgs: ['--navigation-evidence', 'example capability'],
    });
    const second = runChecker(fixture, {
      includeBase: false,
      extraArgs: ['--navigation-evidence', 'example capability'],
    });

    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toBe(second.stdout);
    expect(JSON.parse(first.stdout)).toMatchObject({
      schemaVersion: 'repository-navigation-evidence-v1',
      owner: 'example capability',
      entry: { path: 'scripts/example.mjs', symbol: 'runExample' },
      results: [{ path: 'scripts/example/first.mjs', symbol: 'firstResult' }],
      failures: [{ path: 'scripts/example.mjs', symbol: 'toError' }],
      focusedCommand: 'npm run test:example',
      affectedCodeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(first.stdout).not.toContain('disposition');
  });

  it('rejects unknown owners and invalid option combinations', () => {
    const fixture = navigationCommandFixture();

    const unknown = runChecker(fixture, {
      includeBase: false,
      extraArgs: ['--navigation-evidence', 'missing capability'],
    });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('navigation evidence owner missing capability');

    const combined = runChecker(fixture, {
      extraArgs: ['--navigation-evidence', 'example capability', '--base', fixture.base],
    });
    expect(combined.status).toBe(2);
    expect(combined.stderr).toContain('usage: node scripts/repo-structure-check.mjs');
  });

  it('requires --plan only when an owner name is ambiguous across active plans', () => {
    const fixture = navigationCommandFixture();
    const second = structuredClone(createRecord());
    second.planId = 'second-plan';
    second.capabilities[0] = {
      ...second.capabilities[0],
      root: 'scripts/second',
      entry: 'scripts/second.mjs',
      testRoot: 'packages/tests/repo/second',
      navigationMap: 'scripts/second/README.md',
    };
    writeFixture(
      fixture.root,
      'plans/second-plan.md',
      `# Second plan\n\n\`\`\`plan-adaptation-v1\n${JSON.stringify(second, null, 2)}\n\`\`\`\n`,
    );

    const ambiguous = runChecker(fixture, {
      includeBase: false,
      extraArgs: ['--navigation-evidence', 'example capability'],
    });
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stderr).toContain('ambiguous; supply --plan');

    const selected = runChecker(fixture, {
      includeBase: false,
      extraArgs: ['--navigation-evidence', 'example capability', '--plan', 'plans/fixture-plan.md'],
    });
    expect(selected.status, selected.stderr).toBe(0);
  });

  it('rejects evidence when the active plan facts are stale', () => {
    const fixture = navigationCommandFixture();
    writeFixture(
      fixture.root,
      'scripts/example/first.mjs',
      'export function firstResult() { return true; }\nexport const changed = true;\n',
    );

    const result = runChecker(fixture, {
      includeBase: false,
      extraArgs: ['--navigation-evidence', 'example capability'],
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('computed facts are stale');
  });

  it('rejects facts that change after evidence contents are captured', () => {
    const fixture = navigationCommandFixture();

    expect(() =>
      readRepositoryNavigationEvidence({
        repoRoot: fixture.root,
        owner: 'example capability',
        afterEvidenceComposed() {
          writeFixture(
            fixture.root,
            'packages/tests/repo/example/first.test.ts',
            'export const changedAfterCapture = true;\n',
          );
        },
      }),
    ).toThrow(/computed facts changed while reading navigation evidence/u);
  });

  it('rejects every invalid canonical declaration class from one reconstructed fixture', () => {
    const fixture = navigationCommandFixture();
    const invalidDeclarations = [
      {
        label: 'unsupported source and invalid owned contracts',
        changes: {
          entry: 'scripts/example.css',
          testRoot: 'packages/tests/repo/missing',
          focusedCommand: 'npm run test:missing',
          factContracts: ['scripts/missing-contract.mjs'],
        },
        expected: [
          /unsupported language .css/u,
          /test root/u,
          /focused command/u,
          /fact contract/u,
        ],
      },
      {
        label: 'entry outside the owner',
        changes: { entry: 'scripts/missing.mjs' },
        expected: [/must be inside scripts\/example/u],
      },
    ] as const;

    for (const { label, changes, expected } of invalidDeclarations.toReversed()) {
      configureNavigationCommandFixture(fixture, changes);
      let message = '';
      try {
        readRepositoryNavigationEvidence({
          repoRoot: fixture.root,
          owner: 'example capability',
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      for (const pattern of expected) {
        expect(message, label).toMatch(pattern);
      }
    }
  });

  it('rejects schema-invalid active capability records before navigation composition', () => {
    const fixture = navigationCommandFixture({ controlFlowFamilies: [] });

    expect(() =>
      readRepositoryNavigationEvidence({
        repoRoot: fixture.root,
        owner: 'example capability',
      }),
    ).toThrow(/invalid adaptive plan record.*controlFlowFamilies/u);
  });

  it('executes every distinct stored scenario command and matches expected evidence', () => {
    const scenarios = JSON.parse(
      readFileSync('.agents/evaluations/organizing-repository-structure/v1/scenarios.json', 'utf8'),
    ) as EvaluationScenarios;
    const rubric = JSON.parse(
      readFileSync('.agents/evaluations/organizing-repository-structure/v1/rubric.json', 'utf8'),
    ) as EvaluationRubric;

    const outputByCommand = new Map<string, RepositoryNavigationEvidence>();
    for (const command of new Set(
      scenarios.scenarios.map(({ target }) => target.evidenceCommand),
    )) {
      const result = spawnSync('/bin/sh', ['-c', command], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      outputByCommand.set(command, JSON.parse(result.stdout) as RepositoryNavigationEvidence);
    }

    for (const scenario of scenarios.scenarios) {
      const expected = rubric.scenarioExpectations[scenario.id];
      expect(outputByCommand.get(scenario.target.evidenceCommand)).toEqual({
        schemaVersion: 'repository-navigation-evidence-v1',
        owner: scenario.target.capabilityOwner,
        root: scenario.target.repositoryPath,
        entry: withoutKind(expected.entry),
        results: expected.acceptedResults.map(withoutKind).sort(compareReference),
        failures: [withoutKind(expected.failure)],
        testRoot: expected.tests.path,
        focusedCommand: `npm run ${expected.focusedCommand.symbol}`,
        navigationMap: { state: 'present', path: expected.navigationMap.path },
        affectedCodeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    }
  });

  it('reuses an executable stored scenario command for the microtest target', () => {
    const microtest = JSON.parse(
      readFileSync(
        '.agents/evaluations/organizing-repository-structure/v1/microtests.json',
        'utf8',
      ),
    ) as MicrotestContract;

    const scenarios = JSON.parse(
      readFileSync('.agents/evaluations/organizing-repository-structure/v1/scenarios.json', 'utf8'),
    ) as EvaluationScenarios;

    expect(scenarios.scenarios).toContainEqual(
      expect.objectContaining({
        target: expect.objectContaining({
          repositoryPath: microtest.target.repositoryPath,
          capabilityOwner: microtest.target.capabilityOwner,
          evidenceCommand: microtest.target.evidenceCommand,
        }),
      }),
    );
  });
});

interface EvaluationScenarios {
  readonly scenarios: readonly {
    readonly id: string;
    readonly target: {
      readonly repositoryPath: string;
      readonly capabilityOwner: string;
      readonly evidenceCommand: string;
    };
  }[];
}

interface EvaluationRubric {
  readonly scenarioExpectations: Readonly<
    Record<
      string,
      {
        readonly entry: EvidenceReference;
        readonly acceptedResults: readonly EvidenceReference[];
        readonly failure: EvidenceReference;
        readonly tests: { readonly path: string };
        readonly focusedCommand: { readonly symbol: string };
        readonly navigationMap: { readonly path: string };
      }
    >
  >;
}

interface EvidenceReference {
  readonly kind: string;
  readonly path: string;
  readonly symbol: string;
}

interface MicrotestContract {
  readonly target: {
    readonly repositoryPath: string;
    readonly capabilityOwner: string;
    readonly evidenceCommand: string;
  };
}

interface RepositoryNavigationEvidence {
  readonly schemaVersion: string;
  readonly owner: string;
  readonly root: string;
  readonly entry: Readonly<{ path: string; symbol: string }>;
  readonly results: readonly Readonly<{ path: string; symbol: string }>[];
  readonly failures: readonly Readonly<{ path: string; symbol: string }>[];
  readonly testRoot: string;
  readonly focusedCommand: string;
  readonly navigationMap: Readonly<{ state: string; path: string }>;
  readonly affectedCodeDigest: string;
}

function withoutKind({ path: repositoryPath, symbol }: EvidenceReference) {
  return { path: repositoryPath, symbol };
}

function compareReference(
  left: Readonly<{ path: string; symbol: string }>,
  right: Readonly<{ path: string; symbol: string }>,
): number {
  return Buffer.compare(
    Buffer.from(`${left.path}\0${left.symbol}`),
    Buffer.from(`${right.path}\0${right.symbol}`),
  );
}

function navigationCommandFixture(capabilityChanges: Readonly<Record<string, unknown>> = {}) {
  const fixture = createRepositoryFixture();
  configureNavigationCommandFixture(fixture, capabilityChanges);
  return fixture;
}

function configureNavigationCommandFixture(
  fixture: Readonly<{ root: string; base: string }>,
  capabilityChanges: Readonly<Record<string, unknown>>,
): void {
  const entryPath =
    typeof capabilityChanges.entry === 'string' ? capabilityChanges.entry : 'scripts/example.mjs';
  writeFixture(
    fixture.root,
    entryPath,
    'export function runExample() { return true; }\n' +
      'export function toError(value) { return new Error(String(value)); }\n',
  );
  writeFixture(
    fixture.root,
    'scripts/example/first.mjs',
    'export function firstResult() { return true; }\n',
  );
  writeFixture(
    fixture.root,
    'scripts/example/README.md',
    `[entry](../${path.basename(entryPath)}#runExample)\n` +
      '[result](./first.mjs#firstResult)\n' +
      '```repository-navigation-v1\n' +
      `${JSON.stringify({
        version: 1,
        entry: { path: entryPath, symbol: 'runExample' },
        results: [{ path: 'scripts/example/first.mjs', symbol: 'firstResult' }],
        failures: [{ path: entryPath, symbol: 'toError' }],
      })}\n` +
      '```\n',
  );
  const record = createRecord();
  Object.assign(record.capabilities[0] as Record<string, unknown>, {
    navigationMap: 'scripts/example/README.md',
    ...capabilityChanges,
  });
  record.facts = computePlanFacts({
    repoRoot: fixture.root,
    base: fixture.base,
    changes: readChangedPaths(fixture.root, fixture.base),
    record,
    planPath: 'plans/fixture-plan.md',
  });
  writePlanRecord(fixture.root, record);
}
