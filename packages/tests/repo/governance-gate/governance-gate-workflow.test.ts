import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

describe('governance gate workflow', () => {
  it('runs the canonical local gate in a bounded reusable workflow', () => {
    const workflowPath = path.join(repoRoot, '.github/workflows/governance-gate.yml');

    const workflow = load(readFileSync(workflowPath, 'utf8'));

    expect(workflow).toEqual({
      name: 'Governance Gate',
      on: { workflow_call: null },
      permissions: { contents: 'read' },
      jobs: {
        'governance-gate': {
          name: 'Governance Gate',
          'runs-on': 'ubuntu-latest',
          'timeout-minutes': 2,
          steps: [
            { uses: 'actions/checkout@v7', with: { 'fetch-depth': 0 } },
            {
              uses: 'actions/setup-node@v7',
              with: { 'node-version': 24, cache: 'npm' },
            },
            { name: 'Install dependencies', run: 'npm ci --ignore-scripts' },
            { name: 'Run governance gate', run: 'npm run check:governance-gate' },
          ],
        },
      },
    });
  });

  it('binds every phase to the real owner-focused package command', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts).toMatchObject({
      'check:plan-adaptation': 'node scripts/plan-adaptation.mjs check',
      'check:repo-structure': 'node scripts/repo-structure-check.mjs',
      'test:pr-human-review': 'vitest run packages/tests/repo/pr-human-review',
      'test:adaptive-governance':
        'vitest run --maxWorkers=4 packages/tests/repo/plan-adaptation ' +
        'packages/tests/repo/repo-structure-check',
    });
  });

  it('makes the broad branch release job depend on governance without copying checks', () => {
    const workflowPath = path.join(repoRoot, '.github/workflows/branch-release-gate.yml');

    const workflow = load(readFileSync(workflowPath, 'utf8'));

    expect(workflow).toMatchObject({
      jobs: {
        'governance-gate': {
          name: 'Governance Gate',
          uses: './.github/workflows/governance-gate.yml',
        },
        'release-gate': {
          name: 'Release Gate',
          needs: ['governance-gate', 'validation-evidence'],
          uses: './.github/workflows/release-gate.yml',
          with: { changed_repo_style_base: 'origin/main' },
        },
      },
    });
    expect(workflow.jobs['validation-evidence']).toMatchObject({
      needs: 'governance-gate',
    });
    const branchSource = readFileSync(workflowPath, 'utf8');
    expect(branchSource).not.toContain('npm run check:plan-adaptation');
    expect(branchSource).not.toContain('npm run check:repo-structure');
    expect(branchSource).not.toContain('npm run test:pr-human-review');
  });
});
