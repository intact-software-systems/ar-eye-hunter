import { describe, expect, it } from 'vitest';

import {
  computeCheckpointDigest,
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

  it('accepts active and postponed as the only persisted plan statuses', () => {
    const record = createRecord();
    record.status = 'postponed';

    expect(validateAdaptivePlanRecord(record)).toEqual([]);

    record.status = 'complete';
    expect(validateAdaptivePlanRecord(record)).toContain(
      'record.status must be active or postponed',
    );
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
    record.structuralDispositions = [
      {
        kind: 'current-fact',
        ruleId: '',
        target: '../outside',
        identity: 42,
        magnitude: -1,
        affectedCodeDigest: 'stale',
        disposition: 'later',
        rationale: '',
      },
      {
        kind: 'unknown',
        target: 'ownership contract',
        disposition: 'keep',
        rationale: 'Unknown kinds cannot become waivers.',
      },
      {
        kind: 'predecessor-path',
        path: '../outside',
        disposition: 'keep',
        destination: '',
        owner: '',
        rationale: '',
        target: 'scripts/current.mjs',
      },
    ];
    record.freshStructuralReview = { status: 'failed', failures: 'ownership' };
    record.coldNavigationEvidence = { status: 'failed' };

    expect(validateAdaptivePlanRecord(record)).toEqual(
      expect.arrayContaining([
        'record.planId must use lowercase letters, digits, and single hyphens',
        'record.status must be active or postponed',
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
        'record.structuralDispositions[0].ruleId must be a non-empty string',
        'record.structuralDispositions[0].target must be a safe repository-relative path',
        'record.structuralDispositions[0].identity must be null or a non-empty string',
        'record.structuralDispositions[0].magnitude must be a non-negative integer',
        'record.structuralDispositions[0].affectedCodeDigest must be a SHA-256 digest',
        'record.structuralDispositions[0].disposition must be keep, split, move, or consolidate',
        'record.structuralDispositions[0].rationale must be a non-empty string',
        'record.structuralDispositions[1].kind must be ownership-contract or current-fact',
        'record.structuralDispositions[2].path must be a safe repository-relative path',
        'record.structuralDispositions[2].disposition must be move or consolidate',
        'record.structuralDispositions[2].destination must be a safe repository-relative path',
        'record.structuralDispositions[2].owner must be a non-empty string',
        'record.structuralDispositions[2].rationale must be a non-empty string',
        'record.structuralDispositions[2] predecessor-path contains unsupported fields: target',
        'record.freshStructuralReview.failures must be an array',
        'record.coldNavigationEvidence.summary must be a non-empty string',
        'record.coldNavigationEvidence.probes must be a non-empty array',
      ]),
    );
  });

  it('validates guidance capabilities without changing the existing code-capability shape', () => {
    const record = createRecord();
    record.capabilities.push({
      kind: 'guidance',
      owner: 'adaptive plan execution guidance',
      skillRoot: '.agents/skills/adaptive-plan-execution',
      skillEntry: '.agents/skills/adaptive-plan-execution/SKILL.md',
      contractTestRoot: 'packages/tests/repo/adaptive-agent-execution',
      focusedCommand: 'npm run test:adaptive-plan-execution',
      evaluationRoot: '.agents/evaluations/adaptive-agent-execution/v1',
      contractPaths: ['packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts'],
    });

    expect(validateAdaptivePlanRecord(record)).toEqual([]);

    record.capabilities[2] = {
      kind: 'guidance',
      owner: 'adaptive plan execution guidance',
      skillRoot: '../outside',
      skillEntry: '.agents/skills/other/SKILL.md',
      contractTestRoot: '/tmp/contracts',
      focusedCommand: 'npm run test:adaptive-plan-execution',
      evaluationRoot: '../evaluations',
      contractPaths: ['../shared-contract.test.ts'],
      navigationMap: null,
    };

    expect(validateAdaptivePlanRecord(record)).toEqual(
      expect.arrayContaining([
        'record.capabilities[2].skillRoot must be a safe repository-relative path',
        'record.capabilities[2].contractTestRoot must be a safe repository-relative path',
        'record.capabilities[2].evaluationRoot must be null or a safe repository-relative path',
        'record.capabilities[2].contractPaths must contain safe repository-relative paths',
        'record.capabilities[2].skillEntry must be the SKILL.md entry inside its skillRoot',
        'record.capabilities[2] guidance capability contains fields outside the skill-owned union: navigationMap',
      ]),
    );
  });

  it('validates an exact router-owned guidance union without weakening skill compatibility', () => {
    const record = createRecord();
    record.capabilities.push({
      kind: 'guidance',
      guidanceRole: 'router',
      owner: 'general agent guidance',
      routingEntry: 'AGENTS.md',
      contractTestRoot: 'packages/tests/repo/general-agent-guidance',
      focusedCommand: 'npm run test:general-agent-guidance',
      evaluationRoot: null,
      contractPaths: [
        '.agents/skills/adaptive-plan-execution/SKILL.md',
        '.agents/skills/organizing-repository-structure/SKILL.md',
      ],
    });

    expect(validateAdaptivePlanRecord(record)).toEqual([]);

    const implicitRouter = { ...record.capabilities[2] };
    delete implicitRouter.guidanceRole;
    record.capabilities[2] = implicitRouter;

    expect(validateAdaptivePlanRecord(record)).toEqual(
      expect.arrayContaining([
        'record.capabilities[2].skillRoot must be a non-empty string',
        'record.capabilities[2].skillEntry must be a non-empty string',
        'record.capabilities[2] guidance capability contains fields outside the skill-owned union: routingEntry',
      ]),
    );

    record.capabilities[2] = {
      ...implicitRouter,
      guidanceRole: 'router',
      routingEntry: '../AGENTS.md',
      skillRoot: '.agents/skills/publishing-plan-progress',
      unexpectedPolicy: true,
    };

    expect(validateAdaptivePlanRecord(record)).toEqual(
      expect.arrayContaining([
        'record.capabilities[2].routingEntry must be a safe repository-relative path',
        'record.capabilities[2] guidance capability contains fields outside the router-owned union: skillRoot, unexpectedPolicy',
      ]),
    );

    record.capabilities[2].guidanceRole = 'unknown';
    expect(validateAdaptivePlanRecord(record)).toContain(
      'record.capabilities[2].guidanceRole must be router when present',
    );
  });

  it('accepts optional exact code contract paths and rejects unsafe or duplicate entries', () => {
    const record = createRecord();
    record.capabilities[0].contractPaths = ['.github/PULL_REQUEST_TEMPLATE/governance.md'];

    expect(validateAdaptivePlanRecord(record)).toEqual([]);

    record.capabilities[0].contractPaths = [
      '../outside.md',
      '.github/PULL_REQUEST_TEMPLATE/governance.md',
      '.github/PULL_REQUEST_TEMPLATE/governance.md',
    ];

    expect(validateAdaptivePlanRecord(record)).toEqual(
      expect.arrayContaining([
        'record.capabilities[0].contractPaths must contain safe repository-relative paths',
        'record.capabilities[0].contractPaths must contain unique paths',
      ]),
    );
  });

  it('reserves planned code contract paths against active and planned code owners', () => {
    const record = createRecord();
    record.capabilities[0].contractPaths = ['.github/workflows/governance.yml'];
    record.capabilities.push({
      owner: 'future governance',
      root: 'scripts/future-governance',
      entry: 'scripts/future-governance.mjs',
      testRoot: 'packages/tests/repo/future-governance',
      focusedCommand: 'npm run test:future-governance',
      navigationMap: null,
      factContracts: [],
      contractPaths: ['.github/workflows/governance.yml'],
      controlFlowFamilies: ['future validation'],
      activation: { state: 'planned', slice: 'slice-1-plan-adaptation' },
    });

    expect(validateAdaptivePlanRecord(record)).toContain(
      'planned capability future governance contract path .github/workflows/governance.yml ' +
        'conflicts with active capability plan adaptation',
    );

    record.capabilities[2].contractPaths = ['scripts/repo-structure-check/contract.md'];
    expect(validateAdaptivePlanRecord(record)).toContain(
      'planned capability future governance contract path ' +
        'scripts/repo-structure-check/contract.md conflicts with active capability ' +
        'repository structure',
    );
  });

  it('rejects contract paths claimed by another code owner as an exact fact contract', () => {
    const record = createRecord();
    record.capabilities[0].factContracts = ['.github/workflows/governance.yml'];
    record.capabilities[1].contractPaths = ['.github/workflows/governance.yml'];

    expect(validateAdaptivePlanRecord(record)).toContain(
      'active capability repository structure contract path .github/workflows/governance.yml ' +
        'conflicts with active capability plan adaptation fact contract',
    );

    record.capabilities[1].activation = {
      state: 'planned',
      slice: 'slice-2-repository-structure',
    };
    expect(validateAdaptivePlanRecord(record)).toContain(
      'planned capability repository structure contract path ' +
        '.github/workflows/governance.yml conflicts with active capability plan adaptation ' +
        'fact contract',
    );
  });

  it('rejects the same exact path as one code owner fact and non-code contract', () => {
    const record = createRecord();
    record.capabilities[0].factContracts = ['.github/workflows/governance.yml'];
    record.capabilities[0].contractPaths = ['.github/workflows/governance.yml'];

    expect(validateAdaptivePlanRecord(record)).toContain(
      'active capability plan adaptation path .github/workflows/governance.yml cannot be both ' +
        'a fact contract and a contract path',
    );
  });

  it('rejects unknown capability kinds', () => {
    const record = createRecord();
    record.capabilities[0].kind = 'workflow';

    expect(validateAdaptivePlanRecord(record)).toContain(
      'record.capabilities[0].kind must be code or guidance',
    );
  });

  it('requires a planned capability to bind one named horizon slice', () => {
    const record = createRecord();
    record.capabilities[0].activation = { state: 'planned' };

    expect(validateAdaptivePlanRecord(record)).toContain(
      'record.capabilities[0].activation must be omitted or exactly planned with one slice',
    );

    record.capabilities[0].activation = {
      state: 'planned',
      slice: 'future-owner',
    };
    expect(validateCheckpoint(record.checkpoint, record)).toContain(
      'planned capability plan adaptation must bind a current horizon slice: future-owner',
    );
  });

  it('accepts only omission or an exact planned activation declaration', () => {
    const record = createRecord();
    record.capabilities[0].activation = { state: 'active' };

    expect(validateAdaptivePlanRecord(record)).toContain(
      'record.capabilities[0].activation must be omitted or exactly planned with one slice',
    );

    record.capabilities[0].activation = {
      state: 'planned',
      slice: 'slice-1-plan-adaptation',
      future: true,
    };
    expect(validateAdaptivePlanRecord(record)).toContain(
      'record.capabilities[0].activation must be omitted or exactly planned with one slice',
    );

    record.capabilities[0].activation = { state: 'planned', slice: ' ' };
    expect(validateAdaptivePlanRecord(record)).toContain(
      'record.capabilities[0].activation.slice must be a non-empty string for planned capabilities',
    );
  });

  it('rejects planned topology roots that overlap active or planned owners', () => {
    const record = createRecord();
    record.capabilities.push({
      owner: 'broad planned owner',
      root: 'scripts',
      entry: 'scripts/future-owner.mjs',
      testRoot: 'packages/tests/repo/future-owner',
      focusedCommand: 'npm run test:future-owner',
      navigationMap: null,
      factContracts: [],
      controlFlowFamilies: ['future behavior'],
      activation: { state: 'planned', slice: 'slice-1-plan-adaptation' },
    });

    expect(validateAdaptivePlanRecord(record)).toContain(
      'planned capability broad planned owner root scripts overlaps active capability plan adaptation root scripts/plan-adaptation',
    );

    record.capabilities.push({
      owner: 'nested planned owner',
      root: 'scripts/future-owner/internal',
      entry: 'scripts/future-owner/internal/entry.mjs',
      testRoot: 'packages/tests/repo/future-owner-internal',
      focusedCommand: 'npm run test:future-owner-internal',
      navigationMap: null,
      factContracts: [],
      controlFlowFamilies: ['future behavior'],
      activation: { state: 'planned', slice: 'slice-1-plan-adaptation' },
    });

    expect(validateAdaptivePlanRecord(record)).toContain(
      'planned capability broad planned owner root scripts overlaps planned capability nested planned owner root scripts/future-owner/internal',
    );
  });

  it('accepts planned code and guidance declarations with complete safe paths', () => {
    const record = createRecord();
    record.capabilities[0].activation = {
      state: 'planned',
      slice: 'slice-1-plan-adaptation',
    };
    record.capabilities.push({
      kind: 'guidance',
      owner: 'future guidance',
      skillRoot: '.agents/skills/future-guidance',
      skillEntry: '.agents/skills/future-guidance/SKILL.md',
      contractTestRoot: 'packages/tests/repo/future-guidance',
      focusedCommand: 'npm run test:future-guidance',
      evaluationRoot: '.agents/evaluations/future-guidance/v1',
      contractPaths: ['.codex-plugin/plugin.json'],
      activation: {
        state: 'planned',
        slice: 'slice-2-repository-structure',
      },
    });

    expect(validateAdaptivePlanRecord(record)).toEqual([]);
    expect(validateCheckpoint(record.checkpoint, record)).toEqual([]);
  });

  it('preserves omitted activation as the existing active capability behavior', () => {
    expect(validateAdaptivePlanRecord(createRecord())).toEqual([]);
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

  it('rejects a completed slice that is still presented in the next horizon', () => {
    const record = createRecord();
    record.completedSlicesSinceCheckpoint = ['slice-1-plan-adaptation'];

    expect(validateCheckpoint(record.checkpoint, record)).toContain(
      'checkpoint.nextSlices must not include completed slices: slice-1-plan-adaptation',
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
      checkpointDigest: computeCheckpointDigest(consolidation),
    });
    expect(validateCheckpoint(consolidation, record)).toEqual([]);
    record.completedSlicesSinceCheckpoint = ['different-slice'];
    expect(validateCheckpoint({ ...consolidation, nextSlices: [] }, record)).toContain(
      'consolidate must replace the next feature slice with one consolidation slice',
    );
    record.completedSlicesSinceCheckpoint = ['repair-owner'];
    expect(validateCheckpoint({ ...consolidation, nextSlices: [] }, record)).toEqual([]);
    expect(
      validateCheckpoint(
        { ...consolidation, nextSlices: ['second-autonomous-consolidation'] },
        record,
      ),
    ).toContain('only one autonomous consolidation slice is allowed');

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
