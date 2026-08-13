import { chmodSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  computeAffectedCodeDigest,
  readChangedPaths,
} from '../../../../scripts/plan-adaptation/plan-change-facts.mjs';

import {
  cleanupRepositoryFixtures,
  createRecord,
  createRepositoryFixture,
  fixtureScripts,
  runChecker,
  runGit,
  writeFixture,
  writePlanRecord,
} from './repository-structure-command-fixture.ts';

afterEach(cleanupRepositoryFixtures);

describe('repository structure command', () => {
  it('validates a live guidance capability without treating Markdown or JSON as code', () => {
    const fixture = createGuidanceRepositoryFixture();
    writeGuidancePlanRecord(fixture.root);

    const result = runChecker(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('activates a planned guidance router without creating a skill or authored-code topology', () => {
    const fixture = createGuidanceRouterRepositoryFixture();
    const record = createRecord();
    record.checkpoint.nextSlices = ['fixture-slice', 'general-guidance-routing-declaration'];
    const router = guidanceRouterCapability({
      activation: {
        state: 'planned',
        slice: 'general-guidance-routing-declaration',
      },
    });
    record.capabilities.push(router);
    writePlanRecord(fixture.root, record);

    const planned = runChecker(fixture);

    expect(planned.status, `${planned.stdout}\n${planned.stderr}`).toBe(0);

    delete router.activation;
    writePlanRecord(fixture.root, record);
    const active = runChecker(fixture);

    expect(active.status, `${active.stdout}\n${active.stderr}`).toBe(0);
    expect(active.stdout).not.toContain('topology.singleton-subtree');
  });

  it('requires live code contract inventory without treating its workflow path as topology', () => {
    const fixture = createRepositoryFixture();
    const record = createRecord();
    record.capabilities[0].contractPaths = ['.github/workflows/example-governance.yml'];
    writePlanRecord(fixture.root, record);

    const missing = runChecker(fixture);

    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain(
      'example capability contract path .github/workflows/example-governance.yml does not resolve',
    );

    writeFixture(
      fixture.root,
      '.github/workflows/example-governance.yml',
      'name: Example governance\n',
    );

    const resolved = runChecker(fixture);

    expect(resolved.status, `${resolved.stdout}\n${resolved.stderr}`).toBe(0);
    expect(resolved.stdout).not.toContain('topology.');
  });

  it.each(['deleted', 'unreadable', 'symlink'])(
    'fails closed when a declared code contract is %s',
    (state) => {
      const contractPath = '.github/workflows/example-governance.yml';
      const fixture = createRepositoryFixture({
        [contractPath]: 'name: Example governance\n',
      });
      const record = createRecord();
      record.capabilities[0].contractPaths = [contractPath];
      const absolutePath = path.join(fixture.root, contractPath);
      if (state === 'deleted') {
        rmSync(absolutePath);
      } else if (state === 'unreadable') {
        chmodSync(absolutePath, 0o000);
      } else {
        rmSync(absolutePath);
        symlinkSync('../../../package.json', absolutePath);
      }
      writePlanRecord(fixture.root, record);

      try {
        const result = runChecker(fixture);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
          `example capability contract path ${contractPath} does not resolve`,
        );
      } finally {
        if (state === 'unreadable') {
          chmodSync(absolutePath, 0o644);
        }
      }
    },
  );

  it('ignores unrelated deleted, unreadable, and symlink repository inventory entries', () => {
    const fixture = createGuidanceRepositoryFixture({
      'notes/tracked-deleted.md': 'delete me\n',
    });
    rmSync(path.join(fixture.root, 'notes/tracked-deleted.md'));
    writeFixture(fixture.root, 'notes/unreadable.md', 'unreadable\n');
    chmodSync(path.join(fixture.root, 'notes/unreadable.md'), 0o000);
    writeFixture(fixture.root, 'notes/symlink-target.md', 'target\n');
    symlinkSync('symlink-target.md', path.join(fixture.root, 'notes/unrelated-link.md'));
    writeGuidancePlanRecord(fixture.root);

    const result = runChecker(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('does not accept a guidance symlink or unreadable evaluation as declaration evidence', () => {
    const fixture = createGuidanceRepositoryFixture({
      '.agents/evaluations/adaptive-agent-execution/v1/scenarios.json': '',
    });
    const skillEntry = path.join(fixture.root, '.agents/skills/adaptive-plan-execution/SKILL.md');
    rmSync(skillEntry);
    symlinkSync('../../../notes/missing-skill.md', skillEntry);
    chmodSync(
      path.join(fixture.root, '.agents/evaluations/adaptive-agent-execution/v1/rubric.json'),
      0o000,
    );
    rmSync(
      path.join(fixture.root, '.agents/evaluations/adaptive-agent-execution/v1/scenarios.json'),
    );
    writeGuidancePlanRecord(fixture.root);

    const result = runChecker(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain(
      'adaptive plan execution guidance skill entry ' +
        '.agents/skills/adaptive-plan-execution/SKILL.md does not resolve',
    );
    expect(result.stdout).toContain(
      'adaptive plan execution guidance evaluation root ' +
        '.agents/evaluations/adaptive-agent-execution/v1 contains no repository files',
    );
  });

  it('rejects a new authored-code subtree with one code descendant', () => {
    const fixture = createRepositoryFixture();
    writeFixture(fixture.root, 'apps/new-feature/only-module.ts', 'export const value = true;\n');

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/new-feature [topology.singleton-subtree]');
  });

  it('accepts an exact digest-bound active-plan disposition for a singleton subtree', () => {
    const fixture = createRepositoryFixture();
    const target = 'apps/new-feature';
    const descendant = `${target}/only-module.ts`;
    writeFixture(fixture.root, descendant, 'export const value = true;\n');
    const record = createRecord();
    const affectedCodeDigest = computeAffectedCodeDigest({
      repoRoot: fixture.root,
      changes: readChangedPaths(fixture.root, fixture.base),
      record,
    });
    (record.facts as Record<string, unknown>).affectedCodeDigest = affectedCodeDigest;
    (record.structuralDispositions as Array<Record<string, unknown>>).push({
      kind: 'current-fact',
      ruleId: 'topology.singleton-subtree',
      target,
      identity: descendant,
      magnitude: 1,
      affectedCodeDigest,
      disposition: 'keep',
      rationale: 'This executable is one coherent capability owner at the exact candidate tree.',
    });
    writePlanRecord(fixture.root, record);

    const result = runChecker(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('defers planned code and guidance surfaces until source-record activation', () => {
    const fixture = createRepositoryFixture();
    writeFixture(
      fixture.root,
      'package.json',
      JSON.stringify({
        scripts: {
          ...fixtureScripts(),
          'test:future-code': 'vitest run packages/tests/future-code',
          'test:future-guidance': 'vitest run packages/tests/repo/future-guidance',
        },
      }),
    );
    writeFixture(fixture.root, 'apps/future-code/entry.ts', 'export const future = true;\n');
    const planned = createRecord();
    planned.checkpoint.nextSlices = ['fixture-slice', 'future-owner'];
    planned.capabilities.push(
      {
        owner: 'future code',
        root: 'apps/future-code',
        entry: 'apps/future-code/entry.ts',
        testRoot: 'packages/tests/future-code',
        focusedCommand: 'npm run test:future-code',
        navigationMap: null,
        factContracts: [],
        controlFlowFamilies: ['future behavior'],
        activation: { state: 'planned', slice: 'future-owner' },
      },
      {
        kind: 'guidance',
        owner: 'future guidance',
        skillRoot: '.agents/skills/future-guidance',
        skillEntry: '.agents/skills/future-guidance/SKILL.md',
        contractTestRoot: 'packages/tests/repo/future-guidance',
        focusedCommand: 'npm run test:future-guidance',
        evaluationRoot: '.agents/evaluations/future-guidance/v1',
        contractPaths: ['.codex-plugin/plugin.json'],
        activation: { state: 'planned', slice: 'future-owner' },
      },
    );
    writePlanRecord(fixture.root, planned);

    const deferred = runChecker(fixture);

    expect(deferred.status, `${deferred.stdout}\n${deferred.stderr}`).toBe(0);

    writeFixture(fixture.root, 'packages/tests/future-code/entry.test.ts', 'export {};\n');
    writeFixture(fixture.root, '.agents/skills/future-guidance/SKILL.md', '# Future guidance\n');
    writeFixture(fixture.root, 'packages/tests/repo/future-guidance/entry.test.ts', 'export {};\n');
    writeFixture(fixture.root, '.agents/evaluations/future-guidance/v1/rubric.json', '{}\n');
    writeFixture(fixture.root, '.codex-plugin/plugin.json', '{}\n');
    for (const capability of planned.capabilities.slice(1)) {
      delete capability.activation;
    }
    writePlanRecord(fixture.root, planned);
    const activated = runChecker(fixture);

    expect(activated.status).toBe(1);
    expect(activated.stdout).toContain('apps/future-code [topology.singleton-subtree]');
    expect(activated.stdout).toContain(
      'packages/tests/repo/future-guidance [topology.singleton-subtree]',
    );
  });

  it('rejects broad planned roots that overlap active or planned owners', () => {
    const fixture = createRepositoryFixture();
    const record = createRecord();
    record.checkpoint.nextSlices = ['fixture-slice', 'future-owner'];
    record.capabilities.push(
      plannedCodeCapability({ owner: 'broad planned owner', root: 'scripts' }),
      plannedCodeCapability({
        owner: 'nested planned owner',
        root: 'scripts/future-owner',
        entry: 'scripts/future-owner/entry.mjs',
        testRoot: 'packages/tests/repo/future-owner',
      }),
    );
    writePlanRecord(fixture.root, record);

    const result = runChecker(fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'planned capability broad planned owner root scripts overlaps active capability example capability root scripts/example',
    );
    expect(result.stderr).toContain(
      'planned capability broad planned owner root scripts overlaps planned capability nested planned owner root scripts/future-owner',
    );
  });

  it('keeps the active endpoint of a cross-boundary rename under topology enforcement', () => {
    const activeSourceFixture = createRepositoryFixture({
      'apps/active-owner/stays.ts': 'export const stays = true;\n',
      'apps/active-owner/moves.ts': 'export const moves = true;\n',
    });
    const record = createRecord();
    record.checkpoint.nextSlices = ['fixture-slice', 'future-owner'];
    record.capabilities.push(
      plannedCodeCapability({
        owner: 'future owner',
        root: 'apps/future-owner',
        entry: 'apps/future-owner/entry.ts',
        testRoot: 'packages/tests/future-owner',
      }),
    );
    writePlanRecord(activeSourceFixture.root, record);
    writeFixture(activeSourceFixture.root, 'apps/future-owner/.keep', '');
    runGit(activeSourceFixture.root, [
      'mv',
      'apps/active-owner/moves.ts',
      'apps/future-owner/moves.ts',
    ]);

    const activeToPlanned = runChecker(activeSourceFixture);

    expect(activeToPlanned.status).toBe(1);
    expect(activeToPlanned.stdout).toContain('apps/active-owner [topology.singleton-subtree]');

    const activeTargetFixture = createRepositoryFixture({
      'apps/future-owner/moves.ts': 'export const moves = true;\n',
    });
    writePlanRecord(activeTargetFixture.root, record);
    writeFixture(activeTargetFixture.root, 'apps/active-destination/.keep', '');
    runGit(activeTargetFixture.root, [
      'mv',
      'apps/future-owner/moves.ts',
      'apps/active-destination/moves.ts',
    ]);

    const plannedToActive = runChecker(activeTargetFixture);

    expect(plannedToActive.status).toBe(1);
    expect(plannedToActive.stdout).toContain(
      'apps/active-destination [topology.singleton-subtree]',
    );
  });

  it('uses the active plan diff base when no base option is supplied', () => {
    const fixture = createRepositoryFixture();
    writeFixture(fixture.root, 'apps/new-feature/only-module.ts', 'export const value = true;\n');

    const result = runChecker(fixture, false);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/new-feature [topology.singleton-subtree]');
    expect(result.stderr).not.toContain('origin/main');
  });

  it('rejects a new one-child directory chain with multiple leaf modules', () => {
    const fixture = createRepositoryFixture();
    writeFixture(
      fixture.root,
      'apps/new-feature/internal/first.ts',
      'export const first = true;\n',
    );
    writeFixture(
      fixture.root,
      'apps/new-feature/internal/second.ts',
      'export const second = true;\n',
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'apps/new-feature -> apps/new-feature/internal [topology.redundant-chain]',
    );
  });

  it('activates existing singleton debt when its code changes materially', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts': 'export const value = true;\n',
    });
    writeFixture(
      fixture.root,
      'apps/legacy-feature/only-module.ts',
      'export const value = false;\n',
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/legacy-feature [topology.singleton-subtree]');
    expect(result.stdout).toContain('Materially changed');
  });

  it('does not block narrow work because an unrelated singleton already exists', () => {
    const fixture = createRepositoryFixture({
      'apps/unrelated-legacy/only-module.ts': 'export const legacy = true;\n',
    });
    writeFixture(fixture.root, 'apps/example/first.ts', 'export const first = false;\n');

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('does not activate existing singleton debt for formatting-only changes', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts': 'export const value=true;\n',
    });
    writeFixture(
      fixture.root,
      'apps/legacy-feature/only-module.ts',
      'export const value = true;\n',
    );

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('does not activate existing singleton debt for a comment-only spelling correction', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts':
        '// Return teh stable value.\nexport const value = true;\n',
    });
    writeFixture(
      fixture.root,
      'apps/legacy-feature/only-module.ts',
      '// Return the stable value.\nexport const value = true;\n',
    );

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('requires a disposition when material work activates existing density debt', () => {
    const denseFiles = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        `apps/dense-legacy/module-${index}.ts`,
        `export const value${index} = true;\n`,
      ]),
    );
    const fixture = createRepositoryFixture(denseFiles);
    writeFixture(fixture.root, 'apps/dense-legacy/module-0.ts', 'export const value0 = false;\n');

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'apps/dense-legacy [layout.directory-density] requires an explicit ' +
        'keep/split/move/consolidate disposition',
    );
  });

  it('does not activate existing singleton debt for a path-only subtree rename', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts': 'export const value = true;\n',
    });
    runGit(fixture.root, ['mv', 'apps/legacy-feature', 'apps/renamed-feature']);

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('classifies path-only renames with control characters through NUL-safe Git records', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only\tmodule.ts': 'export const value = true;\n',
    });
    runGit(fixture.root, ['mv', 'apps/legacy-feature', 'apps/renamed-feature']);

    const result = runChecker(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('activates renamed singleton debt when the moved code also changes', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts': 'export const value = true;\n',
    });
    runGit(fixture.root, ['mv', 'apps/legacy-feature', 'apps/renamed-feature']);
    writeFixture(
      fixture.root,
      'apps/renamed-feature/only-module.ts',
      'export const value = false;\n',
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/renamed-feature [topology.singleton-subtree]');
  });

  it('does not apply production singleton exceptions to test topology', () => {
    const fixture = createRepositoryFixture();
    writeFixture(fixture.root, 'packages/tests/repo/approved-test/only.test.ts', 'export {};\n');
    writeFixture(
      fixture.root,
      'docs/repo-structure-exceptions.json',
      `${JSON.stringify({
        version: 2,
        exceptions: [
          {
            ruleId: 'topology.singleton-subtree',
            target: 'packages/tests/repo/approved-test',
            owner: 'Repository maintainers',
            reviewOrRemovalCondition: 'Remove when a second test exists.',
            approval: {
              reviewId: 101,
              reviewerLogin: 'fixture-human',
              approvedAt: '2026-08-12T10:00:00Z',
            },
          },
        ],
      })}\n`,
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'packages/tests/repo/approved-test [topology.singleton-subtree]',
    );
  });
});

