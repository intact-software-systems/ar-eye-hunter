import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const commandPath = path.join(repoRoot, 'scripts/distributed-validation-risk.mjs');

describe('distributed validation risk command', () => {
  it('writes stable machine-readable output for an unrelated push', () => {
    const fixture = createGitFixture();
    const outputPath = path.join(fixture.root, 'decision.env');

    execFileSync(process.execPath, [
      commandPath,
      'select',
      '--repo-root',
      fixture.root,
      '--event-name',
      'push',
      '--base',
      fixture.base,
      '--head',
      fixture.head,
      '--output',
      outputPath,
    ]);

    expect(readFileSync(outputPath, 'utf8')).toBe(
      [
        'selected=false',
        'reason_code=no-distributed-risk',
        'reason=Distributed validation not selected: no distributed-risk paths.',
        'risk_families_json=[]',
        'risk_paths_json=[]',
        '',
      ].join('\n'),
    );
  });

  it('manual dispatch selects without a usable comparison range', () => {
    const outputPath = path.join(
      mkdtempSync(path.join(tmpdir(), 'distributed-risk-manual-')),
      'out',
    );

    const output = execFileSync(
      process.execPath,
      [
        commandPath,
        'select',
        '--repo-root',
        repoRoot,
        '--event-name',
        'workflow_dispatch',
        '--base',
        '',
        '--head',
        '',
        '--output',
        outputPath,
      ],
      { encoding: 'utf8' },
    );

    expect(output).toContain('SELECTED: workflow_dispatch operator override.');
    expect(readFileSync(outputPath, 'utf8')).toContain('reason_code=manual-override');
  });

  it('keeps runtime classifier failures visible instead of converting them to a skip', () => {
    const outputPath = path.join(mkdtempSync(path.join(tmpdir(), 'distributed-risk-fail-')), 'out');
    const result = spawnSync(
      process.execPath,
      [
        commandPath,
        'select',
        '--repo-root',
        repoRoot,
        '--event-name',
        'push',
        '--base',
        'not-a-commit',
        '--head',
        'also-not-a-commit',
        '--output',
        outputPath,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL: distributed validation risk:');
  });

  it.each([
    {
      selected: 'false',
      selection: 'success',
      preflight: 'skipped',
      prepare: 'skipped',
      run: 'skipped',
      status: 0,
    },
    {
      selected: 'true',
      selection: 'success',
      preflight: 'success',
      prepare: 'success',
      run: 'success',
      status: 0,
    },
    {
      selected: 'false',
      selection: 'failure',
      preflight: 'skipped',
      prepare: 'skipped',
      run: 'skipped',
      status: 1,
    },
    {
      selected: '',
      selection: 'success',
      preflight: 'skipped',
      prepare: 'skipped',
      run: 'skipped',
      status: 1,
    },
    {
      selected: 'invalid',
      selection: 'success',
      preflight: 'skipped',
      prepare: 'skipped',
      run: 'skipped',
      status: 1,
    },
    {
      selected: 'true',
      selection: 'success',
      preflight: 'success',
      prepare: 'failure',
      run: 'skipped',
      status: 1,
    },
    {
      selected: 'false',
      selection: 'success',
      preflight: 'success',
      prepare: 'skipped',
      run: 'skipped',
      status: 1,
    },
  ])('concludes required workflow truth for %#', (scenario) => {
    const result = spawnSync(process.execPath, [
      commandPath,
      'conclude',
      '--selected',
      scenario.selected,
      '--selection-result',
      scenario.selection,
      '--preflight-result',
      scenario.preflight,
      '--prepare-result',
      scenario.prepare,
      '--run-result',
      scenario.run,
    ]);

    expect(result.status).toBe(scenario.status);
  });
});

function createGitFixture(): {
  readonly root: string;
  readonly base: string;
  readonly head: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'distributed-risk-git-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs/operator-guide.md'), 'version one\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: root });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(path.join(root, 'docs/operator-guide.md'), 'version two\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'head'], { cwd: root });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, base, head };
}
