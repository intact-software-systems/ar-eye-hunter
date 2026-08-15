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
      permissions: { contents: 'read' },
      on: {
        workflow_call: {
          inputs: {
            candidate_ref: { required: true, type: 'string' },
          },
        },
      },
      jobs: {
        'governance-gate': {
          name: 'Governance Gate',
          'runs-on': 'ubuntu-latest',
          'timeout-minutes': 2,
          steps: [
            {
              uses: 'actions/checkout@v7',
              with: { ref: '${{ inputs.candidate_ref }}', 'fetch-depth': 0 },
            },
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
    expect(workflow.on.workflow_call.outputs).toBeUndefined();
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

  it('passes the exact deployment revision to the required release-gate input', () => {
    const deployWorkflowPath = path.join(repoRoot, '.github/workflows/deploy.yml');
    const releaseGateWorkflowPath = path.join(repoRoot, '.github/workflows/release-gate.yml');

    const deployWorkflow = load(readFileSync(deployWorkflowPath, 'utf8'));
    const releaseGateWorkflow = load(readFileSync(releaseGateWorkflowPath, 'utf8'));

    expect(releaseGateWorkflow).toMatchObject({
      on: {
        workflow_call: {
          inputs: {
            candidate_ref: { required: true, type: 'string' },
          },
        },
      },
    });
    expect(deployWorkflow).toMatchObject({
      jobs: {
        'release-gate': {
          uses: './.github/workflows/release-gate.yml',
          with: { candidate_ref: '${{ github.sha }}' },
        },
      },
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
          with: { candidate_ref: '${{ github.event.pull_request.head.sha }}' },
        },
        'release-gate': {
          name: 'Release Gate',
          needs: ['governance-gate', 'validation-evidence'],
          uses: './.github/workflows/release-gate.yml',
          with: {
            candidate_ref: '${{ github.event.pull_request.head.sha }}',
            changed_repo_style_base: '${{ github.event.pull_request.base.sha }}',
          },
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
