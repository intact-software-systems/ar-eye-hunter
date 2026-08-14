import { describe, expect, it } from 'vitest';

import {
  collectSemanticDepthFacts,
  createSingletonSubtreeFact,
  validateStructuralDispositions,
} from '../../../../scripts/repo-structure-check/structural-dispositions.mjs';

describe('repository structural dispositions', () => {
  it('requires a human judgment for every style and semantic-depth fact', () => {
    const facts = [
      { ruleId: 'layout.directory-density', target: 'apps/example', magnitude: 21 },
      {
        ruleId: 'layout.feature-prefix-cluster',
        target: 'apps/example',
        identity: 'room',
        magnitude: 4,
      },
      { ruleId: 'file.length', target: 'apps/example/large.ts', magnitude: 1201 },
      {
        ruleId: 'structure.semantic-depth',
        target: 'scripts/example/adapter/internal',
        magnitude: 2,
      },
    ];

    const affectedCodeDigest = 'a'.repeat(64);
    const issues = validateStructuralDispositions({
      facts,
      affectedCodeDigest,
      declaredDispositions: [
        currentFactDisposition({
          ruleId: 'layout.directory-density',
          target: 'apps/example',
          magnitude: 21,
          affectedCodeDigest,
        }),
      ],
    });

    expect(issues).toEqual([
      'apps/example [layout.feature-prefix-cluster:room] requires an explicit ' +
        'keep/split/move/consolidate disposition; automation does not choose one',
      'apps/example/large.ts [file.length] requires an explicit ' +
        'keep/split/move/consolidate disposition; automation does not choose one',
      'scripts/example/adapter/internal [structure.semantic-depth] requires an explicit ' +
        'keep/split/move/consolidate disposition; automation does not choose one',
    ]);
  });

  it('rejects stale, changed-magnitude, and orphan current-fact dispositions', () => {
    const affectedCodeDigest = 'b'.repeat(64);
    const facts = [{ ruleId: 'layout.directory-density', target: 'apps/example', magnitude: 22 }];

    const issues = validateStructuralDispositions({
      facts,
      affectedCodeDigest,
      declaredDispositions: [
        currentFactDisposition({
          ruleId: 'layout.directory-density',
          target: 'apps/example',
          magnitude: 22,
          affectedCodeDigest: 'a'.repeat(64),
        }),
        currentFactDisposition({
          ruleId: 'layout.directory-density',
          target: 'apps/example',
          magnitude: 21,
          affectedCodeDigest,
        }),
        currentFactDisposition({
          ruleId: 'file.length',
          target: 'apps/example/removed.ts',
          magnitude: 1201,
          affectedCodeDigest,
        }),
      ],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('has stale affected-code digest'),
        expect.stringContaining('does not match a current structural fact'),
        expect.stringContaining('apps/example [layout.directory-density] requires an explicit'),
      ]),
    );
  });

  it('does not consume ownership-contract decisions as current-fact waivers', () => {
    const issues = validateStructuralDispositions({
      facts: [{ ruleId: 'layout.directory-density', target: 'apps/example', magnitude: 21 }],
      affectedCodeDigest: 'c'.repeat(64),
      declaredDispositions: [
        {
          kind: 'ownership-contract',
          target: 'repo-style density, prefix, and size ownership',
          disposition: 'keep',
          rationale: 'Repo style remains the canonical fact owner.',
        },
      ],
    });

    expect(issues).toEqual([
      'apps/example [layout.directory-density] requires an explicit ' +
        'keep/split/move/consolidate disposition; automation does not choose one',
    ]);
  });

  it('reports semantic depth without prescribing a directory shape', () => {
    const facts = collectSemanticDepthFacts({
      capabilities: [
        {
          owner: 'example capability',
          root: 'scripts/example',
        },
      ],
      authoredFiles: [
        'scripts/example/direct.mjs',
        'scripts/example/adapter/internal/read-value.mjs',
      ],
    });

    expect(facts).toEqual([
      {
        ruleId: 'structure.semantic-depth',
        target: 'scripts/example/adapter/internal',
        magnitude: 2,
      },
    ]);
  });

  it('binds an active-plan singleton judgment to its sole descendant and digest', () => {
    const affectedCodeDigest = 'd'.repeat(64);
    const fact = createSingletonSubtreeFact({
      target: 'packages/example/tests/workloads/signaling',
      descendant: 'packages/example/tests/workloads/signaling/lifecycle.test.ts',
      context: 'New authored-code subtree has one code descendant.',
    });
    const exactDisposition = currentFactDisposition({
      ruleId: fact.ruleId,
      target: fact.target,
      identity: fact.identity,
      magnitude: fact.magnitude,
      affectedCodeDigest,
    });

    expect(
      validateStructuralDispositions({
        facts: [fact],
        affectedCodeDigest,
        declaredDispositions: [exactDisposition],
      }),
    ).toEqual([]);

    expect(
      validateStructuralDispositions({
        facts: [fact],
        affectedCodeDigest,
        declaredDispositions: [{ ...exactDisposition, identity: 'another.test.ts' }],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('does not match a current structural fact'),
        expect.stringContaining('New authored-code subtree has one code descendant.'),
      ]),
    );
  });
});

function currentFactDisposition(overrides: Record<string, unknown>) {
  return {
    kind: 'current-fact',
    identity: null,
    disposition: 'keep',
    rationale: 'The current fact is intentionally retained for this exact change.',
    ...overrides,
  };
}
