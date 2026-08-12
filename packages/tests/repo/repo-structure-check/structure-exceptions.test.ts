import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readStructureExceptions } from '../../../../scripts/repo-structure-check/structure-exceptions.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('repository structure singleton exceptions', () => {
  it('does not infer human approval from a plan, agent, or issue label', () => {
    const root = createRegistry({
      kind: 'human',
      approvedBy: 'Fixture Human',
      approvedAt: '2026-08-12',
      evidence: 'direct-human-approval:issue-123',
    });

    const result = readStructureExceptions(root);

    expect(result.exceptions).toEqual([]);
    expect(result.issues[0]).toContain('plans, agents, and issues are not approval');
  });

  it('accepts a named human approval tied to a concrete pull-request review', () => {
    const root = createRegistry({
      kind: 'human',
      approvedBy: 'Fixture Human',
      approvedAt: '2026-08-12',
      evidence: 'https://github.com/example/repository/pull/42#pullrequestreview-100',
    });

    expect(readStructureExceptions(root).issues).toEqual([]);
  });
});

function createRegistry(approval: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'structure-exceptions-'));
  fixtureRoots.push(root);
  const file = path.join(root, 'docs/repo-structure-exceptions.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      exceptions: [
        {
          ruleId: 'topology.singleton-subtree',
          target: 'apps/approved-singleton',
          owner: 'Repository maintainers',
          reviewOrRemovalCondition: 'Review when another module is required.',
          approval,
        },
      ],
    }),
  );
  return root;
}
