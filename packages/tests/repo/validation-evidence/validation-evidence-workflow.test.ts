import { readFileSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

describe('PR-scoped validation reuse workflow', () => {
  it('binds selection and publication to the current PR while keeping evidence transient', () => {
    const workflow = readWorkflow();
    const selection = workflow.jobs['validation-evidence'].steps.find(
      (step: Record<string, any>) => step.name === 'Select same-PR validation evidence',
    );
    const publication = workflow.jobs['publish-validation-evidence'];
    const create = publication.steps.find(
      (step: Record<string, any>) => step.name === 'Create validation evidence',
    );
    const upload = publication.steps.find(
      (step: Record<string, any>) => step.name === 'Upload validation evidence',
    );

    expect(selection.run).toContain(
      '--pull-request-number "${{ github.event.pull_request.number }}"',
    );
    expect(selection.run).toContain('--base-branch "${{ github.event.pull_request.base.ref }}"');
    expect(selection.run).toContain('--head "${{ github.event.pull_request.head.sha }}"');
    expect(create.run).toContain('--pull-request-number "${{ github.event.pull_request.number }}"');
    expect(create.run).not.toMatch(/run-envelope|jobs-envelope|governance/iu);
    expect(upload).toMatchObject({
      uses: 'actions/upload-artifact@v7',
      with: {
        name: 'validation-evidence-v2',
        path: '.artifacts/validation-evidence/validation-evidence-v2.json',
        'retention-days': 7,
      },
    });
  });

  it('uses only local job outcomes for the stable result', () => {
    const workflow = readWorkflow();
    const result = workflow.jobs['branch-release-result'];
    const conclusion = result.steps.find(
      (step: Record<string, any>) => step.name === 'Conclude Branch Release Gate',
    );

    expect(result.name).toBe('Branch Release Gate result');
    expect(conclusion.run).toContain('--governance-result');
    expect(conclusion.run).not.toMatch(/governance-status|decision-id|receipt|APP_SLUG/iu);
  });
});

function readWorkflow(): Record<string, any> {
  return load(
    readFileSync(path.join(repoRoot, '.github/workflows/branch-release-gate.yml'), 'utf8'),
  ) as Record<string, any>;
}