function createGuidanceRepositoryFixture(extraFiles: Record<string, string> = {}) {
  return createRepositoryFixture({
    'package.json': JSON.stringify({
      scripts: {
        ...fixtureScripts(),
        'test:adaptive-plan-execution': 'vitest run packages/tests/repo/adaptive-agent-execution',
      },
    }),
    '.agents/skills/adaptive-plan-execution/SKILL.md': '# Adaptive Plan Execution\n',
    '.agents/skills/adaptive-plan-execution/agents/openai.yaml': 'interface: {}\n',
    '.agents/evaluations/adaptive-agent-execution/v1/rubric.json': '{}\n',
    '.agents/evaluations/adaptive-agent-execution/v1/scenarios.json': '{}\n',
    'packages/tests/repo/adaptive-agent-execution/first.test.ts': 'export {};\n',
    'packages/tests/repo/adaptive-agent-execution/second.test.ts': 'export {};\n',
    'packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts': 'export {};\n',
    ...extraFiles,
  });
}

function createGuidanceRouterRepositoryFixture(extraFiles: Record<string, string> = {}) {
  return createRepositoryFixture({
    'package.json': JSON.stringify({
      scripts: {
        ...fixtureScripts(),
        'test:general-agent-guidance': 'vitest run packages/tests/repo/general-agent-guidance',
      },
    }),
    'AGENTS.md': '# Rallar Agent Guide\n',
    'packages/tests/repo/general-agent-guidance/contract.test.ts': 'export {};\n',
    'packages/tests/repo/general-agent-guidance/evaluation-v1.json': '{}\n',
    '.agents/skills/adaptive-plan-execution/SKILL.md': '# Adaptive Plan Execution\n',
    '.agents/skills/organizing-repository-structure/SKILL.md': '# Repository Structure\n',
    ...extraFiles,
  });
}

