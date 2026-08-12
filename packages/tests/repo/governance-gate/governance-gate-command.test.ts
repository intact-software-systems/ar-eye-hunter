import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const commandEntry = path.join(repoRoot, 'scripts/governance-gate.mjs');
const fixtureRoots: string[] = [];
const requiredPhaseCommands = {
  'check:plan-adaptation': ['adaptive-plan', 0],
  'check:repo-structure': ['repo-structure', 0],
  'test:pr-human-review': ['pr-review-v2', 0],
  'test:adaptive-governance': ['focused-contracts', 0],
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
      'PASS: governance gate adaptive-plan',
      'PASS: governance gate repo-structure',
      'PASS: governance gate pr-review-v2',
      'PASS: governance gate focused-contracts',
      'PASS: governance gate (4 phases)',
    ]);
    expect(readExecutedPhases(fixtureRoot).sort()).toEqual([
      'adaptive-plan',
      'focused-contracts',
      'pr-review-v2',
      'repo-structure',
    ]);
  });

  it('fails before execution when a canonical package command is missing', () => {
    const fixtureRoot = createFixture({
      'check:plan-adaptation': ['adaptive-plan', 0],
      'check:repo-structure': ['repo-structure', 0],
      'test:adaptive-governance': ['focused-contracts', 0],
    });

    const result = runCommand(fixtureRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: governance gate configuration: pr-review-v2: ' +
        'missing package script test:pr-human-review',
    );
    expect(existsSync(path.join(fixtureRoot, 'executed-phases.txt'))).toBe(false);
  });

  it.each([
    ['adaptive-plan', 'check:plan-adaptation'],
    ['repo-structure', 'check:repo-structure'],
    ['pr-review-v2', 'test:pr-human-review'],
    ['focused-contracts', 'test:adaptive-governance'],
  ] as const)('attributes a non-zero %s result to its canonical command', (phase, command) => {
    const commands = { ...requiredPhaseCommands, [command]: [phase, 7] as const };
    const fixtureRoot = createFixture(commands);

    const result = runCommand(fixtureRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`FAIL: governance gate ${phase} (${command})`);
    expect(result.stderr).toContain(`${phase} fixture failure`);
    expect(result.stderr).not.toContain('fixture success');
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
      "console.log(status === '0' ? `${phase} fixture success` : `${phase} fixture failure`);",
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
