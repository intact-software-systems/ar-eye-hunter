import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { validateGovernanceGateCommands } from '../../../../scripts/governance-gate/governance-gate-phases.mjs';

const repoRoot = path.resolve(__dirname, '../../../..');
const commandEntry = path.join(repoRoot, 'scripts/governance-gate.mjs');
const fixtureRoots: string[] = [];
const requiredPhaseCommands = {
  'check:repo-structure': ['repo-structure', 0],
  'check:repo-style': ['repo-style', 0],
  'check:retained-legacy': ['retained-legacy', 0],
} as const;

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('governance gate command', () => {
  it('runs each canonical governance phase and reports one ordered result per owner', () => {
    const fixtureRoot = createFixture(requiredPhaseCommands);

    const result = runCommand(fixtureRoot);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'PASS: governance gate repo-structure',
      'PASS: governance gate repo-style',
      'retained-legacy fixture success',
      'PASS: governance gate retained-legacy',
      'PASS: governance gate (3 phases)',
    ]);
    expect(readExecutedPhases(fixtureRoot).sort()).toEqual([
      'repo-structure',
      'repo-style',
      'retained-legacy',
    ]);
  });

  it('bounds successful advisory output and points to the complete retained-legacy report', () => {
    const fixtureRoot = createFixture({
      ...requiredPhaseCommands,
      'check:retained-legacy': ['retained-legacy-large', 0],
    });

    const result = runCommand(fixtureRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('retained-legacy-large fixture success');
    expect(result.stdout).toContain(
      'TRUNCATED: successful advisory output exceeded 32,000 characters; ' +
        'run npm run check:retained-legacy for the complete report.',
    );
    expect(result.stdout).not.toContain('end-of-large-advisory');
    const advisoryStart = result.stdout.indexOf('retained-legacy-large fixture success');
    const advisoryEnd = result.stdout.indexOf('\nPASS: governance gate retained-legacy');
    expect(result.stdout.slice(advisoryStart, advisoryEnd)).toHaveLength(32_000);
  });

  it('fails before execution when a canonical package command is missing', () => {
    const fixtureRoot = createFixture({
      'check:repo-structure': ['repo-structure', 0],
    });

    const result = runCommand(fixtureRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: governance gate configuration: repo-style: missing package script check:repo-style',
    );
    expect(existsSync(path.join(fixtureRoot, 'executed-phases.txt'))).toBe(false);
  });

  it.each([
    ['repo-structure', 'check:repo-structure'],
    ['repo-style', 'check:repo-style'],
    ['retained-legacy', 'check:retained-legacy'],
  ] as const)('attributes a non-zero %s result to its canonical command', (phase, command) => {
    const commands = { ...requiredPhaseCommands, [command]: [phase, 7] as const };
    const fixtureRoot = createFixture(commands);

    const result = runCommand(fixtureRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`FAIL: governance gate ${phase} (${command})`);
    expect(result.stderr).toContain(`${phase} fixture failure`);
    expect(result.stderr).not.toContain('fixture success');
  });

  it.each([
    ['test command', 'test:repo-style', 'vitest run packages/tests/repo'],
    ['retired plan tooling', 'check:repo-style', 'node scripts/plan-adaptation.mjs check'],
    ['retired PR evidence tooling', 'check:repo-style', 'node scripts/pr-human-review.mjs'],
    [
      'legacy evidence lifecycle',
      'check:repo-style',
      'node scripts/review-legacy.mjs --output result.json',
    ],
    ['governance mutation', 'check:repo-style', 'npm run governance:decide'],
    ['GitHub network access', 'check:repo-style', 'gh api repos/example/project'],
    ['mutable output', 'check:repo-style', 'node scripts/check.mjs --output result.json'],
  ])('rejects a %s phase before executing anything', (_name, command, script) => {
    const fixtureRoot = createFixture({
      [command]: ['repo-style', 0],
    });
    const packageJsonPath = path.join(fixtureRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    packageJson.scripts[command] = script;
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson)}\n`);

    expect(() =>
      validateGovernanceGateCommands(fixtureRoot, [{ phase: 'unsafe', command }]),
    ).toThrow(/unsafe:/u);
    expect(existsSync(path.join(fixtureRoot, 'executed-phases.txt'))).toBe(false);
  });
});

function createFixture(commands: Readonly<Record<string, readonly [string, number]>>): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'rallar-governance-gate-'));
  fixtureRoots.push(fixtureRoot);
  writeFileSync(
    path.join(fixtureRoot, 'phase-command.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      'const [phase, status] = process.argv.slice(2);',
      "appendFileSync('executed-phases.txt', `${phase}\\n`);",
      "if (phase === 'retained-legacy-large') {",
      "  console.log(`${phase} fixture success ${'x'.repeat(33_000)} end-of-large-advisory`);",
      '} else {',
      "  console.log(status === '0' ? `${phase} fixture success` : `${phase} fixture failure`);",
      '}',
      'process.exitCode = Number(status);',
    ].join('\n'),
  );
  const scripts = Object.fromEntries(
    Object.entries(commands).map(([command, [phase, status]]) => [
      command,
      `node phase-command.mjs ${phase} ${status}`,
    ]),
  );
  writeFileSync(
    path.join(fixtureRoot, 'package.json'),
    `${JSON.stringify({ name: 'governance-gate-fixture', private: true, type: 'module', scripts })}\n`,
  );
  return fixtureRoot;
}

function runCommand(fixtureRoot: string) {
  return spawnSync(process.execPath, [commandEntry, '--repo-root', fixtureRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function readExecutedPhases(fixtureRoot: string): string[] {
  return readFileSync(path.join(fixtureRoot, 'executed-phases.txt'), 'utf8')
    .split('\n')
    .filter(Boolean);
}
