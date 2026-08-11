import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const reviewRecordPath = 'docs/pr-human-review-record.md';
const legacyRegistryPath = 'docs/production-legacy-exceptions.md';
const templatePath = '.github/PULL_REQUEST_TEMPLATE.md';

describe('PR human review record contract', () => {
  it('publishes one template and record contract for initial, milestone, and final reviews', () => {
    expect(existsSync(resolve(templatePath))).toBe(true);
    expect(existsSync(resolve(reviewRecordPath))).toBe(true);

    const template = readRepo(templatePath);
    const contract = readRepo(reviewRecordPath);

    expectAll(template, [
      'PR Human Review Record v1',
      'Initial independent review',
      'Milestone review',
      'Complete code and legacy review',
      'Exact merge base SHA',
      'Exact candidate head SHA',
      'Reviewer and independence',
      'Production owner-to-result trace',
      'Cognitive-indirection findings',
      'Tests rewritten or removed',
      'Production was not compromised for tests',
      'Behavior and judgment not proven by automation',
      'Legacy ledger and dispositions',
      'Critical findings unresolved',
      'Important findings unresolved',
      'Verdict',
    ]);
    expectAllNormalized(contract, [
      'Initial review',
      'Milestone review',
      'Final review',
      'initial review is required before a code-changing draft pull request',
      'milestone review is required when a new ownership, control-flow, or legacy family appears',
      'final review is required before the pull request is ready for merge',
      'separate agent or human',
      'exact merge base SHA',
      'exact candidate head SHA',
    ]);
  });

  it('makes production-over-test review, automation limits, and exact-SHA freshness reviewable', () => {
    const template = readRepo(templatePath);
    const contract = readRepo(reviewRecordPath);

    for (const source of [template, contract]) {
      expectAllNormalized(source, [
        'Production code is the primary design artifact; tests are secondary evidence',
        'Automation validates evidence and freshness; it does not approve semantic quality or retained legacy',
        'A production change invalidates the final review and any retained-legacy approval',
        'zero unresolved Critical or Important findings',
      ]);
    }
  });

  it('uses stable finding-resolution and legacy-candidate-count fields at every applicable review stage', () => {
    const template = readRepo(templatePath);
    const contract = readRepo(reviewRecordPath);

    expectOccurrences(template, '- Complete review findings and resolution/status', 3);
    expectOccurrences(template, '- Legacy candidate count:', 3);
    expectAllNormalized(contract, [
      'Complete review findings and resolution/status',
      'correctness, safety, contracts, and other human-review findings',
      'Legacy candidate count',
    ]);
  });

  it('requires an exhaustive retained-legacy approval ledger and durable registry entries', () => {
    expect(existsSync(resolve(legacyRegistryPath))).toBe(true);

    const template = readRepo(templatePath);
    const contract = readRepo(reviewRecordPath);
    const registry = readRepo(legacyRegistryPath);

    expectAll(template, [
      '`removed`',
      '`minimized-boundary`',
      '`resolved`',
      '`retained-pending-human-approval`',
      'Human approval for retained legacy',
      'Legacy exception ID',
    ]);
    expectAllNormalized(contract, [
      'Silence, an issue, an earlier plan approval, agent judgment, or automation is not approval',
      'exact path and symbol',
      'purpose and current consumer or operational dependency',
      'why removal is unsafe now',
      'minimization already performed',
      'canonical implementation owner',
      'tests protecting compatibility rather than internal structure',
      'named owner',
      'review or removal condition',
      'exact candidate head SHA',
    ]);
    expectAllNormalized(registry, [
      'Legacy exception ID',
      'Repository-relative path and symbol',
      'Purpose',
      'Canonical implementation owner',
      'Consumer or operational dependency',
      'Minimization already performed',
      'Approval date and human reviewer',
      'Approved production candidate SHA',
      'Compatibility tests',
      'Named owner',
      'Review or removal condition',
      'GitHub PR review ID',
      'No automated score or agent may approve retained production legacy',
    ]);
  });

  it('allows a documented exemption only for plan, documentation, or agent-guidance-only pull requests', () => {
    const template = readRepo(templatePath);
    const contract = readRepo(reviewRecordPath);

    for (const source of [template, contract]) {
      expectAllNormalized(source, [
        'Plan-, documentation-, and agent-guidance-only pull requests may use the explicit exemption',
        'No production, test, script, workflow, package metadata, or runtime files changed',
      ]);
    }
  });
});

function resolve(filePath: string): string {
  return path.join(repoRoot, filePath);
}

function readRepo(filePath: string): string {
  return readFileSync(resolve(filePath), 'utf8');
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack, needle).toContain(needle);
  }
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
  const normalized = haystack.replace(/\s+/g, ' ').trim();
  for (const needle of needles) {
    expect(normalized, needle).toContain(needle.replace(/\s+/g, ' ').trim());
  }
}

function expectOccurrences(haystack: string, needle: string, expectedCount: number): void {
  expect(haystack.split(needle)).toHaveLength(expectedCount + 1);
}