function guidanceRouterCapability(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'guidance',
    guidanceRole: 'router',
    owner: 'general agent guidance',
    routingEntry: 'AGENTS.md',
    contractTestRoot: 'packages/tests/repo/general-agent-guidance',
    focusedCommand: 'npm run test:general-agent-guidance',
    evaluationRoot: null,
    contractPaths: [
      '.agents/skills/adaptive-plan-execution/SKILL.md',
      '.agents/skills/organizing-repository-structure/SKILL.md',
    ],
    ...overrides,
  };
}

function writeGuidancePlanRecord(root: string): void {
  const record = createRecord();
  record.capabilities.push({
    kind: 'guidance',
    owner: 'adaptive plan execution guidance',
    skillRoot: '.agents/skills/adaptive-plan-execution',
    skillEntry: '.agents/skills/adaptive-plan-execution/SKILL.md',
    contractTestRoot: 'packages/tests/repo/adaptive-agent-execution',
    focusedCommand: 'npm run test:adaptive-plan-execution',
    evaluationRoot: '.agents/evaluations/adaptive-agent-execution/v1',
    contractPaths: ['packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts'],
  });
  writePlanRecord(root, record);
}

function plannedCodeCapability(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'future owner',
    root: 'apps/future-owner',
    entry: 'apps/future-owner/entry.ts',
    testRoot: 'packages/tests/future-owner',
    focusedCommand: 'npm run test:future-owner',
    navigationMap: null,
    factContracts: [],
    controlFlowFamilies: ['future behavior'],
    activation: { state: 'planned', slice: 'future-owner' },
    ...overrides,
  };
}
