import { chmodSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
