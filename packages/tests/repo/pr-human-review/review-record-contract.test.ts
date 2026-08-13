import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const contractPath = 'docs/pr-human-review-record.md';
const templatePath = '.github/PULL_REQUEST_TEMPLATE.md';

describe('PR Human Review Record v2 contract', () => {
  it('publishes one v2 template and durable contract with no v1 transition surface', () => {
    expect(existsSync(resolve(templatePath))).toBe(true);
    expect(existsSync(resolve(contractPath))).toBe(true);
    const template = readRepo(templatePath);
    const contract = readRepo(contractPath);

    for (const source of [template, contract]) {
      expectAllNormalized(source, [
        'PR Human Review Record v2',
        'Initial architecture review',
        'Current checkpoint review',
        'Complete code, structure, tests, and legacy review',
      ]);
      expect(source).not.toContain('pr-human-review-record-v1');
      expect(source).not.toContain('### Milestone review');
    }
    expect(template).toContain('```pr-human-review-record-v2');
  });

  it('states the initial, checkpoint, final, and content-freshness contracts', () => {
    const contract = readRepo(contractPath);

    expectAllNormalized(contract, [
      'goal, acceptance criteria, capability-tree hypothesis, canonical owners and entries, and first two slices',
      'checkpoint review contains only the current adaptive-plan digest',
      'build-affecting tree digest',
      'unrelated documentation changes do not invalidate final-review evidence',
      'declared outcomes',
      'every declared owner-to-result path',
      'navigation evidence',
      'test evidence',
      'compatibility evidence',
      'proportional validation',
      'legacy closure',
      'zero unresolved Critical or Important findings',
    ]);
  });

  it('retains exact candidate-ledger and trusted human legacy approval semantics', () => {
    const template = readRepo(templatePath);
    const contract = readRepo(contractPath);

    for (const source of [template, contract]) {
      expectAllNormalized(source, [
        'notLegacyAggregate',
        'REPORT-SHA256',
        'retained-pending-human-approval',
        'exact candidate',
        'trusted human GitHub approval',
      ]);
    }
    expectAllNormalized(contract, [
      'Silence, an issue, an earlier plan approval, agent judgment, or automation is not approval',
      'whole-ledger SHA-256',
      'durable registry',
    ]);
  });

  it('migrates existing open pull requests on synchronization and documents the bootstrap exception', () => {
    const workflow = readRepo('.github/workflows/pr-human-review-record.yml');
    const contract = readRepo(contractPath);

    expect(workflow).toContain('- synchronize');
    expect(workflow).toContain('Validate PR Human Review Record v2');
    expectAllNormalized(contract, [
      'Existing open pull requests migrate on their next synchronization',
      'introducing pull request is the sole bootstrap exception',
      'pull_request_target',
    ]);
  });

  it('keeps exemptions narrow and explicit', () => {
    const template = readRepo(templatePath);
    const contract = readRepo(contractPath);

    for (const source of [template, contract]) {
      expectAllNormalized(source, [
        'Plan-, documentation-, and agent-guidance-only pull requests may use the explicit exemption',
        'No production, test, script, workflow, package metadata, or runtime files changed',
      ]);
    }
    expectAllNormalized(contract, [
      'canonical `plans/<plan-id>.closure.json` receipts',
      'Adaptive governance authenticates the receipt',
    ]);
  });
});

function resolve(repositoryPath: string): string {
  return path.join(repoRoot, repositoryPath);
}

function readRepo(repositoryPath: string): string {
  return readFileSync(resolve(repositoryPath), 'utf8');
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
  const normalized = haystack.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const needle of needles) {
    expect(normalized, needle).toContain(needle.replace(/\s+/g, ' ').trim().toLowerCase());
  }
}
