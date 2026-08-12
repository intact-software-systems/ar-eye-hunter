import { describe, expect, it } from 'vitest';

import {
  parseAdaptivePlanRecord,
  replaceAdaptivePlanRecord,
  validateAdaptivePlanRecord,
} from '../../../../scripts/plan-adaptation/adaptive-plan-record.mjs';
import { validateCheckpoint } from '../../../../scripts/plan-adaptation/adaptive-plan-policy.mjs';

describe('adaptive plan record', () => {
  it('parses the only plan-adaptation-v1 block and canonically replaces it', () => {
    const markdown = `# Fixture plan\n\n${recordBlock(createRecord())}\n`;
    const parsed = parseAdaptivePlanRecord(markdown, 'plans/fixture-plan.md');
    parsed.checkpoint.outcome = 'The first capability slice is complete.';

    const replaced = replaceAdaptivePlanRecord(markdown, parsed, 'plans/fixture-plan.md');

    expect(replaced).toContain('"outcome": "The first capability slice is complete."');
    expect(replaced.match(/```plan-adaptation-v1/gu)).toHaveLength(1);
    expect(replaced).toBe(replaceAdaptivePlanRecord(replaced, parsed, 'plans/fixture-plan.md'));
  });

  it('rejects missing, duplicate, and malformed canonical records', () => {
    expect(() => parseAdaptivePlanRecord('# No record\n', 'plans/missing.md')).toThrow(
      'exactly one plan-adaptation-v1 block',
    );

    const block = recordBlock(createRecord());
    expect(() => parseAdaptivePlanRecord(`${block}\n${block}`, 'plans/duplicate.md')).toThrow(
      'exactly one plan-adaptation-v1 block',
    );
    expect(() =>
      parseAdaptivePlanRecord('```plan-adaptation-v1\n{broken}\n```', 'plans/malformed.md'),
    ).toThrow('invalid JSON');
  });

  it('rejects unsafe or malformed canonical governance fields', () => {
    const record = createRecord();
    record.planId = '../outside';
    record.status = 'acitve';
    record.capabilities[0].root = '../scripts';
    record.capabilities[0].entry = '/tmp/entry.mjs';
    record.capabilities[0].factContracts = ['../outside.mjs'];
    record.capabilities[0].controlFlowFamilies = [];
    record.completedSlicesSinceCheckpoint = ['slice-one', 2];
    record.facts = {
      diffBase: 42,
      affectedCodeDigest: 'not-a-digest',
      computedTriggers: 'folder-change',
      undeclaredChangedPaths: ['../outside'],
    };
    record.materialDecisions = [{ date: 'today', decision: '' }];
    record.freshStructuralReview = { status: 'failed', failures: 'ownership' };
    record.coldNavigationEvidence = { status: 'failed' };

    expect(validateAdaptivePlanRecord(record)).toEqual(
      expect.arrayContaining([
        'record.planId must use lowercase letters, digits, and single hyphens',
        'record.status must be active',
        'record.capabilities[0].root must be a safe repository-relative path',
        'record.capabilities[0].entry must be a safe repository-relative path',
        'record.capabilities[0].factContracts must contain safe repository-relative paths',
        'record.capabilities[0].controlFlowFamilies must contain unique non-empty strings',
        'record.completedSlicesSinceCheckpoint must contain only non-empty strings',
        'record.facts.diffBase must be a non-empty string',
        'record.facts.affectedCodeDigest must be null or a SHA-256 digest',
        'record.facts.computedTriggers must be an array',
        'record.facts.undeclaredChangedPaths must contain safe repository-relative paths',
        'record.materialDecisions[0].date must use YYYY-MM-DD',
        'record.materialDecisions[0].decision must be a non-empty string',
        'record.freshStructuralReview.failures must be an array',
        'record.coldNavigationEvidence.summary must be a non-empty string',
        'record.coldNavigationEvidence.probes must be a non-empty array',
      ]),
    );
  });
});

describe('checkpoint policy', () => {
  it('requires all five judgments and permits no more than two concrete slices', () => {
    const checkpoint = createRecord().checkpoint;
    expect(validateCheckpoint(checkpoint, createRecord())).toEqual([]);

    expect(
      validateCheckpoint(
        { ...checkpoint, learning: '', nextSlices: ['one', 'two', 'three'] },
        createRecord(),
      ),
    ).toEqual(
      expect.arrayContaining([
        'checkpoint.learning must be a non-empty judgment',
        'checkpoint.nextSlices must contain at most two concrete slices',
      ]),
    );
  });

  it('rejects continue only when a known navigation or ownership failure would be deepened', () => {
    const record = createRecord();
    record.freshStructuralReview = {
      status: 'complete',
      failures: [
        {
          kind: 'ownership',
          summary: 'The next feature would split one lifecycle across owners.',
          recoverable: true,
          deepenedBySlices: ['slice-2-repository-structure'],
        },
      ],
    };

    expect(validateCheckpoint(record.checkpoint, record)).toContain(
      'continue cannot deepen a known navigation or ownership failure',
    );
    expect(
      validateCheckpoint({ ...record.checkpoint, nextSlices: ['unrelated-safe-slice'] }, record),
    ).not.toContain('continue cannot deepen a known navigation or ownership failure');
  });

  it('rejects continue for an unrecoverable ownership or navigation failure', () => {
    const record = createRecord();
    record.freshStructuralReview = {
      status: 'failed',
      failures: [
        {
          kind: 'navigation',
          summary: 'No canonical entry can be located.',
          recoverable: false,
          deepenedBySlices: [],
        },
      ],
    };

    expect(validateCheckpoint(record.checkpoint, record)).toContain(
      'continue is invalid while an unrecoverable navigation or ownership failure is known',
    );
  });

  it('allows one consolidation replacement and requires stop after its failed cold navigation', () => {
    const record = createRecord();
    const consolidation = {
      ...record.checkpoint,
      decision: 'consolidate',
      nextSlices: ['repair-owner'],
    };
    expect(validateCheckpoint(consolidation, record)).toEqual([]);

    record.materialDecisions.push({
      date: '2026-08-12',
      decision: 'consolidate',
      summary: 'Consolidate the plan-adaptation owner before another feature slice.',
    });
    expect(validateCheckpoint(consolidation, record)).toContain(
      'only one autonomous consolidation slice is allowed',
    );

    record.coldNavigationEvidence = {
      status: 'failed',
      summary: 'A fresh reader could not locate the checkpoint decision owner.',
      consolidationDecisionIndex: 0,
    };
    expect(validateCheckpoint(record.checkpoint, record)).toContain(
      'failed cold navigation after consolidation requires decision stop and no next slices',
    );
    expect(
      validateCheckpoint({ ...record.checkpoint, decision: 'stop', nextSlices: [] }, record),
    ).toEqual([]);

    record.coldNavigationEvidence.consolidationDecisionIndex = 99;
    expect(
      validateCheckpoint({ ...record.checkpoint, decision: 'stop', nextSlices: [] }, record),
    ).toContain('failed cold navigation must reference the prior consolidation decision');
  });
});

function createRecord(): any {
  return {
    version: 1,
    planId: 'fixture-plan',
    status: 'active',
    goal: 'Prove the adaptive plan lifecycle.',
    acceptanceCriteria: ['The lifecycle remains content-sensitive.'],
    capabilities: [
      {
        owner: 'plan adaptation',
        root: 'scripts/plan-adaptation',
        entry: 'scripts/plan-adaptation.mjs',
        testRoot: 'packages/tests/repo/plan-adaptation',
        focusedCommand: 'npm run test:plan-adaptation',
        navigationMap: null,
        factContracts: [],
        controlFlowFamilies: ['lifecycle mutation', 'read-only check', 'close-out'],
      },
      {
        owner: 'repository structure',
        root: 'scripts/repo-structure-check',
        entry: 'scripts/repo-structure-check.mjs',
        testRoot: 'packages/tests/repo/repo-structure-check',
        focusedCommand: 'npm run test:repo-structure',
        navigationMap: null,
        factContracts: ['scripts/repo-style-check/structural-facts.mjs'],
        controlFlowFamilies: ['structural scan', 'declaration validation'],
      },
    ],
    architecture: {
      currentHypothesis: 'Governance is fragmented.',
      intendedHypothesis: 'One lifecycle owns plan adaptation.',
      freshInitialReview: { status: 'complete', reviewer: 'fixture', verdict: 'pass' },
    },
    completedSlicesSinceCheckpoint: [],
    facts: {
      diffBase: 'HEAD',
      affectedCodeDigest: null,
      computedTriggers: ['written-plan'],
      undeclaredChangedPaths: [],
    },
    checkpoint: {
      outcome: 'The approved fixture plan is active.',
      learning: 'The initial review fixed two capability roots.',
      structure: 'One plan lifecycle owns its records and registry.',
      decision: 'continue',
      nextSlices: ['slice-1-plan-adaptation', 'slice-2-repository-structure'],
    },
    structuralDispositions: [],
    freshStructuralReview: null,
    coldNavigationEvidence: null,
    materialDecisions: [],
  };
}

function recordBlock(record: ReturnType<typeof createRecord>): string {
  return `\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\``;
}
