import { readFileSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

describe('content-sensitive Branch Release Gate', () => {
  it('selects trusted prior evidence only after governance and falls back to the broad gate', () => {
    const workflow = readWorkflow();

    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.jobs['governance-gate']).toMatchObject({
      name: 'Governance Gate',
      uses: './.github/workflows/governance-gate.yml',
    });
    expect(workflow.jobs['validation-evidence']).toMatchObject({
      name: 'Select validation evidence',
      needs: 'governance-gate',
      outputs: {
        reuse: '${{ steps.resolution.outputs.reuse }}',
        build_tree_digest: '${{ steps.resolution.outputs.build_tree_digest }}',
      },
    });
    const selectionSteps = workflow.jobs['validation-evidence'].steps;
    const selection = selectionSteps.find(
      (step: Record<string, any>) => step.name === 'Select reusable validation evidence',
    );
    expect(selection).toMatchObject({
      id: 'selection',
      'continue-on-error': true,
      env: { GH_TOKEN: '${{ github.token }}' },
    });
    expect(selection.run).toContain('node scripts/validation-evidence.mjs select');
    expect(selection.run).toContain('--output "$GITHUB_OUTPUT"');
    expect(selectionSteps).toContainEqual(
      expect.objectContaining({
        id: 'fallback',
        if: "${{ steps.selection.outcome != 'success' }}",
        run: expect.stringContaining('reuse=false'),
      }),
    );
    const resolution = selectionSteps.find(
      (step: Record<string, any>) => step.name === 'Resolve validation evidence selection',
    );
    expect(resolution).toMatchObject({
      id: 'resolution',
      if: '${{ always() }}',
      env: {
        SELECTION_OUTCOME: '${{ steps.selection.outcome }}',
        SELECTION_REUSE: '${{ steps.selection.outputs.reuse }}',
        SELECTION_DIGEST: '${{ steps.selection.outputs.build_tree_digest }}',
        FALLBACK_REUSE: '${{ steps.fallback.outputs.reuse }}',
      },
    });
    expect(resolution.run).toContain(
      'if [[ "$SELECTION_OUTCOME" == "success" && "$SELECTION_REUSE" == "true" ]]',
    );
    expect(resolution.run).toContain('echo "reuse=false" >> "$GITHUB_OUTPUT"');
    expect(workflow.jobs['release-gate'].if).toContain(
      "needs.validation-evidence.outputs.reuse != 'true'",
    );
    expect(workflow.jobs['release-gate'].if).not.toContain('needs.validation-evidence.result');

    expect(workflow.jobs['release-gate']).toMatchObject({
      name: 'Release Gate',
      needs: ['governance-gate', 'validation-evidence'],
      if:
        "${{ always() && needs.governance-gate.result == 'success' && " +
        "needs.validation-evidence.outputs.reuse != 'true' }}",
      uses: './.github/workflows/release-gate.yml',
      with: { changed_repo_style_base: 'origin/main' },
    });
  });

  it('publishes fresh v1 evidence only after the unchanged broad gate succeeds', () => {
    const workflow = readWorkflow();
    const publication = workflow.jobs['publish-validation-evidence'];

    expect(publication).toMatchObject({
      name: 'Publish validation evidence',
      needs: ['governance-gate', 'validation-evidence', 'release-gate'],
      if:
        "${{ always() && needs.release-gate.result == 'success' && " +
        "needs.validation-evidence.outputs.reuse != 'true' }}",
    });
    const runEnvelopeStep = publication.steps.find(
      (step: Record<string, any>) => step.name === 'Read trusted current run',
    );
    expect(runEnvelopeStep).toMatchObject({ env: { GH_TOKEN: '${{ github.token }}' } });
    expect(runEnvelopeStep.run).toContain(
      'gh api "/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"',
    );
    expect(runEnvelopeStep.run).toContain('gh api --paginate --slurp');
    expect(runEnvelopeStep.run).toContain(
      '/actions/runs/${GITHUB_RUN_ID}/jobs?filter=latest&per_page=100',
    );
    const creationStep = publication.steps.find(
      (step: Record<string, any>) => step.name === 'Create validation evidence',
    );
    expect(creationStep.run).toContain('node scripts/validation-evidence.mjs create');
    expect(creationStep.run).toContain('--release-gate-result "${{ needs.release-gate.result }}"');
    expect(creationStep.run).toContain(
      '--jobs-envelope ".artifacts/validation-evidence/current-jobs.json"',
    );
    expect(creationStep.run).not.toContain('--completed-at');
    const uploadStep = publication.steps.find(
      (step: Record<string, any>) => step.name === 'Upload validation evidence',
    );
    expect(uploadStep).toMatchObject({
      uses: 'actions/upload-artifact@v7',
      with: {
        name: 'validation-evidence-v1',
        path: '.artifacts/validation-evidence/validation-evidence-v1.json',
        'if-no-files-found': 'error',
        'retention-days': 7,
      },
    });

    const branchSource = readFileSync(
      path.join(repoRoot, '.github/workflows/branch-release-gate.yml'),
      'utf8',
    );
    expect(branchSource).not.toContain('npm run test:ci');
    expect(branchSource).not.toContain('npm run build:ar-eye-hunter-v1');
    expect(
      readFileSync(path.join(repoRoot, '.github/workflows/release-gate.yml'), 'utf8'),
    ).toContain('npm run test:ci');
  });

  it('runs for every build-affecting contract and exposes one required result job', () => {
    const workflow = readWorkflow();

    expect(workflow.on.push['paths-ignore']).toEqual(['docs/superpowers/plans/**']);
    expect(workflow.jobs['branch-release-result']).toMatchObject({
      name: 'Branch Release Gate result',
      needs: [
        'governance-gate',
        'validation-evidence',
        'release-gate',
        'publish-validation-evidence',
      ],
      if: '${{ always() }}',
    });
    const resultStep = workflow.jobs['branch-release-result'].steps.find(
      (step: Record<string, any>) => step.name === 'Conclude Branch Release Gate',
    );
    expect(resultStep.run).toContain('node scripts/validation-evidence.mjs conclude');
    expect(resultStep.run).toContain('--reuse "${{ needs.validation-evidence.outputs.reuse }}"');
  });

  it('exposes the focused capability command', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts['test:validation-evidence']).toBe(
      'vitest run packages/tests/repo/validation-evidence',
    );
  });
});

function readWorkflow(): Record<string, any> {
  return load(
    readFileSync(path.join(repoRoot, '.github/workflows/branch-release-gate.yml'), 'utf8'),
  ) as Record<string, any>;
}
