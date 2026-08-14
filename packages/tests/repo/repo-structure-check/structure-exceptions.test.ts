import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readStructureExceptions } from '../../../../scripts/repo-structure-check/structure-exceptions.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('repository structure exceptions', () => {
  it('returns no exceptions when the optional registry is absent', () => {
    const root = createRoot();

    expect(readStructureExceptions(root)).toEqual({ exceptions: [], issues: [] });
  });

  it('rejects unsupported fields instead of turning metadata into authority', () => {
    const root = createRoot();
    writeRegistry(root, {
      version: 1,
      exceptions: [
        {
          ruleId: 'topology.singleton-subtree',
          target: 'scripts/example',
          owner: 'maintainers',
          reviewOrRemovalCondition: 'Remove when the owner expands.',
          approval: { pullNumber: 1, reviewId: 2 },
        },
      ],
    });

    expect(readStructureExceptions(root)).toEqual({
      exceptions: [],
      issues: [
        'docs/repo-structure-exceptions.json exceptions[0] contains unsupported fields: approval',
      ],
    });
  });
});

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'structure-exceptions-'));
  roots.push(root);
  return root;
}

function writeRegistry(root: string, registry: unknown): void {
  const file = path.join(root, 'docs/repo-structure-exceptions.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(registry)}\n`);
}
