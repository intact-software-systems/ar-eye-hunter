import { describe, expect, it } from 'vitest';

import {
  collectSemanticDepthFacts,
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

    const issues = validateStructuralDispositions(facts, [
      {
        target: 'apps/example [layout.directory-density]',
        disposition: 'keep',
        rationale: 'The directory is one cohesive public registry.',
      },
    ]);

    expect(issues).toEqual([
      'apps/example [layout.feature-prefix-cluster:room] requires an explicit ' +
        'keep/split/move/consolidate disposition; automation does not choose one',
      'apps/example/large.ts [file.length] requires an explicit ' +
        'keep/split/move/consolidate disposition; automation does not choose one',
      'scripts/example/adapter/internal [structure.semantic-depth] requires an explicit ' +
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
});
