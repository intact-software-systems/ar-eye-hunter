import { describe, expect, it } from 'vitest';

import {
  readGovernedTestCouplingRegistry,
  validateRegistry,
} from '../../../../scripts/test-structure-coupling-registry-report.mjs';

const candidateHead = 'a'.repeat(40);

describe('governance exception consumer projections', () => {
  it('adds an exact test-coupling receipt through native registry validation', () => {
    const candidate = {
      id: 'test-structure-coupling-example',
      path: 'packages/tests/example/structure.test.ts',
      line: 12,
      column: 7,
      kind: 'production-source-read',
    };
    const semanticCoverage =
      'packages/tests/example/public.test.ts#keeps the public contract callable';
    const registry = readGovernedTestCouplingRegistry(
      { mode: 'changed-range', head: candidateHead },
      { contracts: [], entries: [], errors: [] },
      {
        readGovernanceExceptions: () => [
          {
            decisionId: 'd'.repeat(64),
            projection: {
              candidate,
              semanticContract: {
                id: 'example-public-contract',
                domain: 'Example public API',
                owner: 'Example maintainers',
                summary: 'The public contract remains directly callable.',
                semanticCoverage,
                coverageRelation: 'The semantic test executes the protected public contract.',
              },
              disposition: {
                kind: 'durable-boundary',
                boundary: 'public',
                owner: 'Example maintainers',
                rationale: 'The source read protects a published ownership boundary.',
                semanticCoverage,
              },
              candidateHead,
            },
          },
        ],
      },
    );

    expect(validateRegistry(registry, [candidate])).toEqual([]);
  });

  it('keeps malformed, stale, and duplicate registry evidence visible beside receipts', () => {
    const registry = readGovernedTestCouplingRegistry(
      { mode: 'changed-range', head: candidateHead },
      {
        contracts: [{ id: 'malformed-contract' }],
        entries: [{ id: 'stale-entry' }, { id: 'stale-entry' }],
        errors: ['registry metadata was malformed'],
      },
      { readGovernanceExceptions: () => [] },
    );

    const errors = validateRegistry(registry, []);

    expect(errors).toContain('registry metadata was malformed');
    expect(errors).toContain('registry entry has duplicate id: stale-entry');
    expect(errors).toContain('registry entry is stale: stale-entry');
    expect(errors).toContain('contract requires a concrete domain and summary: malformed-contract');
  });

  it('keeps malformed resolver evidence visible and unauthorized', () => {
    const registry = readGovernedTestCouplingRegistry(
      { mode: 'changed-range', head: candidateHead },
      { contracts: [], entries: [], errors: [] },
      { readGovernanceExceptions: () => [{ decisionId: 'd'.repeat(64), projection: null }] },
    );

    expect(registry.entries).toEqual([]);
    expect(registry.errors).toContain('governance test exception projection must be an object');
  });
});
