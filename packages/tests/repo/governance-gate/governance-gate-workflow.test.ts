import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

describe('governance gate workflow', () => {
  it('runs the canonical local gate in a bounded reusable workflow', () => {
    const workflowPath = path.join(repoRoot, '.github/workflows/governance-gate.yml');

    const workflow = load(readFileSync(workflowPath, 'utf8'));

    expect(workflow).toMatchObject({
      name: 'Governance Gate',
      permissions: { contents: 'read', actions: 'read' },
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
            {
              name: 'Run governance gate',
              id: 'local-gate',
              'continue-on-error': true,
              env: {
                GH_TOKEN: '${{ github.token }}',
                GOVERNANCE_APP_SLUG: '${{ vars.GOVERNANCE_APP_SLUG }}',
              },
              run: 'npm run check:governance-gate',
            },
            expect.objectContaining({
              name: 'Resolve governance gate',
              id: 'resolution',
              if: '${{ always() }}',
              env: {
                GH_TOKEN: '${{ github.token }}',
                GOVERNANCE_APP_SLUG: '${{ vars.GOVERNANCE_APP_SLUG }}',
                LOCAL_GATE_OUTCOME: '${{ steps.local-gate.outcome }}',
              },
            }),
          ],
        },
      },
    });
    expect(workflow.on.workflow_call.outputs).toMatchObject({
      status: { value: '${{ jobs.governance-gate.outputs.status }}' },
      underlying_status: {
        value: '${{ jobs.governance-gate.outputs.underlying_status }}',
      },
      decision_id: { value: '${{ jobs.governance-gate.outputs.decision_id }}' },
    });
    const resolution = workflow.jobs['governance-gate'].steps.at(-1);
    expect(resolution.run).toContain('node scripts/governance-gate-resolution.mjs');
    expect(resolution.run).toContain('--current-run-attempt "$GITHUB_RUN_ATTEMPT"');
    expect(resolution.run).toContain('--gate-name "Governance Gate / Governance Gate"');
  });

  it('binds every phase to the real owner-focused package command', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts).toMatchObject({
      'check:repo-structure': 'node scripts/repo-structure-check.mjs',
      'check:repo-style': 'node scripts/repo-style-check.mjs --cognitive-metrics',
      'check:retained-legacy':
        'node scripts/review-legacy.mjs origin/main HEAD --registry docs/production-legacy-exceptions.md',
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
