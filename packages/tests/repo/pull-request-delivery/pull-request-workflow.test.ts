import { readFileSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

describe('pull-request release workflow', () => {
  it('runs only for current pull-request changes and cancels only superseded runs of that PR', () => {
    const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');

    expect(workflow.on).toEqual({
      pull_request: {
        types: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
      },
    });
    expect(workflow.concurrency).toEqual({
      group: 'branch-release-pr-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    });
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });

    const group = workflow.concurrency.group as string;
    expect(resolveConcurrencyGroup(group, 101)).toBe(resolveConcurrencyGroup(group, 101));
    expect(resolveConcurrencyGroup(group, 101)).not.toBe(resolveConcurrencyGroup(group, 102));
  });

  it('validates the PR source against its event base and preserves one stable required result', () => {
    const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');
    const pullRequestHead = '${{ github.event.pull_request.head.sha }}';
    const pullRequestBase = '${{ github.event.pull_request.base.sha }}';

    expect(workflow.jobs['governance-gate'].with).toEqual({ candidate_ref: pullRequestHead });
    expect(workflow.jobs['release-gate']).toMatchObject({
      with: {
        candidate_ref: pullRequestHead,
        changed_repo_style_base: pullRequestBase,
      },
    });
    expect(workflow.jobs['branch-release-result']).toMatchObject({
      name: 'Branch Release Gate result',
      if: '${{ always() }}',
    });
    expect(workflow.jobs['branch-release-result'].steps[0]).toMatchObject({
      uses: 'actions/checkout@v7',
      with: { ref: pullRequestHead },
    });
  });

  it('keeps ordinary PR validation read-only and independent of apps or tracked evidence', () => {
    const sources = [
      '.github/workflows/branch-release-gate.yml',
      '.github/workflows/governance-gate.yml',
      '.github/workflows/release-gate.yml',
    ].map(readSource);
    const source = sources.join('\n');

    expect(source).not.toMatch(/merge_group|pull_request_target|source approval/iu);
    expect(source).not.toMatch(/GOVERNANCE_APP|APP_PRIVATE_KEY|governance:decide/iu);
    expect(source).not.toMatch(/gh\s+pr\s+(?:comment|edit)|git\s+(?:add|commit|push)/iu);
    expect(source).not.toMatch(/plans\/|governance\/decisions|pr-human-review/iu);
  });
});

function readWorkflow(repositoryPath: string): Record<string, any> {
  return load(readSource(repositoryPath)) as Record<string, any>;
}

function readSource(repositoryPath: string): string {
  return readFileSync(path.join(repoRoot, repositoryPath), 'utf8');
}

function resolveConcurrencyGroup(template: string, pullRequestNumber: number): string {
  return template.replace('${{ github.event.pull_request.number }}', String(pullRequestNumber));
}
